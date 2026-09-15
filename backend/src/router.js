'use strict';

/* The one entry point. Given a normalised request and a set of ports, it
   authenticates, dispatches and serialises. The Lambda handler and the local
   dev server both reduce their own request shape to this. */

const { HttpError, json, corsHeaders, match, unauth } = require('./lib/http');
const { routes } = require('./routes');

/* Turn a verified token's claims into the session the routes use. The role is
   read from the token's group claim — never from anything the client sends. */
async function sessionFrom(claims, ctx) {
    const username = claims['cognito:username'] || claims.username;
    const groups = claims['cognito:groups'] || [];
    const role = ['admin', 'internal', 'partner'].find((r) => groups.includes(r));
    if (!role) throw unauth('This account has no access level assigned. Contact the administrator.');

    /* accountId lives on the mirror row, not in the token, so revoking or
       re-pointing an account does not require reissuing tokens. */
    const rows = await ctx.db.query('ACCOUNTS', {});
    const row = rows.find((r) => r.username === username);

    return {
        username,
        role,
        accountId: row ? row.accountId : `acc_${role}_${username}`,
        name: row ? row.name : (claims.name || username),
        email: row ? row.email : (claims.email || '')
    };
}

async function handle(req, ports, options = {}) {
    const allowedOrigins = options.allowedOrigins || ['*'];
    const cors = corsHeaders(req.headers.origin, allowedOrigins);

    if (req.method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

    let route = null;
    let params = null;
    let pathExists = false;

    for (const candidate of routes) {
        const m = match(candidate.path, req.path);
        if (!m) continue;
        pathExists = true;
        if (candidate.method === req.method) { route = candidate; params = m; break; }
    }

    if (!route) {
        return json(pathExists ? 405 : 404,
            { error: pathExists ? 'That method is not allowed here.' : 'Not found.' }, cors);
    }

    const ctx = Object.assign({ session: null }, ports);

    try {
        const auth = req.headers.authorization || '';
        if (auth.toLowerCase().startsWith('bearer ')) {
            const claims = await ports.identity.verifyToken(auth.slice(7).trim());
            ctx.session = await sessionFrom(claims, ctx);
        }
        if (!route.public && !ctx.session) throw unauth();

        const result = await route.handler(Object.assign({}, req, { params }), ctx);
        return json(200, result, cors);
    } catch (err) {
        if (err instanceof HttpError) {
            return json(err.status, { error: err.message, code: err.code }, cors);
        }
        /* Unexpected failures are logged in full but never echoed to the
           client — the message could carry internals. */
        console.error('[api] unhandled', req.method, req.path, err);
        return json(500, { error: 'Something went wrong handling that request.' }, cors);
    }
}

module.exports = { handle };
