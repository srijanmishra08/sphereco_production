'use strict';

/* In-memory implementations of the three ports, used by the local dev server
   and the test harness. They mirror the AWS adapter's semantics closely enough
   that a flow which works here works against DynamoDB/S3/Cognito — including
   the Cognito first-login challenge, which is the fiddly one.

   Nothing here runs in production; `ports/aws.js` is what the Lambda loads. */

const crypto = require('crypto');
const { HttpError } = require('../lib/http');

const SEP = '::';

function createDb() {
    const items = new Map();                       /* "pk::sk" -> item */
    const k = (pk, sk) => `${pk}${SEP}${sk}`;

    return {
        async get(pk, sk) {
            const v = items.get(k(pk, sk));
            return v ? JSON.parse(JSON.stringify(v)) : null;
        },
        async put(item) {
            items.set(k(item.PK, item.SK), JSON.parse(JSON.stringify(item)));
            return item;
        },
        async update(pk, sk, patch) {
            const cur = items.get(k(pk, sk));
            if (!cur) throw new HttpError(404, 'Not found.');
            const next = Object.assign({}, cur, patch);
            items.set(k(pk, sk), next);
            return JSON.parse(JSON.stringify(next));
        },
        async remove(pk, sk) { items.delete(k(pk, sk)); },
        async query(pk, { prefix = '', limit = 500, desc = false } = {}) {
            const out = [];
            for (const [key, v] of items) {
                const at = key.indexOf(SEP);
                const p = key.slice(0, at);
                const s = key.slice(at + SEP.length);
                if (p === pk && s.startsWith(prefix)) out.push(v);
            }
            out.sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0));
            if (desc) out.reverse();
            return out.slice(0, limit).map((v) => JSON.parse(JSON.stringify(v)));
        }
    };
}

function createFiles({ baseUrl }) {
    const blobs = new Map();                       /* key -> Buffer */
    const grants = new Map();                      /* token -> { key, mode, expires } */

    function grant(key, mode, contentType) {
        const token = crypto.randomBytes(18).toString('hex');
        grants.set(token, { key, mode, contentType, expires: Date.now() + 15 * 60 * 1000 });
        return `${baseUrl}/_files/${token}`;
    }

    return {
        async presignPut(key, contentType) { return grant(key, 'put', contentType); },
        async presignGet(key) {
            if (!blobs.has(key)) throw new HttpError(404, 'That file is no longer stored.');
            return grant(key, 'get');
        },
        async read(key) {
            const b = blobs.get(key);
            if (!b) throw new HttpError(404, 'That file is no longer stored.');
            return new Uint8Array(b);
        },
        async remove(key) { blobs.delete(key); },
        async size(key) { return blobs.has(key) ? blobs.get(key).length : 0; },

        /* Used only by the local server, to serve the presigned URLs above. */
        _consume(token) {
            const g = grants.get(token);
            if (!g || g.expires < Date.now()) return null;
            return g;
        },
        _write(key, buffer) { blobs.set(key, buffer); }
    };
}

/* A stand-in for a Cognito user pool. The shape that matters to the client is
   the FORCE_CHANGE_PASSWORD -> NEW_PASSWORD_REQUIRED challenge on first login. */
function createIdentity({ secret }) {
    const users = new Map();                       /* username -> record */
    const sessions = new Map();                    /* challenge session -> username */
    const attempts = new Map();

    const MAX_ATTEMPTS = 5;
    const LOCKOUT_MS = 5 * 60 * 1000;

    function hash(password, salt) {
        return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
    }

    function sign(payload, ttlSeconds) {
        const body = Object.assign({}, payload, {
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + ttlSeconds
        });
        const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const data = `${head}.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
        const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
        return `${data}.${sig}`;
    }

    function tokensFor(user) {
        const claims = {
            sub: user.sub,
            'cognito:username': user.username,
            'cognito:groups': [user.role],
            email: user.email,
            name: user.name
        };
        return {
            accessToken: sign(claims, 8 * 3600),
            idToken: sign(claims, 8 * 3600),
            expiresIn: 8 * 3600
        };
    }

    function requireUser(username) {
        const u = users.get(String(username || '').toLowerCase());
        if (!u) throw new HttpError(404, 'Account not found.');
        return u;
    }

    return {
        async createUser(username, { email, name, role, password }) {
            const key = username.toLowerCase();
            if (users.has(key)) throw new HttpError(409, 'That username already exists.');
            const salt = crypto.randomBytes(16).toString('hex');
            users.set(key, {
                sub: crypto.randomUUID(), username: key, email, name, role,
                salt, hash: hash(password, salt),
                mustChangePassword: true, enabled: true, createdAt: Date.now(), lastLoginAt: null
            });
            return { sub: users.get(key).sub, username: key };
        },

        async login(username, password) {
            const key = String(username || '').toLowerCase();
            const lock = attempts.get(key);
            if (lock && lock.lockedUntil > Date.now()) {
                const mins = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
                throw new HttpError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
            }

            const user = users.get(key);
            const okPassword = !!user && crypto.timingSafeEqual(
                Buffer.from(hash(password, user.salt), 'hex'),
                Buffer.from(user.hash, 'hex')
            );

            if (!user || !okPassword) {
                const a = attempts.get(key) || { count: 0, lockedUntil: 0 };
                a.count += 1;
                if (a.count >= MAX_ATTEMPTS) { a.lockedUntil = Date.now() + LOCKOUT_MS; a.count = 0; }
                attempts.set(key, a);
                throw new HttpError(401, 'Incorrect username or password.');
            }
            if (!user.enabled) throw new HttpError(403, 'This account has been revoked. Contact the administrator.');

            attempts.delete(key);

            if (user.mustChangePassword) {
                const session = crypto.randomBytes(24).toString('hex');
                sessions.set(session, key);
                return { challenge: 'NEW_PASSWORD_REQUIRED', session, username: key };
            }

            user.lastLoginAt = Date.now();
            return Object.assign({ challenge: null }, tokensFor(user));
        },

        async respondToNewPassword(username, session, newPassword) {
            const key = String(username || '').toLowerCase();
            if (sessions.get(session) !== key) throw new HttpError(400, 'That sign-in session has expired. Sign in again.');
            const user = requireUser(key);
            user.salt = crypto.randomBytes(16).toString('hex');
            user.hash = hash(newPassword, user.salt);
            user.mustChangePassword = false;
            user.lastLoginAt = Date.now();
            sessions.delete(session);
            return Object.assign({ challenge: null }, tokensFor(user));
        },

        async changePassword(username, current, next) {
            const user = requireUser(username);
            if (hash(current, user.salt) !== user.hash) throw new HttpError(400, 'Your current password is not correct.');
            user.salt = crypto.randomBytes(16).toString('hex');
            user.hash = hash(next, user.salt);
            user.mustChangePassword = false;
            return true;
        },

        async setPassword(username, password) {
            const user = requireUser(username);
            user.salt = crypto.randomBytes(16).toString('hex');
            user.hash = hash(password, user.salt);
            user.mustChangePassword = true;
            user.enabled = true;
            return true;
        },

        async setEnabled(username, enabled) {
            requireUser(username).enabled = !!enabled;
            return true;
        },

        async verifyToken(token) {
            const parts = String(token || '').split('.');
            if (parts.length !== 3) throw new HttpError(401, 'Not signed in.');
            const expected = crypto.createHmac('sha256', secret)
                .update(`${parts[0]}.${parts[1]}`).digest('base64url');
            if (parts[2].length !== expected.length ||
                !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) {
                throw new HttpError(401, 'Your session is not valid. Sign in again.');
            }
            const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            if (claims.exp * 1000 < Date.now()) throw new HttpError(401, 'Your session has expired. Sign in again.');

            const user = users.get(claims['cognito:username']);
            if (!user || !user.enabled) throw new HttpError(403, 'This account is no longer active.');
            return claims;
        },

        async listUsernames() { return Array.from(users.keys()); },

        async getUser(username) {
            const u = users.get(String(username || '').toLowerCase());
            if (!u) return null;
            return {
                username: u.username, email: u.email, name: u.name, role: u.role,
                enabled: u.enabled, mustChangePassword: u.mustChangePassword,
                createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, sub: u.sub
            };
        }
    };
}

module.exports = { createDb, createFiles, createIdentity };
