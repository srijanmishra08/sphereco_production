'use strict';

/* Local dev server.
   -----------------------------------------------------------------------------
   Runs the exact same router and routes as the Lambda, against the in-memory
   ports, and additionally serves the presigned upload/download URLs those ports
   hand out. It also serves the static site, so the whole portal can be driven
   end to end on one machine with no AWS account.

       node backend/local/server.js [--port 8090] [--site .]

   The administrator is seeded here the same way `scripts/seed-admin.js` seeds it
   in a deployed stack: created directly against the identity port, never
   through a public screen. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { handle } = require('../src/router');
const { parseBody } = require('../src/lib/http');
const memory = require('../src/ports/memory');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
};

const PORT = Number(argOf('--port', 8090));
const SITE_ROOT = path.resolve(argOf('--site', path.join(__dirname, '..', '..')));
const BASE_URL = `http://localhost:${PORT}`;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'spherecho-admin-local';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@spherechoproductions.com';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Administrator';

const ports = {
    db: memory.createDb(),
    files: memory.createFiles({ baseUrl: BASE_URL }),
    identity: memory.createIdentity({ secret: crypto.randomBytes(32).toString('hex') })
};

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.md': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf'
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (c) => {
            total += c.length;
            if (total > 30 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function send(res, status, body, headers) {
    res.writeHead(status, Object.assign({ 'access-control-allow-origin': '*' }, headers || {}));
    res.end(body);
}

async function seedAdmin() {
    await ports.identity.createUser(ADMIN_USERNAME, {
        email: ADMIN_EMAIL, name: ADMIN_NAME, role: 'admin', password: ADMIN_PASSWORD
    });
    /* Seeded admins skip the forced change — the password was chosen, not issued. */
    await ports.identity.changePassword(ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_PASSWORD);
    await ports.db.put({
        PK: 'ACCOUNTS', SK: ADMIN_USERNAME,
        accountId: 'acc_admin', username: ADMIN_USERNAME, role: 'admin',
        name: ADMIN_NAME, email: ADMIN_EMAIL, org: 'Spherecho Productions', createdAt: Date.now()
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, BASE_URL);
    const pathname = decodeURIComponent(url.pathname);

    /* ---- presigned file traffic ---------------------------------------- */
    if (pathname.startsWith('/_files/')) {
        const grant = ports.files._consume(pathname.slice('/_files/'.length));
        if (!grant) return send(res, 403, 'This link has expired.');

        if (req.method === 'PUT' && grant.mode === 'put') {
            const body = await readBody(req);
            ports.files._write(grant.key, body);
            return send(res, 200, '');
        }
        if (req.method === 'GET' && grant.mode === 'get') {
            const bytes = await ports.files.read(grant.key);
            return send(res, 200, Buffer.from(bytes), { 'content-type': 'application/octet-stream' });
        }
        if (req.method === 'OPTIONS') {
            return send(res, 204, '', {
                'access-control-allow-methods': 'PUT,GET,OPTIONS',
                'access-control-allow-headers': 'content-type'
            });
        }
        return send(res, 405, 'Not allowed.');
    }

    /* ---- API ------------------------------------------------------------ */
    if (pathname === '/api' || pathname.startsWith('/api/')) {
        const raw = (req.method === 'GET' || req.method === 'OPTIONS') ? null : await readBody(req);
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;

        let body = {};
        try {
            body = raw && raw.length ? parseBody(raw.toString('utf8'), false) : {};
        } catch (err) {
            return send(res, 400, JSON.stringify({ error: err.message }),
                { 'content-type': 'application/json' });
        }

        const apiPath = pathname.replace(/^\/api/, '') || '/';
        const result = await handle({
            method: req.method,
            path: apiPath.replace(/\/+$/, '') || '/',
            query: Object.fromEntries(url.searchParams),
            headers,
            body
        }, ports, { allowedOrigins: ['*'] });

        return send(res, result.statusCode, result.body, result.headers);
    }

    /* ---- static site ---------------------------------------------------- */
    let rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(SITE_ROOT, rel);
    if (!file.startsWith(SITE_ROOT)) return send(res, 403, 'Forbidden');

    fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, 'Not found');
        send(res, 200, data, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    });
});

seedAdmin().then(() => {
    server.listen(PORT, () => {
        console.log(`portal   ${BASE_URL}/`);
        console.log(`api      ${BASE_URL}/api`);
        console.log(`admin    ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
        console.log(`site     ${SITE_ROOT}`);
    });
}).catch((err) => {
    console.error('failed to seed the administrator', err);
    process.exit(1);
});
