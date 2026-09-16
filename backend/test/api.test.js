'use strict';

/* Drives the router directly, with the in-memory ports — no HTTP, no browser.
   Covers the access model (who may do what) and the onboarding path end to end. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { handle } = require('../src/router');
const memory = require('../src/ports/memory');

const FIXTURES = process.env.FIXTURES || path.join(__dirname, 'fixtures');

let pass = 0;
const failures = [];

function ok(name, cond, extra) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { failures.push(name); console.log(`  FAIL  ${name}${extra ? `  ->  ${extra}` : ''}`); }
}

function makePorts() {
    return {
        db: memory.createDb(),
        files: memory.createFiles({ baseUrl: 'http://local' }),
        identity: memory.createIdentity({ secret: crypto.randomBytes(32).toString('hex') })
    };
}

async function call(ports, method, p, { token, body, query } = {}) {
    const res = await handle({
        method,
        path: p,
        query: query || {},
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: body || {}
    }, ports, { allowedOrigins: ['*'] });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}

(async () => {
    const ports = makePorts();

    /* ---- seeded administrator (as the deploy script does) --------------- */
    await ports.identity.createUser('admin', {
        email: 'admin@spherechoproductions.com', name: 'Srijan Mishra', role: 'admin', password: 'seeded-admin-pass-1'
    });
    await ports.identity.changePassword('admin', 'seeded-admin-pass-1', 'seeded-admin-pass-1');
    await ports.db.put({
        PK: 'ACCOUNTS', SK: 'admin', accountId: 'acc_admin', username: 'admin',
        role: 'admin', name: 'Srijan Mishra', email: 'admin@spherechoproductions.com', createdAt: Date.now()
    });

    console.log('\n-- no public bootstrap --');
    const boot = await call(ports, 'POST', '/auth/bootstrap', { body: { username: 'x' } });
    ok('there is no endpoint that creates an admin', boot.status === 404, String(boot.status));

    console.log('\n-- unauthenticated access --');
    ok('requests list needs a token', (await call(ports, 'GET', '/requests')).status === 401);
    ok('accounts list needs a token', (await call(ports, 'GET', '/accounts')).status === 401);
    ok('audit needs a token', (await call(ports, 'GET', '/audit')).status === 401);
    ok('health is public', (await call(ports, 'GET', '/health')).status === 200);

    console.log('\n-- admin sign-in --');
    const badLogin = await call(ports, 'POST', '/auth/login', { body: { username: 'admin', password: 'nope' } });
    ok('wrong password rejected', badLogin.status === 401, JSON.stringify(badLogin.body));
    const adminLogin = await call(ports, 'POST', '/auth/login', { body: { username: 'admin', password: 'seeded-admin-pass-1' } });
    ok('admin signs in', adminLogin.status === 200 && !!adminLogin.body.accessToken);
    const adminToken = adminLogin.body.accessToken;
    const me = await call(ports, 'GET', '/auth/me', { token: adminToken });
    ok('me reports the admin role', me.body.role === 'admin', JSON.stringify(me.body));

    console.log('\n-- access requests --');
    const reqPartner = await call(ports, 'POST', '/requests', {
        body: { name: 'Arun Kelkar', email: 'arun@meridianpictures.in', org: 'Meridian Pictures Private Limited', type: 'partner' }
    });
    ok('anyone may request access', reqPartner.status === 200);
    ok('the public request reveals nothing', !reqPartner.body.id && !reqPartner.body.email,
        JSON.stringify(reqPartner.body));
    await call(ports, 'POST', '/requests', {
        body: { name: 'Priya Nair', email: 'priya@spherechoproductions.com', org: 'Spherecho', type: 'internal' }
    });
    const dupe = await call(ports, 'POST', '/requests', {
        body: { name: 'Arun Kelkar', email: 'arun@meridianpictures.in', type: 'partner' }
    });
    ok('duplicate pending request refused', dupe.status === 409, String(dupe.status));
    const badEmail = await call(ports, 'POST', '/requests', { body: { name: 'X', email: 'not-an-email', type: 'partner' } });
    ok('invalid email refused', badEmail.status === 400);

    const listed = await call(ports, 'GET', '/requests', { token: adminToken, query: { status: 'pending' } });
    ok('admin sees both pending requests', listed.body.requests.length === 2, String(listed.body.requests.length));

    console.log('\n-- approval issues credentials --');
    const partnerReq = listed.body.requests.find((r) => r.type === 'partner');
    const internalReq = listed.body.requests.find((r) => r.type === 'internal');
    const approved = await call(ports, 'POST', `/requests/${partnerReq.id}/approve`, { token: adminToken });
    ok('approval returns a username and password', !!approved.body.username && !!approved.body.password);
    ok('partner username is prefixed', /^p\./.test(approved.body.username), approved.body.username);
    const partnerCreds = approved.body;

    const reApprove = await call(ports, 'POST', `/requests/${partnerReq.id}/approve`, { token: adminToken });
    ok('a request cannot be approved twice', reApprove.status === 409, String(reApprove.status));

    const internalCreds = (await call(ports, 'POST', `/requests/${internalReq.id}/approve`, { token: adminToken })).body;
    ok('internal username is prefixed', /^i\./.test(internalCreds.username), internalCreds.username);

    console.log('\n-- first sign-in forces a new password --');
    const challenge = await call(ports, 'POST', '/auth/login', {
        body: { username: partnerCreds.username, password: partnerCreds.password }
    });
    ok('issued password yields a challenge, not a token',
        challenge.body.challenge === 'NEW_PASSWORD_REQUIRED' && !challenge.body.accessToken,
        JSON.stringify(challenge.body));

    const shortPw = await call(ports, 'POST', '/auth/challenge', {
        body: { username: partnerCreds.username, session: challenge.body.session, newPassword: 'short' }
    });
    ok('short replacement password refused', shortPw.status === 400);

    const settled = await call(ports, 'POST', '/auth/challenge', {
        body: { username: partnerCreds.username, session: challenge.body.session, newPassword: 'long-monsoon-2025!' }
    });
    ok('challenge completes and returns a token', settled.status === 200 && !!settled.body.accessToken);
    const partnerToken = settled.body.accessToken;

    const reuseIssued = await call(ports, 'POST', '/auth/login', {
        body: { username: partnerCreds.username, password: partnerCreds.password }
    });
    ok('the issued password stops working', reuseIssued.status === 401, String(reuseIssued.status));

    console.log('\n-- partner is confined to their own submission --');
    ok('partner cannot list accounts', (await call(ports, 'GET', '/accounts', { token: partnerToken })).status === 403);
    ok('partner cannot list requests', (await call(ports, 'GET', '/requests', { token: partnerToken })).status === 403);
    ok('partner cannot read the audit log', (await call(ports, 'GET', '/audit', { token: partnerToken })).status === 403);
    ok('partner cannot approve', (await call(ports, 'POST', `/requests/${internalReq.id}/approve`, { token: partnerToken })).status === 403);
    ok('partner cannot read another submission',
        (await call(ports, 'GET', '/submissions/acc_admin', { token: partnerToken })).status === 403);

    console.log('\n-- profile --');
    const profile = {
        entityName: 'Meridian Pictures Private Limited', entityType: 'Private Limited Company',
        pan: 'AAPFU0939F', gstin: '27AAPFU0939F1ZV', signatoryName: 'Arun Kelkar',
        filmTitle: 'The Long Monsoon', filmLanguage: 'Hindi', filmYear: '2025',
        rightsOffered: 'Worldwide.', registeredAddress: 'BKC, Mumbai',
        signatoryDesignation: 'Director', signatoryEmail: 'arun@meridianpictures.in', signatoryPhone: '+91 98200 41122',
        confirmOwnership: true, confirmEncumbrance: true, confirmDues: true,
        confirmLitigation: true, confirmAccuracy: true,
        smuggled: 'should not persist'
    };
    const saved = await call(ports, 'PUT', '/submissions/me/profile', { token: partnerToken, body: { profile } });
    ok('profile saves', saved.status === 200);
    ok('unknown fields are dropped', saved.body.profile.smuggled === undefined);
    ok('declared fields persist', saved.body.profile.filmTitle === 'The Long Monsoon');

    console.log('\n-- upload, then server-side verification --');
    async function upload(docId, fixture) {
        const bytes = fs.readFileSync(path.join(FIXTURES, fixture));
        const presign = await call(ports, 'POST', '/documents/upload-url', {
            token: partnerToken,
            body: { docId, name: fixture, size: bytes.length, contentType: 'application/pdf' }
        });
        if (presign.status !== 200) return { presign };
        /* Write through the grant, exactly as the browser's PUT would. */
        const token = presign.body.uploadUrl.split('/_files/')[1];
        const grant = ports.files._consume(token);
        ports.files._write(grant.key, bytes);
        const finalize = await call(ports, 'POST', `/documents/${presign.body.fileId}/finalize`, {
            token: partnerToken, body: { docId }
        });
        return { presign, finalize };
    }

    const gst = await upload('seller.gst', 'gst-certificate.pdf');
    ok('valid GST certificate verifies server-side',
        gst.finalize.body.document && gst.finalize.body.document.verification.verdict === 'verified',
        JSON.stringify(gst.finalize.body).slice(0, 200));

    const resolution = await upload('seller.resolution', 'board-resolution.pdf');
    ok('board resolution verifies', resolution.finalize.body.document.verification.verdict === 'verified');

    const wrong = await upload('seller.incorporation', 'wrong-document.pdf');
    ok('unrelated document flagged for review', wrong.finalize.body.document.verification.verdict === 'review');

    const fake = await upload('title.story', 'not-really-a-pdf.pdf');
    ok('file that is not a PDF fails', fake.finalize.body.document.verification.verdict === 'failed');

    const dup = await upload('title.writers', 'board-resolution.pdf');
    const dupCheck = dup.finalize.body.document.verification.checks.find((c) => c.id === 'duplicate');
    ok('duplicate bytes detected across slots', dupCheck && dupCheck.status !== 'pass', JSON.stringify(dupCheck));

    const wrongSlot = await upload('cbfc.certificate', 'not-really-a-pdf.pdf');
    ok('server rejects a type the slot does not accept or flags it',
        wrongSlot.presign.status === 400 || wrongSlot.finalize.body.document.verification.verdict === 'failed');

    const tooBig = await call(ports, 'POST', '/documents/upload-url', {
        token: partnerToken, body: { docId: 'seller.pan', name: 'big.pdf', size: 40 * 1024 * 1024 }
    });
    ok('oversized upload refused before it starts', tooBig.status === 400, String(tooBig.status));

    const badExt = await call(ports, 'POST', '/documents/upload-url', {
        token: partnerToken, body: { docId: 'seller.pan', name: 'payload.exe', size: 1000 }
    });
    ok('disallowed extension refused', badExt.status === 400);

    const forgedFinalize = await call(ports, 'POST', '/documents/f_does_not_exist/finalize', {
        token: partnerToken, body: { docId: 'seller.pan' }
    });
    ok('finalize without a started upload refused', forgedFinalize.status === 404);

    console.log('\n-- a different partner filing the same bytes --');
    /* Approve a second partner, sign them in, and upload a file the first
       partner already filed. It must be flagged, but it is not their mistake
       and they must not learn anything about the other submission. */
    await call(ports, 'POST', '/requests', {
        body: { name: 'Neha Rao', email: 'neha@sunfilms.in', org: 'Sun Films LLP', type: 'partner' }
    });
    const pendingNow = (await call(ports, 'GET', '/requests', { token: adminToken, query: { status: 'pending' } })).body.requests;
    const secondCreds = (await call(ports, 'POST', `/requests/${pendingNow[0].id}/approve`, { token: adminToken })).body;
    const secondChallenge = await call(ports, 'POST', '/auth/login', {
        body: { username: secondCreds.username, password: secondCreds.password }
    });
    const secondToken = (await call(ports, 'POST', '/auth/challenge', {
        body: { username: secondCreds.username, session: secondChallenge.body.session, newPassword: 'sun-films-2026-xy' }
    })).body.accessToken;

    const sameBytes = fs.readFileSync(path.join(FIXTURES, 'gst-certificate.pdf'));
    const p2 = await call(ports, 'POST', '/documents/upload-url', {
        token: secondToken,
        body: { docId: 'seller.gst', name: 'gst-certificate.pdf', size: sameBytes.length, contentType: 'application/pdf' }
    });
    const grant2 = ports.files._consume(p2.body.uploadUrl.split('/_files/')[1]);
    ports.files._write(grant2.key, sameBytes);
    const f2 = await call(ports, 'POST', `/documents/${p2.body.fileId}/finalize`, {
        token: secondToken, body: { docId: 'seller.gst' }
    });
    const crossCheck = f2.body.document.verification.checks.find((c) => c.id === 'duplicate');
    ok('another partner filing the same bytes is flagged', crossCheck && crossCheck.status === 'warn',
        JSON.stringify(crossCheck));
    ok('...but it does not fail their upload', f2.body.document.verification.verdict !== 'failed',
        f2.body.document.verification.verdict);
    ok('...and it does not leak the other submission',
        crossCheck && !/gst-certificate|Meridian|GST registration/.test(crossCheck.detail),
        crossCheck && crossCheck.detail);

    /* The same partner re-filing into the same slot is still a hard stop. */
    const p3 = await call(ports, 'POST', '/documents/upload-url', {
        token: secondToken,
        body: { docId: 'seller.gst', name: 'gst-certificate.pdf', size: sameBytes.length, contentType: 'application/pdf' }
    });
    const grant3 = ports.files._consume(p3.body.uploadUrl.split('/_files/')[1]);
    ports.files._write(grant3.key, sameBytes);
    const f3 = await call(ports, 'POST', `/documents/${p3.body.fileId}/finalize`, {
        token: secondToken, body: { docId: 'seller.gst' }
    });
    ok('the same partner re-filing the same file into the same slot fails',
        f3.body.document.verification.verdict === 'failed', f3.body.document.verification.verdict);

    console.log('\n-- a decompression bomb does not take the service down --');
    /* A few hundred KB of compressed zeros that inflates to 600 MB. Unbounded,
       this exhausts the Lambda's memory; the engine reads inflate output against
       a budget and abandons the stream instead. */
    require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'make-bomb.js')]);
    const bombBytes = fs.readFileSync(path.join(FIXTURES, 'zip-bomb.pdf'));
    const pb = await call(ports, 'POST', '/documents/upload-url', {
        token: partnerToken,
        body: { docId: 'seller.corporate', name: 'zip-bomb.pdf', size: bombBytes.length, contentType: 'application/pdf' }
    });
    const bombGrant = ports.files._consume(pb.body.uploadUrl.split('/_files/')[1]);
    ports.files._write(bombGrant.key, bombBytes);
    const rssBefore = process.memoryUsage().rss;
    const bombResult = await call(ports, 'POST', `/documents/${pb.body.fileId}/finalize`, {
        token: partnerToken, body: { docId: 'seller.corporate' }
    });
    const grewMb = (process.memoryUsage().rss - rssBefore) / 1024 / 1024;
    ok('the bomb is handled, not fatal', bombResult.status === 200, String(bombResult.status));
    ok('...and memory stays bounded', grewMb < 250, `grew ${grewMb.toFixed(0)} MB`);
    ok('...landing in review rather than passing',
        bombResult.body.document.verification.verdict === 'review',
        bombResult.body.document.verification.verdict);

    console.log('\n-- submit and review --');
    const submitted = await call(ports, 'POST', '/submissions/me/submit', { token: partnerToken });
    ok('partner submits', submitted.body.status === 'submitted', JSON.stringify(submitted.body));

    const internalChallenge = await call(ports, 'POST', '/auth/login', {
        body: { username: internalCreds.username, password: internalCreds.password }
    });
    const internalToken = (await call(ports, 'POST', '/auth/challenge', {
        body: { username: internalCreds.username, session: internalChallenge.body.session, newPassword: 'spherecho-affairs-26' }
    })).body.accessToken;

    const queue = await call(ports, 'GET', '/submissions', { token: internalToken });
    ok('internal sees the partner submissions', queue.body.submissions.length === 2, String(queue.body.submissions.length));
    ok('internal sees the verification results',
        queue.body.submissions.some((r) => Object.keys(r.submission.docs).length >= 4));
    ok('internal cannot approve access requests',
        (await call(ports, 'POST', `/requests/${internalReq.id}/approve`, { token: internalToken })).status === 403);
    ok('internal cannot read the audit log',
        (await call(ports, 'GET', '/audit', { token: internalToken })).status === 403);

    const target = queue.body.submissions.find((r) => Object.keys(r.submission.docs).length >= 4);
    const decision = await call(ports, 'POST', `/submissions/${target.accountId}/status`, {
        token: internalToken, body: { status: 'returned', note: 'Chain of title still incomplete.' }
    });
    ok('internal records a decision', decision.body.status === 'returned');

    const badStatus = await call(ports, 'POST', `/submissions/${target.accountId}/status`, {
        token: internalToken, body: { status: 'obliterated' }
    });
    ok('unknown status refused', badStatus.status === 400);

    console.log('\n-- revocation --');
    const accounts = await call(ports, 'GET', '/accounts', { token: adminToken });
    const partnerAccount = accounts.body.accounts.find((a) => a.username === partnerCreds.username);
    ok('accounts carry live status', partnerAccount.status === 'active', JSON.stringify(partnerAccount));
    await call(ports, 'POST', `/accounts/${partnerAccount.id}/status`, { token: adminToken, body: { status: 'revoked' } });
    const afterRevoke = await call(ports, 'POST', '/auth/login', {
        body: { username: partnerCreds.username, password: 'long-monsoon-2025!' }
    });
    ok('revoked account cannot sign in', afterRevoke.status === 403, String(afterRevoke.status));
    ok('revoked token stops working',
        (await call(ports, 'GET', '/auth/me', { token: partnerToken })).status === 403);

    const adminSelfRevoke = await call(ports, 'POST', '/accounts/acc_admin/status', {
        token: adminToken, body: { status: 'revoked' } });
    ok('the administrator cannot be revoked through the API', adminSelfRevoke.status === 400);

    console.log('\n-- audit --');
    const auditLog = await call(ports, 'GET', '/audit', { token: adminToken });
    const actions = auditLog.body.entries.map((e) => e.action);
    ok('audit records approvals and uploads',
        actions.includes('request.approved') && actions.includes('document.uploaded'),
        actions.slice(0, 8).join(','));

    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) { failures.forEach((f) => console.log(` - ${f}`)); process.exit(1); }
})().catch((err) => { console.error(err); process.exit(2); });
