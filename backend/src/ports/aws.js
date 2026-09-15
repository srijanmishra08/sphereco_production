'use strict';

/* The production adapters: DynamoDB, S3 and a Cognito user pool.
   -----------------------------------------------------------------------------
   These implement exactly the same three interfaces as ports/memory.js, so the
   routes are identical in both. Anything AWS-specific stops at this file.

   On Cognito: the portal's "approve, then hand over a one-time password"
   model is Cognito's own AdminCreateUser flow. A user created with a temporary
   password sits in FORCE_CHANGE_PASSWORD, and their first sign-in answers with
   a NEW_PASSWORD_REQUIRED challenge instead of tokens. We do not have to
   enforce the password change ourselves — the pool will not issue tokens until
   it happens. */

const {
    DynamoDBClient
} = require('@aws-sdk/client-dynamodb');
const {
    DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand
} = require('@aws-sdk/lib-dynamodb');
const {
    S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
    CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
    AdminAddUserToGroupCommand, AdminInitiateAuthCommand, AdminRespondToAuthChallengeCommand,
    AdminDisableUserCommand, AdminEnableUserCommand, AdminGetUserCommand, ListUsersCommand
} = require('@aws-sdk/client-cognito-identity-provider');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const { HttpError } = require('../lib/http');

const PRESIGN_TTL_SECONDS = 900;

function create(env = process.env) {
    const TABLE = env.TABLE_NAME;
    const BUCKET = env.BUCKET_NAME;
    const USER_POOL_ID = env.USER_POOL_ID;
    const CLIENT_ID = env.USER_POOL_CLIENT_ID;

    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true }
    });
    const s3 = new S3Client({});
    const idp = new CognitoIdentityProviderClient({});

    const verifier = CognitoJwtVerifier.create({
        userPoolId: USER_POOL_ID,
        tokenUse: 'access',
        clientId: CLIENT_ID
    });

    /* ---- db ------------------------------------------------------------- */
    const db = {
        async get(pk, sk) {
            const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
            return r.Item || null;
        },
        async put(item) {
            await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
            return item;
        },
        async update(pk, sk, patch) {
            const keys = Object.keys(patch);
            if (!keys.length) return db.get(pk, sk);

            /* Attribute names are aliased because several ("status", "name")
               are DynamoDB reserved words. */
            const names = {};
            const values = {};
            const sets = keys.map((k, i) => {
                names[`#k${i}`] = k;
                values[`:v${i}`] = patch[k];
                return `#k${i} = :v${i}`;
            });
            const r = await ddb.send(new UpdateCommand({
                TableName: TABLE,
                Key: { PK: pk, SK: sk },
                UpdateExpression: `SET ${sets.join(', ')}`,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
                ReturnValues: 'ALL_NEW'
            }));
            return r.Attributes;
        },
        async remove(pk, sk) {
            await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
        },
        async query(pk, { prefix = '', limit = 500, desc = false } = {}) {
            const out = [];
            let ExclusiveStartKey;
            do {
                const r = await ddb.send(new QueryCommand({
                    TableName: TABLE,
                    KeyConditionExpression: prefix
                        ? '#pk = :pk AND begins_with(#sk, :prefix)'
                        : '#pk = :pk',
                    ExpressionAttributeNames: prefix ? { '#pk': 'PK', '#sk': 'SK' } : { '#pk': 'PK' },
                    ExpressionAttributeValues: prefix ? { ':pk': pk, ':prefix': prefix } : { ':pk': pk },
                    ScanIndexForward: !desc,
                    Limit: Math.min(limit, 1000),
                    ExclusiveStartKey
                }));
                out.push(...(r.Items || []));
                ExclusiveStartKey = r.LastEvaluatedKey;
            } while (ExclusiveStartKey && out.length < limit);
            return out.slice(0, limit);
        }
    };

    /* ---- files ---------------------------------------------------------- */
    const files = {
        async presignPut(key, contentType) {
            return getSignedUrl(s3, new PutObjectCommand({
                Bucket: BUCKET, Key: key, ContentType: contentType,
                ServerSideEncryption: 'AES256'
            }), { expiresIn: PRESIGN_TTL_SECONDS });
        },
        async presignGet(key) {
            return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }),
                { expiresIn: PRESIGN_TTL_SECONDS });
        },
        async read(key) {
            try {
                const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
                return new Uint8Array(await r.Body.transformToByteArray());
            } catch (err) {
                if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
                    throw new HttpError(404, 'The upload did not arrive. Try again.');
                }
                throw err;
            }
        },
        async remove(key) {
            await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
        },
        async size(key) {
            try {
                const r = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
                return r.ContentLength || 0;
            } catch (err) {
                return 0;
            }
        }
    };

    /* ---- identity ------------------------------------------------------- */
    function translate(err) {
        const map = {
            NotAuthorizedException: [401, 'Incorrect username or password.'],
            UserNotFoundException: [401, 'Incorrect username or password.'],
            UserNotConfirmedException: [403, 'This account is not confirmed yet.'],
            TooManyRequestsException: [429, 'Too many attempts. Wait a moment and try again.'],
            TooManyFailedAttemptsException: [429, 'Too many failed attempts. Try again shortly.'],
            LimitExceededException: [429, 'Too many attempts. Wait a moment and try again.'],
            InvalidPasswordException: [400, 'That password does not meet the policy: at least 12 characters, with upper and lower case letters and a number.'],
            UsernameExistsException: [409, 'That username already exists.'],
            ExpiredCodeException: [400, 'That sign-in session has expired. Sign in again.'],
            CodeMismatchException: [400, 'That sign-in session is not valid. Sign in again.']
        };
        const hit = map[err.name];
        if (hit) return new HttpError(hit[0], hit[1]);
        return err;
    }

    function tokensFrom(result) {
        const a = result.AuthenticationResult;
        return {
            challenge: null,
            accessToken: a.AccessToken,
            idToken: a.IdToken,
            refreshToken: a.RefreshToken,
            expiresIn: a.ExpiresIn
        };
    }

    async function adminAuth(username, password) {
        return idp.send(new AdminInitiateAuthCommand({
            UserPoolId: USER_POOL_ID,
            ClientId: CLIENT_ID,
            AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
            AuthParameters: { USERNAME: username, PASSWORD: password }
        }));
    }

    const identity = {
        async createUser(username, { email, name, role, password }) {
            try {
                const r = await idp.send(new AdminCreateUserCommand({
                    UserPoolId: USER_POOL_ID,
                    Username: username,
                    TemporaryPassword: password,
                    /* We hand the credentials over ourselves; Cognito must not
                       email its own invitation with a different password. */
                    MessageAction: 'SUPPRESS',
                    UserAttributes: [
                        { Name: 'email', Value: email },
                        { Name: 'email_verified', Value: 'true' },
                        { Name: 'name', Value: name || username }
                    ]
                }));
                await idp.send(new AdminAddUserToGroupCommand({
                    UserPoolId: USER_POOL_ID, Username: username, GroupName: role
                }));
                const sub = (r.User.Attributes || []).find((a) => a.Name === 'sub');
                return { sub: sub ? sub.Value : null, username };
            } catch (err) { throw translate(err); }
        },

        async login(username, password) {
            try {
                const r = await adminAuth(username, password);
                if (r.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
                    return { challenge: 'NEW_PASSWORD_REQUIRED', session: r.Session, username };
                }
                if (!r.AuthenticationResult) {
                    throw new HttpError(400, `Unsupported sign-in challenge: ${r.ChallengeName}.`);
                }
                return tokensFrom(r);
            } catch (err) {
                /* A disabled user answers NotAuthorized; say the useful thing. */
                if (err.name === 'NotAuthorizedException') {
                    const user = await identity.getUser(username).catch(() => null);
                    if (user && !user.enabled) {
                        throw new HttpError(403, 'This account has been revoked. Contact the administrator.');
                    }
                }
                throw translate(err);
            }
        },

        async respondToNewPassword(username, session, newPassword) {
            try {
                const r = await idp.send(new AdminRespondToAuthChallengeCommand({
                    UserPoolId: USER_POOL_ID,
                    ClientId: CLIENT_ID,
                    ChallengeName: 'NEW_PASSWORD_REQUIRED',
                    Session: session,
                    ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword }
                }));
                if (!r.AuthenticationResult) throw new HttpError(400, 'Could not set that password. Sign in again.');
                return tokensFrom(r);
            } catch (err) { throw translate(err); }
        },

        /* Cognito's ChangePassword needs the user's access token, which this
           endpoint does not carry. Re-authenticating proves the current
           password just as well, and keeps the call admin-side. */
        async changePassword(username, current, next) {
            try {
                const r = await adminAuth(username, current);
                if (!r.AuthenticationResult && r.ChallengeName !== 'NEW_PASSWORD_REQUIRED') {
                    throw new HttpError(400, 'Your current password is not correct.');
                }
                await idp.send(new AdminSetUserPasswordCommand({
                    UserPoolId: USER_POOL_ID, Username: username, Password: next, Permanent: true
                }));
                return true;
            } catch (err) {
                if (err.name === 'NotAuthorizedException') {
                    throw new HttpError(400, 'Your current password is not correct.');
                }
                throw translate(err);
            }
        },

        /* Reissue: a temporary password puts the account back into
           FORCE_CHANGE_PASSWORD, so the new one must be replaced on use. */
        async setPassword(username, password) {
            try {
                await idp.send(new AdminSetUserPasswordCommand({
                    UserPoolId: USER_POOL_ID, Username: username, Password: password, Permanent: false
                }));
                await idp.send(new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
                return true;
            } catch (err) { throw translate(err); }
        },

        async setEnabled(username, enabled) {
            try {
                const Command = enabled ? AdminEnableUserCommand : AdminDisableUserCommand;
                await idp.send(new Command({ UserPoolId: USER_POOL_ID, Username: username }));
                return true;
            } catch (err) { throw translate(err); }
        },

        async verifyToken(token) {
            try {
                return await verifier.verify(token);
            } catch (err) {
                throw new HttpError(401, 'Your session has expired. Sign in again.');
            }
        },

        async listUsernames() {
            const out = [];
            let PaginationToken;
            do {
                const r = await idp.send(new ListUsersCommand({
                    UserPoolId: USER_POOL_ID, Limit: 60, PaginationToken
                }));
                out.push(...(r.Users || []).map((u) => u.Username));
                PaginationToken = r.PaginationToken;
            } while (PaginationToken);
            return out;
        },

        async getUser(username) {
            try {
                const r = await idp.send(new AdminGetUserCommand({
                    UserPoolId: USER_POOL_ID, Username: username
                }));
                const attr = (n) => (r.UserAttributes || []).find((a) => a.Name === n);
                return {
                    username: r.Username,
                    email: attr('email') ? attr('email').Value : '',
                    name: attr('name') ? attr('name').Value : '',
                    sub: attr('sub') ? attr('sub').Value : null,
                    enabled: r.Enabled !== false,
                    mustChangePassword: r.UserStatus === 'FORCE_CHANGE_PASSWORD',
                    createdAt: r.UserCreateDate ? new Date(r.UserCreateDate).getTime() : null,
                    lastLoginAt: null          /* Cognito does not expose this */
                };
            } catch (err) {
                if (err.name === 'UserNotFoundException') return null;
                throw translate(err);
            }
        }
    };

    return { db, files, identity };
}

module.exports = { create };
