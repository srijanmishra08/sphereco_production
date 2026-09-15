#!/usr/bin/env node
'use strict';

/* Creates the one administrator, server-side.
   -----------------------------------------------------------------------------
   This exists so the portal never has to offer a "create the administrator"
   screen on a public page. Run it once, from a machine with AWS credentials,
   after the stack deploys:

       node scripts/seed-admin.js \
         --stack spherecho-portal \
         --username admin \
         --email you@spherechoproductions.com \
         --name "Srijan Mishra"

   It prints a one-time password. Sign in with it; Cognito will require you to
   replace it before it issues any token. Running it twice is refused. */

const {
    CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand,
    AdminGetUserCommand, ListUsersInGroupCommand
} = require('@aws-sdk/client-cognito-identity-provider');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');

const { generatePassword } = require('../src/lib/ids');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};

async function outputsOf(stackName) {
    const cfn = new CloudFormationClient({});
    const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const out = {};
    for (const o of (r.Stacks[0].Outputs || [])) out[o.OutputKey] = o.OutputValue;
    return out;
}

(async () => {
    const stack = arg('stack', process.env.STACK_NAME);
    const username = String(arg('username', 'admin')).toLowerCase();
    const email = arg('email');
    const name = arg('name', 'Administrator');

    if (!stack) throw new Error('Pass --stack <name> (or set STACK_NAME).');
    if (!email) throw new Error('Pass --email <address>.');

    const outputs = await outputsOf(stack);
    const userPoolId = arg('user-pool', outputs.UserPoolId);
    const tableName = arg('table', outputs.TableName);
    if (!userPoolId || !tableName) {
        throw new Error('Could not read UserPoolId/TableName from the stack outputs.');
    }

    const idp = new CognitoIdentityProviderClient({});
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

    /* Refuse to mint a second administrator — that is the whole point. */
    const existing = await idp.send(new ListUsersInGroupCommand({
        UserPoolId: userPoolId, GroupName: 'admin', Limit: 5
    }));
    if ((existing.Users || []).length) {
        const who = existing.Users.map((u) => u.Username).join(', ');
        console.error(`An administrator already exists (${who}).`);
        console.error('To reset its password use the Cognito console, or delete that user first.');
        process.exit(1);
    }

    const already = await idp.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }))
        .catch(() => null);
    if (already) throw new Error(`The username "${username}" is already taken in this pool.`);

    const password = generatePassword();

    await idp.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: username,
        TemporaryPassword: password,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
            { Name: 'name', Value: name }
        ]
    }));
    await idp.send(new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId, Username: username, GroupName: 'admin'
    }));

    await ddb.send(new PutCommand({
        TableName: tableName,
        Item: {
            PK: 'ACCOUNTS', SK: username,
            accountId: 'acc_admin', username, role: 'admin',
            name, email, org: 'Spherecho Productions', createdAt: Date.now()
        }
    }));

    console.log('\nAdministrator created.\n');
    console.log(`  username   ${username}`);
    console.log(`  password   ${password}\n`);
    console.log('Shown once. Cognito will require you to replace it on first sign-in.\n');
})().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
