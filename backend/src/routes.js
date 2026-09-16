'use strict';

/* Every endpoint the portal talks to.
   -----------------------------------------------------------------------------
   Routes receive a normalised request plus `ctx` — the three ports and the
   signed-in session — and return a plain value that the router serialises. They
   never touch AWS SDKs directly, which is what lets the same code run against
   the in-memory ports locally and against DynamoDB/S3/Cognito in Lambda.

   Authorisation is decided here, on the server, from the token's group claim.
   The browser's role is a display detail; it is never trusted. */

const { bad, unauth, forbid, notFound, conflict, str, email } = require('./lib/http');
const { generatePassword, generateUsername, id, now, sortKey } = require('./lib/ids');
const checklist = require('./verification/checklist.js');
const verify = require('./verification/verify.js');

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXT = ['pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png', 'xlsx', 'csv'];

/* ---------------------------------------------------------------------------
   Keys. Every list operation is a Query against a known partition, so nothing
   in the hot path scans the table.
   ------------------------------------------------------------------------ */
const K = {
    requests: 'REQUESTS',
    accounts: 'ACCOUNTS',
    audit: 'AUDIT',
    submission: (accountId) => `SUB#${accountId}`,
    docSk: (docId, fileId) => `DOC#${docId}#${fileId}`,
    hash: (sha256) => `HASH#${sha256}`
};

/* ---------------------------------------------------------------------------
   Guards
   ------------------------------------------------------------------------ */
function requireSession(ctx) {
    if (!ctx.session) throw unauth();
    return ctx.session;
}

function requireRole(ctx, roles) {
    const s = requireSession(ctx);
    if (!roles.includes(s.role)) throw forbid();
    return s;
}

/* A partner may only ever address their own submission. Staff may address any. */
function resolveAccountId(ctx, requested) {
    const s = requireSession(ctx);
    if (requested === 'me' || !requested) return s.accountId;
    if (s.role === 'partner' && requested !== s.accountId) throw forbid();
    return requested;
}

async function audit(ctx, action, detail) {
    const ts = now();
    await ctx.db.put({
        PK: K.audit, SK: sortKey(ts),
        ts, action,
        actor: ctx.session ? ctx.session.username : 'anonymous',
        detail: String(detail || '').slice(0, 500)
    });
}

/* ---------------------------------------------------------------------------
   Submissions
   ------------------------------------------------------------------------ */
async function getSubmissionMeta(ctx, accountId) {
    let meta = await ctx.db.get(K.submission(accountId), 'META');
    if (!meta) {
        meta = {
            PK: K.submission(accountId), SK: 'META',
            accountId, profile: {}, status: 'draft', notes: [],
            createdAt: now(), updatedAt: now()
        };
        await ctx.db.put(meta);
    }
    return meta;
}

async function getSubmission(ctx, accountId) {
    const meta = await getSubmissionMeta(ctx, accountId);
    const rows = await ctx.db.query(K.submission(accountId), { prefix: 'DOC#' });
    const docs = {};
    for (const row of rows) {
        (docs[row.docId] = docs[row.docId] || []).push({
            fileId: row.fileId, name: row.name, size: row.size, mime: row.mime,
            sha256: row.sha256, uploadedAt: row.uploadedAt, verification: row.verification
        });
    }
    for (const list of Object.values(docs)) list.sort((a, b) => a.uploadedAt - b.uploadedAt);
    return {
        accountId, profile: meta.profile || {}, status: meta.status,
        notes: meta.notes || [], docs, createdAt: meta.createdAt, updatedAt: meta.updatedAt
    };
}

/* ---------------------------------------------------------------------------
   Account mirror. Cognito owns credentials; this row carries the business
   fields (org, phone, which request it came from) that Cognito should not.
   ------------------------------------------------------------------------ */
async function accountRow(ctx, accountId) {
    const rows = await ctx.db.query(K.accounts, {});
    return rows.find((r) => r.accountId === accountId) || null;
}

async function hydrateAccount(ctx, row) {
    const user = await ctx.identity.getUser(row.username);
    return {
        id: row.accountId,
        username: row.username,
        role: row.role,
        name: row.name,
        email: row.email,
        org: row.org || '',
        phone: row.phone || '',
        createdAt: row.createdAt,
        status: user && user.enabled ? 'active' : 'revoked',
        mustChangePassword: user ? user.mustChangePassword : false,
        lastLoginAt: user ? user.lastLoginAt : null
    };
}

/* ---------------------------------------------------------------------------
   Routes
   ------------------------------------------------------------------------ */
const routes = [

    /* ---- auth ---------------------------------------------------------- */
    {
        method: 'POST', path: '/auth/login', public: true,
        async handler(req, ctx) {
            const username = str(req.body.username, 'Username', { max: 64, required: true }).toLowerCase();
            const password = str(req.body.password, 'Password', { max: 256, required: true });
            const result = await ctx.identity.login(username, password);

            if (result.challenge === 'NEW_PASSWORD_REQUIRED') {
                return { challenge: result.challenge, session: result.session, username };
            }
            await ctx.db.put({
                PK: K.audit, SK: sortKey(now()), ts: now(), action: 'login', actor: username, detail: ''
            });
            return result;
        }
    },
    {
        method: 'POST', path: '/auth/challenge', public: true,
        async handler(req, ctx) {
            const username = str(req.body.username, 'Username', { max: 64, required: true }).toLowerCase();
            const session = str(req.body.session, 'Session', { max: 4096, required: true });
            const next = str(req.body.newPassword, 'New password', { max: 256, required: true });
            if (next.length < 12) throw bad('Choose a password of at least 12 characters.');
            return ctx.identity.respondToNewPassword(username, session, next);
        }
    },
    {
        method: 'GET', path: '/auth/me',
        async handler(req, ctx) {
            const s = requireSession(ctx);
            const user = await ctx.identity.getUser(s.username);
            return {
                accountId: s.accountId, username: s.username, role: s.role,
                name: s.name, email: s.email,
                mustChangePassword: user ? user.mustChangePassword : false
            };
        }
    },
    {
        method: 'POST', path: '/auth/password',
        async handler(req, ctx) {
            const s = requireSession(ctx);
            const current = str(req.body.current, 'Current password', { max: 256, required: true });
            const next = str(req.body.next, 'New password', { max: 256, required: true });
            if (next.length < 12) throw bad('Choose a password of at least 12 characters.');
            await ctx.identity.changePassword(s.username, current, next);
            await audit(ctx, 'password.changed', s.username);
            return { ok: true };
        }
    },

    /* ---- access requests ----------------------------------------------- */
    {
        method: 'POST', path: '/requests', public: true,
        async handler(req, ctx) {
            const type = req.body.type === 'internal' ? 'internal' : 'partner';
            const name = str(req.body.name, 'Full name', { max: 120, required: true });
            const mail = email(req.body.email);

            const existing = await ctx.db.query(K.requests, {});
            if (existing.some((r) => r.email === mail && r.status === 'pending')) {
                throw conflict('A request from this email is already awaiting review.');
            }

            const ts = now();
            const request = {
                PK: K.requests, SK: sortKey(ts),
                id: id('req'), name, email: mail,
                org: str(req.body.org, 'Company', { max: 160 }),
                phone: str(req.body.phone, 'Phone', { max: 40 }),
                note: str(req.body.note, 'Note', { max: 1000 }),
                type, status: 'pending', createdAt: ts
            };
            await ctx.db.put(request);
            await ctx.db.put({
                PK: K.audit, SK: sortKey(ts), ts,
                action: 'request.created', actor: mail, detail: `${mail} (${type})`
            });
            /* Deliberately returns nothing identifying — this endpoint is public. */
            return { ok: true };
        }
    },
    {
        method: 'GET', path: '/requests',
        async handler(req, ctx) {
            requireRole(ctx, ['admin', 'internal']);
            const rows = await ctx.db.query(K.requests, { desc: true });
            const status = req.query.status;
            return { requests: rows.filter((r) => !status || r.status === status).map(stripKeys) };
        }
    },
    {
        method: 'POST', path: '/requests/:id/approve',
        async handler(req, ctx) {
            const s = requireRole(ctx, ['admin']);
            const rows = await ctx.db.query(K.requests, {});
            const request = rows.find((r) => r.id === req.params.id);
            if (!request) throw notFound('Request not found.');
            if (request.status !== 'pending') throw conflict('This request has already been decided.');

            const taken = await ctx.identity.listUsernames();
            const username = generateUsername(request.type, request.org || request.name, taken);
            const password = generatePassword();
            const accountId = id('acc');

            await ctx.identity.createUser(username, {
                email: request.email, name: request.name, role: request.type, password
            });
            await ctx.db.put({
                PK: K.accounts, SK: username,
                accountId, username, role: request.type, name: request.name,
                email: request.email, org: request.org, phone: request.phone,
                createdAt: now(), fromRequest: request.id
            });
            await ctx.db.update(request.PK, request.SK, {
                status: 'approved', decidedAt: now(), decidedBy: s.username, accountId
            });
            await audit(ctx, 'request.approved', `${request.email} -> ${username}`);

            /* The only time the password is ever readable. It is not stored. */
            return { username, password, account: { id: accountId, name: request.name, role: request.type } };
        }
    },
    {
        method: 'POST', path: '/requests/:id/reject',
        async handler(req, ctx) {
            const s = requireRole(ctx, ['admin']);
            const rows = await ctx.db.query(K.requests, {});
            const request = rows.find((r) => r.id === req.params.id);
            if (!request) throw notFound('Request not found.');
            if (request.status !== 'pending') throw conflict('This request has already been decided.');

            await ctx.db.update(request.PK, request.SK, {
                status: 'rejected', reason: str(req.body.reason, 'Reason', { max: 500 }),
                decidedAt: now(), decidedBy: s.username
            });
            await audit(ctx, 'request.rejected', request.email);
            return { ok: true };
        }
    },

    /* ---- accounts ------------------------------------------------------ */
    {
        method: 'GET', path: '/accounts',
        async handler(req, ctx) {
            requireRole(ctx, ['admin', 'internal']);
            const rows = await ctx.db.query(K.accounts, {});
            const accounts = await Promise.all(rows.map((r) => hydrateAccount(ctx, r)));
            accounts.sort((a, b) => b.createdAt - a.createdAt);
            return { accounts };
        }
    },
    {
        method: 'POST', path: '/accounts/:id/reissue',
        async handler(req, ctx) {
            requireRole(ctx, ['admin']);
            const row = await accountRow(ctx, req.params.id);
            if (!row) throw notFound('Account not found.');
            if (row.role === 'admin') throw bad('Administrator passwords are changed from the account itself.');

            const password = generatePassword();
            await ctx.identity.setPassword(row.username, password);
            await audit(ctx, 'credentials.reissued', row.username);
            return { username: row.username, password };
        }
    },
    {
        method: 'POST', path: '/accounts/:id/status',
        async handler(req, ctx) {
            requireRole(ctx, ['admin']);
            const row = await accountRow(ctx, req.params.id);
            if (!row) throw notFound('Account not found.');
            if (row.role === 'admin') throw bad('The administrator account cannot be revoked from here.');

            const enabled = req.body.status === 'active';
            await ctx.identity.setEnabled(row.username, enabled);
            await audit(ctx, `account.${enabled ? 'active' : 'revoked'}`, row.username);
            return { ok: true, status: enabled ? 'active' : 'revoked' };
        }
    },

    /* ---- submissions --------------------------------------------------- */
    {
        method: 'GET', path: '/submissions',
        async handler(req, ctx) {
            requireRole(ctx, ['admin', 'internal']);
            const rows = await ctx.db.query(K.accounts, {});
            const partners = rows.filter((r) => r.role === 'partner');
            const out = [];
            for (const row of partners) {
                out.push({
                    accountId: row.accountId,
                    account: await hydrateAccount(ctx, row),
                    submission: await getSubmission(ctx, row.accountId)
                });
            }
            return { submissions: out };
        }
    },
    {
        method: 'GET', path: '/submissions/:accountId',
        async handler(req, ctx) {
            const accountId = resolveAccountId(ctx, req.params.accountId);
            if (ctx.session.role === 'partner' && accountId !== ctx.session.accountId) throw forbid();
            return { submission: await getSubmission(ctx, accountId) };
        }
    },
    {
        method: 'PUT', path: '/submissions/:accountId/profile',
        async handler(req, ctx) {
            const accountId = resolveAccountId(ctx, req.params.accountId);
            requireRole(ctx, ['partner', 'admin', 'internal']);

            /* Only fields the schema declares are persisted, so the client
               cannot smuggle extra attributes into the record. */
            const allowed = new Set();
            for (const group of checklist.profileFields) {
                for (const f of group.fields) allowed.add(f.id);
            }
            const incoming = req.body.profile || {};
            const profile = {};
            for (const key of Object.keys(incoming)) {
                if (!allowed.has(key)) continue;
                const v = incoming[key];
                profile[key] = typeof v === 'boolean' ? v : str(v, key, { max: 2000 });
            }

            await getSubmissionMeta(ctx, accountId);
            await ctx.db.update(K.submission(accountId), 'META', { profile, updatedAt: now() });
            await audit(ctx, 'profile.saved', accountId);
            return { profile };
        }
    },
    {
        method: 'POST', path: '/submissions/:accountId/submit',
        async handler(req, ctx) {
            const accountId = resolveAccountId(ctx, req.params.accountId);
            requireRole(ctx, ['partner']);

            const submission = await getSubmission(ctx, accountId);
            const profile = submission.profile || {};
            const missing = ['confirmOwnership', 'confirmEncumbrance', 'confirmDues', 'confirmLitigation', 'confirmAccuracy']
                .filter((k) => !profile[k]);
            if (missing.length) {
                throw bad('Tick every Seller confirmation on the Entity & film tab before submitting.');
            }

            const notes = (submission.notes || []).concat([{
                ts: now(), by: ctx.session.username, text: 'Submitted by the partner.', status: 'submitted'
            }]);
            await ctx.db.update(K.submission(accountId), 'META', { status: 'submitted', notes, updatedAt: now() });
            await audit(ctx, 'submission.submitted', accountId);
            return { status: 'submitted' };
        }
    },
    {
        method: 'POST', path: '/submissions/:accountId/status',
        async handler(req, ctx) {
            const s = requireRole(ctx, ['admin', 'internal']);
            const accountId = req.params.accountId;
            const status = str(req.body.status, 'Status', { max: 20, required: true });
            if (!['in-review', 'returned', 'accepted'].includes(status)) throw bad('Unknown status.');

            const submission = await getSubmission(ctx, accountId);
            const notes = (submission.notes || []).concat([{
                ts: now(), by: s.username, text: str(req.body.note, 'Note', { max: 2000 }), status
            }]);
            await ctx.db.update(K.submission(accountId), 'META', { status, notes, updatedAt: now() });
            await audit(ctx, `submission.${status}`, accountId);
            return { status };
        }
    },

    /* ---- documents ----------------------------------------------------- */
    {
        method: 'POST', path: '/documents/upload-url',
        async handler(req, ctx) {
            const s = requireRole(ctx, ['partner']);
            const docId = str(req.body.docId, 'Document', { max: 80, required: true });
            const cfg = checklist.get(docId);
            if (!cfg) throw bad('Unknown document requirement.');

            const name = str(req.body.name, 'File name', { max: 260, required: true });
            const size = Number(req.body.size) || 0;
            if (size <= 0) throw bad('That file is empty.');
            if (size > MAX_UPLOAD_BYTES) throw bad('Larger than the 25 MB limit. Split or compress it.');

            const ext = (name.split('.').pop() || '').toLowerCase();
            if (!ALLOWED_EXT.includes(ext)) throw bad(`Files of type .${ext} are not accepted.`);
            if (!cfg.accept.includes(ext === 'jpeg' ? 'jpg' : ext)) {
                throw bad(`This slot accepts ${cfg.accept.join(', ').toUpperCase()}.`);
            }

            const fileId = id('f');
            const key = `submissions/${s.accountId}/${docId}/${fileId}.${ext}`;
            const url = await ctx.files.presignPut(key, req.body.contentType || 'application/octet-stream');

            /* Parked until finalize confirms the bytes actually landed. */
            await ctx.db.put({
                PK: K.submission(s.accountId), SK: `PENDING#${fileId}`,
                fileId, docId, key, name, size, mime: req.body.contentType || '', createdAt: now()
            });
            return { fileId, uploadUrl: url, key };
        }
    },
    {
        method: 'POST', path: '/documents/:fileId/finalize',
        async handler(req, ctx) {
            const s = requireRole(ctx, ['partner']);
            const pending = await ctx.db.get(K.submission(s.accountId), `PENDING#${req.params.fileId}`);
            if (!pending) throw notFound('That upload was not started, or has already been finalised.');

            const bytes = await ctx.files.read(pending.key);
            if (!bytes || !bytes.length) throw bad('The upload did not arrive. Try again.');
            if (bytes.length > MAX_UPLOAD_BYTES) {
                await ctx.files.remove(pending.key);
                await ctx.db.remove(K.submission(s.accountId), `PENDING#${req.params.fileId}`);
                throw bad('Larger than the 25 MB limit.');
            }

            const submission = await getSubmission(ctx, s.accountId);
            const cfg = checklist.get(pending.docId);

            /* Duplicate detection reads the hash index rather than scanning. */
            const sha256 = await verify.sha256Hex(
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            );
            const priorHashes = await ctx.db.query(K.hash(sha256), {});
            const knownHashes = priorHashes.map((h) => ({
                sha256, docId: h.docId, name: h.name, accountId: h.accountId
            }));

            /* The authoritative verdict. The browser never decides this. */
            const verification = await verify.file(
                { name: pending.name, bytes },
                cfg,
                { profile: submission.profile || {}, knownHashes, accountId: s.accountId }
            );

            const record = {
                PK: K.submission(s.accountId), SK: K.docSk(pending.docId, pending.fileId),
                fileId: pending.fileId, docId: pending.docId, key: pending.key,
                name: pending.name, size: bytes.length, mime: pending.mime,
                sha256, uploadedAt: now(), verification
            };
            await ctx.db.put(record);
            await ctx.db.put({
                PK: K.hash(sha256), SK: `${s.accountId}#${pending.docId}#${pending.fileId}`,
                accountId: s.accountId, docId: pending.docId, name: pending.name, fileId: pending.fileId
            });
            await ctx.db.remove(K.submission(s.accountId), `PENDING#${req.params.fileId}`);
            await ctx.db.update(K.submission(s.accountId), 'META', { updatedAt: now() });
            await audit(ctx, 'document.uploaded', `${pending.docId} - ${pending.name}`);

            return {
                document: {
                    fileId: record.fileId, name: record.name, size: record.size,
                    mime: record.mime, sha256, uploadedAt: record.uploadedAt, verification
                }
            };
        }
    },
    {
        method: 'DELETE', path: '/documents/:fileId',
        async handler(req, ctx) {
            const s = requireRole(ctx, ['partner']);
            const docId = str(req.query.docId, 'Document', { max: 80, required: true });
            const sk = K.docSk(docId, req.params.fileId);
            const row = await ctx.db.get(K.submission(s.accountId), sk);
            if (!row) throw notFound('That file is not on this submission.');

            await ctx.files.remove(row.key);
            await ctx.db.remove(K.submission(s.accountId), sk);
            if (row.sha256) {
                await ctx.db.remove(K.hash(row.sha256), `${s.accountId}#${docId}#${req.params.fileId}`);
            }
            await ctx.db.update(K.submission(s.accountId), 'META', { updatedAt: now() });
            await audit(ctx, 'document.removed', docId);
            return { ok: true };
        }
    },
    {
        method: 'GET', path: '/documents/:fileId/url',
        async handler(req, ctx) {
            const s = requireSession(ctx);
            const accountId = resolveAccountId(ctx, req.query.accountId);
            const docId = str(req.query.docId, 'Document', { max: 80, required: true });
            if (s.role === 'partner' && accountId !== s.accountId) throw forbid();

            const row = await ctx.db.get(K.submission(accountId), K.docSk(docId, req.params.fileId));
            if (!row) throw notFound('That file is not on this submission.');
            return { url: await ctx.files.presignGet(row.key), name: row.name };
        }
    },

    /* ---- audit --------------------------------------------------------- */
    {
        method: 'GET', path: '/audit',
        async handler(req, ctx) {
            requireRole(ctx, ['admin']);
            const rows = await ctx.db.query(K.audit, { desc: true, limit: 200 });
            return { entries: rows.map(stripKeys) };
        }
    },

    /* ---- health -------------------------------------------------------- */
    {
        method: 'GET', path: '/health', public: true,
        async handler() {
            return { ok: true, documents: checklist.all().length, sections: checklist.sections.length };
        }
    }
];

function stripKeys(row) {
    const copy = Object.assign({}, row);
    delete copy.PK;
    delete copy.SK;
    return copy;
}

module.exports = { routes, K, getSubmission, MAX_UPLOAD_BYTES };
