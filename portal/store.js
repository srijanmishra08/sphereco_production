/* =============================================================================
   Spherecho Portal — accounts, access requests and persistence
   -----------------------------------------------------------------------------
   IMPORTANT — this is a browser-local store. Accounts, sessions and uploads live
   in this browser (localStorage + IndexedDB), which means the portal works on the
   current static site with no backend, but it is NOT a security boundary: anyone
   who can open devtools can read the store. Passwords are PBKDF2-hashed rather
   than kept in the clear, and every mutation goes through this one module, so
   swapping localStorage for real API calls is a change to this file only —
   nothing in the UI layer touches storage directly.
   ========================================================================== */
(function (global) {
    'use strict';

    var SPX = global.SPX = global.SPX || {};

    var KEY = 'spx.portal.v1';
    var SESSION_KEY = 'spx.portal.session.v1';
    var SESSION_TTL_MS = 8 * 60 * 60 * 1000;   /* 8 hours */
    var PBKDF2_ITERATIONS = 210000;
    var MAX_ATTEMPTS = 5;
    var LOCKOUT_MS = 5 * 60 * 1000;

    var subtle = (global.crypto && global.crypto.subtle) || null;

    /* -------------------------------------------------------------------------
       Small helpers
       ---------------------------------------------------------------------- */
    function now() { return Date.now(); }

    function randomBytes(n) {
        var a = new Uint8Array(n);
        global.crypto.getRandomValues(a);
        return a;
    }

    function toHex(buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
            return ('0' + b.toString(16)).slice(-2);
        }).join('');
    }

    function id(prefix) {
        return prefix + '_' + toHex(randomBytes(8));
    }

    function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

    /* -------------------------------------------------------------------------
       Password hashing — PBKDF2-SHA256. Requires a secure context (https or
       localhost); without it we fail loudly rather than silently storing
       something weaker.
       ---------------------------------------------------------------------- */
    function assertCrypto() {
        if (!subtle) {
            throw new Error('This browser will not expose WebCrypto here. The portal needs https (or localhost).');
        }
    }

    async function hashPassword(password, saltHex, iterations) {
        assertCrypto();
        var salt = saltHex ? hexToBytes(saltHex) : randomBytes(16);
        var iter = iterations || PBKDF2_ITERATIONS;
        var keyMaterial = await subtle.importKey(
            'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
        );
        var bits = await subtle.deriveBits(
            { name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, keyMaterial, 256
        );
        return { salt: toHex(salt), hash: toHex(bits), iterations: iter, algo: 'PBKDF2-SHA256' };
    }

    function hexToBytes(hex) {
        var out = new Uint8Array(hex.length / 2);
        for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out;
    }

    /* Constant-time-ish comparison. */
    function sameHash(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        var diff = 0;
        for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
        return diff === 0;
    }

    async function sha256Hex(arrayBuffer) {
        assertCrypto();
        return toHex(await subtle.digest('SHA-256', arrayBuffer));
    }

    /* -------------------------------------------------------------------------
       Credential generation — what the admin hands over on approval.
       Ambiguous glyphs are left out so credentials survive being read aloud or
       retyped from a screenshot.
       ---------------------------------------------------------------------- */
    var PWD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    var USER_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

    function pick(alphabet, len) {
        var bytes = randomBytes(len);
        var out = '';
        for (var i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
        return out;
    }

    function generatePassword() {
        /* 16 chars from a 57-char alphabet ≈ 93 bits. Grouped for readability. */
        return pick(PWD_ALPHABET, 5) + '-' + pick(PWD_ALPHABET, 5) + '-' + pick(PWD_ALPHABET, 6);
    }

    function generateUsername(role, name, taken) {
        var base = (name || role).toLowerCase()
            .replace(/[^a-z0-9]+/g, '.')
            .replace(/^\.+|\.+$/g, '')
            .slice(0, 18)
            .replace(/\.+$/, '');          /* the slice can land mid-separator */
        if (!base) base = role;
        var prefix = role === 'partner' ? 'p' : 'i';
        var candidate = prefix + '.' + base;
        var n = 0;
        while (taken.indexOf(candidate) !== -1) {
            n += 1;
            candidate = prefix + '.' + base + '.' + pick(USER_ALPHABET, 3);
            if (n > 50) break;
        }
        return candidate;
    }

    /* -------------------------------------------------------------------------
       Blob storage (IndexedDB) — uploaded files are far too large for
       localStorage, so bytes go here and metadata goes in the JSON store.
       ---------------------------------------------------------------------- */
    var DB_NAME = 'spx-portal';
    var DB_STORE = 'files';
    var dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            var req = global.indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
        return dbPromise;
    }

    function idbRun(mode, fn) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(DB_STORE, mode);
                var req = fn(tx.objectStore(DB_STORE));
                tx.oncomplete = function () { resolve(req && req.result); };
                tx.onerror = function () { reject(tx.error); };
                tx.onabort = function () { reject(tx.error); };
            });
        });
    }

    var files = {
        put: function (fileId, blob) { return idbRun('readwrite', function (s) { return s.put(blob, fileId); }); },
        get: function (fileId) { return idbRun('readonly', function (s) { return s.get(fileId); }); },
        remove: function (fileId) { return idbRun('readwrite', function (s) { return s.delete(fileId); }); }
    };

    /* -------------------------------------------------------------------------
       The JSON store
       ---------------------------------------------------------------------- */
    function blank() {
        return { version: 1, accounts: [], requests: [], submissions: {}, audit: [], attempts: {} };
    }

    var state = null;

    function load() {
        if (state) return state;
        try {
            var raw = global.localStorage.getItem(KEY);
            state = raw ? JSON.parse(raw) : blank();
        } catch (e) {
            state = blank();
        }
        /* Tolerate a store written by an older shape. */
        ['accounts', 'requests', 'audit'].forEach(function (k) { if (!Array.isArray(state[k])) state[k] = []; });
        if (!state.submissions || typeof state.submissions !== 'object') state.submissions = {};
        if (!state.attempts || typeof state.attempts !== 'object') state.attempts = {};
        return state;
    }

    function save() {
        try {
            global.localStorage.setItem(KEY, JSON.stringify(state));
        } catch (e) {
            /* Quota is the realistic failure. Metadata is small; bytes live in
               IndexedDB, so this should not happen in normal use. */
            console.error('[portal] could not persist store', e);
            throw new Error('Storage is full — the submission could not be saved.');
        }
    }

    function audit(action, detail, actor) {
        load().audit.push({
            ts: now(),
            actor: actor || (currentSession() ? currentSession().username : 'anonymous'),
            action: action,
            detail: detail || ''
        });
        if (state.audit.length > 500) state.audit = state.audit.slice(-500);
    }

    function findAccount(username) {
        var u = String(username || '').trim().toLowerCase();
        return load().accounts.filter(function (a) { return a.username === u; })[0] || null;
    }

    function accountById(accountId) {
        return load().accounts.filter(function (a) { return a.id === accountId; })[0] || null;
    }

    /* -------------------------------------------------------------------------
       Sessions
       ---------------------------------------------------------------------- */
    function currentSession() {
        try {
            var raw = global.sessionStorage.getItem(SESSION_KEY);
            if (!raw) return null;
            var s = JSON.parse(raw);
            if (!s || !s.expiresAt || s.expiresAt < now()) { global.sessionStorage.removeItem(SESSION_KEY); return null; }
            var account = accountById(s.accountId);
            if (!account || account.status !== 'active') { global.sessionStorage.removeItem(SESSION_KEY); return null; }
            s.role = account.role;
            s.username = account.username;
            s.mustChangePassword = !!account.mustChangePassword;
            return s;
        } catch (e) { return null; }
    }

    function startSession(account) {
        var s = {
            accountId: account.id,
            username: account.username,
            role: account.role,
            name: account.name,
            issuedAt: now(),
            expiresAt: now() + SESSION_TTL_MS
        };
        global.sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
        return s;
    }

    function endSession() {
        var s = currentSession();
        if (s) audit('logout', '', s.username);
        global.sessionStorage.removeItem(SESSION_KEY);
        save();
    }

    /* -------------------------------------------------------------------------
       Login, with a lockout after repeated failures
       ---------------------------------------------------------------------- */
    function attemptState(username) {
        var a = load().attempts[username];
        if (!a) return { count: 0, lockedUntil: 0 };
        return a;
    }

    function noteFailure(username) {
        var a = attemptState(username);
        a.count = (a.count || 0) + 1;
        if (a.count >= MAX_ATTEMPTS) { a.lockedUntil = now() + LOCKOUT_MS; a.count = 0; }
        load().attempts[username] = a;
        save();
    }

    function clearFailures(username) {
        delete load().attempts[username];
        save();
    }

    async function login(username, password) {
        var u = String(username || '').trim().toLowerCase();
        var locked = attemptState(u);
        if (locked.lockedUntil && locked.lockedUntil > now()) {
            var mins = Math.ceil((locked.lockedUntil - now()) / 60000);
            throw new Error('Too many failed attempts. Try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.');
        }

        var account = findAccount(u);
        /* Hash regardless of whether the account exists, so a wrong username and
           a wrong password take the same time to answer. */
        var reference = account && account.pwd
            ? account.pwd
            : { salt: toHex(randomBytes(16)), hash: '', iterations: PBKDF2_ITERATIONS };
        var derived = await hashPassword(password, reference.salt, reference.iterations);

        if (!account || !sameHash(derived.hash, reference.hash)) {
            noteFailure(u);
            audit('login.failed', u, u);
            save();
            throw new Error('Incorrect username or password.');
        }
        if (account.status !== 'active') {
            throw new Error('This account has been revoked. Contact the administrator.');
        }

        clearFailures(u);
        account.lastLoginAt = now();
        audit('login', '', account.username);
        save();
        return startSession(account);
    }

    async function changePassword(accountId, currentPassword, newPassword) {
        var account = accountById(accountId);
        if (!account) throw new Error('Account not found.');
        if (String(newPassword || '').length < 12) throw new Error('Choose a password of at least 12 characters.');

        var derived = await hashPassword(currentPassword, account.pwd.salt, account.pwd.iterations);
        if (!sameHash(derived.hash, account.pwd.hash)) throw new Error('Your current password is not correct.');

        account.pwd = await hashPassword(newPassword);
        account.mustChangePassword = false;
        account.passwordChangedAt = now();
        audit('password.changed', account.username, account.username);
        save();
        return true;
    }

    /* -------------------------------------------------------------------------
       Admin bootstrap — the first and only account that can exist before an
       approval happens.
       ---------------------------------------------------------------------- */
    function hasAdmin() {
        return load().accounts.some(function (a) { return a.role === 'admin'; });
    }

    async function createAdmin(input) {
        if (hasAdmin()) throw new Error('An administrator already exists.');
        var username = String(input.username || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{4,32}$/.test(username)) {
            throw new Error('Usernames are 4–32 characters: letters, numbers, dot, dash or underscore.');
        }
        if (String(input.password || '').length < 12) throw new Error('Choose a password of at least 12 characters.');
        if (input.password !== input.confirm) throw new Error('The two passwords do not match.');

        var account = {
            id: id('acc'),
            username: username,
            role: 'admin',
            name: String(input.name || '').trim() || 'Administrator',
            email: String(input.email || '').trim(),
            org: 'Spherecho Productions',
            status: 'active',
            pwd: await hashPassword(input.password),
            mustChangePassword: false,
            createdAt: now()
        };
        load().accounts.push(account);
        audit('admin.created', username, username);
        save();
        return startSession(account);
    }

    /* -------------------------------------------------------------------------
       Access requests → approval → generated credentials
       ---------------------------------------------------------------------- */
    function createRequest(input) {
        var type = input.type === 'internal' ? 'internal' : 'partner';
        var email = String(input.email || '').trim();
        if (!String(input.name || '').trim()) throw new Error('Enter your full name.');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');

        var open = load().requests.some(function (r) {
            return r.email.toLowerCase() === email.toLowerCase() && r.status === 'pending';
        });
        if (open) throw new Error('A request from this email is already awaiting review.');

        var request = {
            id: id('req'),
            name: String(input.name).trim(),
            email: email,
            org: String(input.org || '').trim(),
            phone: String(input.phone || '').trim(),
            type: type,
            note: String(input.note || '').trim(),
            status: 'pending',
            createdAt: now()
        };
        load().requests.push(request);
        audit('request.created', request.email + ' (' + type + ')', request.email);
        save();
        return clone(request);
    }

    /* Approving mints a fresh username and password. The password is returned
       once, here, and never stored in a readable form — if it is lost the admin
       reissues rather than looks it up. */
    async function approveRequest(requestId) {
        requireAdmin();
        var request = load().requests.filter(function (r) { return r.id === requestId; })[0];
        if (!request) throw new Error('Request not found.');
        if (request.status !== 'pending') throw new Error('This request has already been decided.');

        var taken = load().accounts.map(function (a) { return a.username; });
        var username = generateUsername(request.type, request.org || request.name, taken);
        var password = generatePassword();

        var account = {
            id: id('acc'),
            username: username,
            role: request.type,           /* 'internal' | 'partner' */
            name: request.name,
            email: request.email,
            org: request.org,
            phone: request.phone,
            status: 'active',
            pwd: await hashPassword(password),
            mustChangePassword: true,
            createdAt: now(),
            createdFromRequest: request.id
        };
        load().accounts.push(account);

        request.status = 'approved';
        request.decidedAt = now();
        request.decidedBy = currentSession().username;
        request.accountId = account.id;

        audit('request.approved', request.email + ' → ' + username);
        save();
        return { username: username, password: password, account: clone(stripSecret(account)) };
    }

    function rejectRequest(requestId, reason) {
        requireAdmin();
        var request = load().requests.filter(function (r) { return r.id === requestId; })[0];
        if (!request) throw new Error('Request not found.');
        if (request.status !== 'pending') throw new Error('This request has already been decided.');
        request.status = 'rejected';
        request.reason = String(reason || '').trim();
        request.decidedAt = now();
        request.decidedBy = currentSession().username;
        audit('request.rejected', request.email);
        save();
        return clone(request);
    }

    /* Reissue: same account, brand-new password, shown once. */
    async function reissueCredentials(accountId) {
        requireAdmin();
        var account = accountById(accountId);
        if (!account) throw new Error('Account not found.');
        if (account.role === 'admin') throw new Error('Administrator passwords are changed from the account itself.');
        var password = generatePassword();
        account.pwd = await hashPassword(password);
        account.mustChangePassword = true;
        account.status = 'active';
        audit('credentials.reissued', account.username);
        save();
        return { username: account.username, password: password };
    }

    function setAccountStatus(accountId, status) {
        requireAdmin();
        var account = accountById(accountId);
        if (!account) throw new Error('Account not found.');
        if (account.role === 'admin') throw new Error('The administrator account cannot be revoked from here.');
        account.status = status === 'active' ? 'active' : 'revoked';
        audit('account.' + account.status, account.username);
        save();
        return clone(stripSecret(account));
    }

    function requireAdmin() {
        var s = currentSession();
        if (!s || s.role !== 'admin') throw new Error('Only the administrator can do that.');
        return s;
    }

    function requireRole(roles) {
        var s = currentSession();
        if (!s || roles.indexOf(s.role) === -1) throw new Error('You are not signed in with the right access for that.');
        return s;
    }

    function stripSecret(account) {
        var copy = clone(account);
        delete copy.pwd;
        return copy;
    }

    /* -------------------------------------------------------------------------
       Submissions — a partner's profile answers plus their uploaded documents.
       ---------------------------------------------------------------------- */
    function blankSubmission(accountId) {
        return {
            accountId: accountId,
            profile: {},
            docs: {},
            status: 'draft',        /* draft | submitted | in-review | accepted | returned */
            createdAt: now(),
            updatedAt: now(),
            notes: []
        };
    }

    function getSubmission(accountId) {
        var s = load().submissions[accountId];
        if (!s) { s = blankSubmission(accountId); load().submissions[accountId] = s; save(); }
        if (!s.docs) s.docs = {};
        if (!s.notes) s.notes = [];
        return s;
    }

    function saveProfile(accountId, profile) {
        requireRole(['partner', 'admin', 'internal']);
        var s = getSubmission(accountId);
        s.profile = clone(profile);
        s.updatedAt = now();
        audit('profile.saved', accountId);
        save();
        return clone(s.profile);
    }

    function addDocument(accountId, docId, record) {
        var s = getSubmission(accountId);
        if (!s.docs[docId]) s.docs[docId] = [];
        s.docs[docId].push(record);
        s.updatedAt = now();
        audit('document.uploaded', docId + ' · ' + record.name);
        save();
        return record;
    }

    async function removeDocument(accountId, docId, fileId) {
        var s = getSubmission(accountId);
        var list = s.docs[docId] || [];
        var keep = list.filter(function (r) { return r.fileId !== fileId; });
        s.docs[docId] = keep;
        s.updatedAt = now();
        audit('document.removed', docId);
        save();
        try { await files.remove(fileId); } catch (e) { /* blob already gone */ }
        return true;
    }

    function setSubmissionStatus(accountId, status, note) {
        var s = getSubmission(accountId);
        s.status = status;
        s.updatedAt = now();
        if (note) {
            s.notes.push({ ts: now(), by: (currentSession() || {}).username || 'system', text: note, status: status });
        }
        audit('submission.' + status, accountId);
        save();
        return clone(s);
    }

    /* Every uploaded file hash across all submissions — lets the verifier flag
       the same PDF being uploaded against two different requirements. */
    function knownHashes(exceptFileId) {
        var out = [];
        var all = load().submissions;
        Object.keys(all).forEach(function (accId) {
            var docs = all[accId].docs || {};
            Object.keys(docs).forEach(function (docId) {
                (docs[docId] || []).forEach(function (rec) {
                    if (rec.fileId !== exceptFileId && rec.sha256) {
                        out.push({ sha256: rec.sha256, docId: docId, name: rec.name, accountId: accId });
                    }
                });
            });
        });
        return out;
    }

    /* -------------------------------------------------------------------------
       Read models for the consoles
       ---------------------------------------------------------------------- */
    function listRequests(status) {
        requireRole(['admin', 'internal']);
        return clone(load().requests.filter(function (r) { return !status || r.status === status; })
            .sort(function (a, b) { return b.createdAt - a.createdAt; }));
    }

    function listAccounts() {
        requireRole(['admin', 'internal']);
        return load().accounts.map(stripSecret)
            .sort(function (a, b) { return b.createdAt - a.createdAt; });
    }

    function listSubmissions() {
        requireRole(['admin', 'internal']);
        var all = load().submissions;
        return Object.keys(all).map(function (accId) {
            var acc = accountById(accId);
            return {
                accountId: accId,
                account: acc ? stripSecret(acc) : null,
                submission: clone(all[accId])
            };
        }).filter(function (row) { return row.account && row.account.role === 'partner'; });
    }

    function listAudit(limit) {
        requireRole(['admin']);
        return clone(load().audit.slice(-(limit || 100)).reverse());
    }

    /* Wipe everything — used by the admin's "reset portal data" control and by
       the test harness. */
    async function reset() {
        try {
            var db = await openDb();
            db.close();
            dbPromise = null;
            await new Promise(function (resolve) {
                var req = global.indexedDB.deleteDatabase(DB_NAME);
                req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
            });
        } catch (e) { /* nothing stored yet */ }
        state = blank();
        global.localStorage.removeItem(KEY);
        global.sessionStorage.removeItem(SESSION_KEY);
    }

    SPX.store = {
        /* auth */
        hasAdmin: hasAdmin,
        createAdmin: createAdmin,
        login: login,
        logout: endSession,
        session: currentSession,
        changePassword: changePassword,
        requireAdmin: requireAdmin,
        requireRole: requireRole,
        accountById: function (i) { var a = accountById(i); return a ? stripSecret(a) : null; },

        /* requests + accounts */
        createRequest: createRequest,
        approveRequest: approveRequest,
        rejectRequest: rejectRequest,
        reissueCredentials: reissueCredentials,
        setAccountStatus: setAccountStatus,
        listRequests: listRequests,
        listAccounts: listAccounts,
        listAudit: listAudit,

        /* submissions */
        getSubmission: getSubmission,
        saveProfile: saveProfile,
        addDocument: addDocument,
        removeDocument: removeDocument,
        setSubmissionStatus: setSubmissionStatus,
        listSubmissions: listSubmissions,
        knownHashes: knownHashes,

        /* files + crypto utilities shared with the verifier */
        files: files,
        sha256Hex: sha256Hex,
        generatePassword: generatePassword,
        reset: reset
    };
})(window);
