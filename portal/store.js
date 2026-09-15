/* =============================================================================
   Spherecho Portal — client for the portal API
   -----------------------------------------------------------------------------
   Same interface the UI has always called; the body now talks to the backend
   instead of localStorage. Accounts live in Cognito, records in DynamoDB and
   uploaded documents in a private S3 bucket. Nothing sensitive is kept in the
   browser beyond the access token, which sits in sessionStorage and dies with
   the tab.

   Two things deliberately no longer exist here:
     • creating an administrator — that is `backend/scripts/seed-admin.js`, run
       once against the deployed stack, so a public page can never mint one;
     • deciding whether a document passed — the server runs the verification and
       returns the verdict. The browser only renders it.
   ========================================================================== */
(function (global) {
    'use strict';

    var SPX = global.SPX = global.SPX || {};
    var config = SPX.config || {};
    var API = String(config.apiBase || '/api').replace(/\/+$/, '');
    var SESSION_KEY = 'spx.portal.session.v2';

    /* -------------------------------------------------------------------------
       Session. Only the token and the claims the UI needs to draw itself; every
       authorisation decision is made server-side from the token.
       ---------------------------------------------------------------------- */
    var session = null;

    /* Always hands back a copy. Callers render from this object, and one that
       shared the internal reference would let a stray assignment anywhere in
       the UI rewrite the signed-in identity. */
    function loadSession() {
        if (!session) {
            try {
                var raw = global.sessionStorage.getItem(SESSION_KEY);
                if (!raw) return null;
                var s = JSON.parse(raw);
                if (!s || !s.expiresAt || s.expiresAt < Date.now()) {
                    global.sessionStorage.removeItem(SESSION_KEY);
                    return null;
                }
                session = s;
            } catch (e) { return null; }
        }
        return Object.assign({}, session);
    }

    function saveSession(s) {
        session = s;
        try { global.sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
        return s;
    }

    function clearSession() {
        session = null;
        try { global.sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    }

    /* -------------------------------------------------------------------------
       Transport
       ---------------------------------------------------------------------- */
    function ApiError(message, status) {
        var e = new Error(message);
        e.status = status;
        return e;
    }

    async function request(method, path, options) {
        options = options || {};
        var headers = { 'content-type': 'application/json' };
        var current = loadSession();
        if (current && !options.anonymous) headers.authorization = 'Bearer ' + current.accessToken;

        var url = API + path;
        if (options.query) {
            var qs = Object.keys(options.query)
                .filter(function (k) { return options.query[k] != null && options.query[k] !== ''; })
                .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(options.query[k]); })
                .join('&');
            if (qs) url += '?' + qs;
        }

        var response;
        try {
            response = await fetch(url, {
                method: method,
                headers: headers,
                body: options.body === undefined ? undefined : JSON.stringify(options.body)
            });
        } catch (e) {
            throw ApiError('Could not reach the portal service. Check your connection and try again.', 0);
        }

        var payload = {};
        var text = await response.text();
        if (text) { try { payload = JSON.parse(text); } catch (e) { payload = {}; } }

        if (!response.ok) {
            /* An expired or revoked session should drop the caller back to the
               sign-in screen rather than showing a wall of 401s. */
            if (response.status === 401 || response.status === 403) {
                if (current && !options.anonymous) clearSession();
            }
            throw ApiError(payload.error || 'That request could not be completed.', response.status);
        }
        return payload;
    }

    /* -------------------------------------------------------------------------
       Auth
       ---------------------------------------------------------------------- */
    function sessionFromTokens(tokens, fallbackUsername) {
        var claims = {};
        try {
            claims = JSON.parse(atob(tokens.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        } catch (e) {}
        var groups = claims['cognito:groups'] || [];
        var role = ['admin', 'internal', 'partner'].filter(function (r) {
            return groups.indexOf(r) !== -1;
        })[0] || 'partner';

        return saveSession({
            accessToken: tokens.accessToken,
            username: claims['cognito:username'] || fallbackUsername,
            role: role,
            name: claims.name || '',
            email: claims.email || '',
            accountId: null,
            expiresAt: Date.now() + ((tokens.expiresIn || 3600) * 1000)
        });
    }

    /* The session is only usable once /auth/me has filled in accountId. */
    async function completeSession() {
        var me = await request('GET', '/auth/me');
        return saveSession(Object.assign({}, loadSession(), {
            accountId: me.accountId,
            role: me.role,
            name: me.name,
            email: me.email,
            username: me.username,
            mustChangePassword: !!me.mustChangePassword
        }));
    }

    async function login(username, password) {
        var result = await request('POST', '/auth/login', {
            anonymous: true, body: { username: username, password: password }
        });

        /* A freshly issued password never yields a token — the holder has to
           replace it first. The UI shows the "choose your own password" screen
           off the back of this. */
        if (result.challenge === 'NEW_PASSWORD_REQUIRED') {
            return { challenge: 'NEW_PASSWORD_REQUIRED', session: result.session, username: result.username };
        }
        sessionFromTokens(result, username);
        return completeSession();
    }

    async function respondToChallenge(username, challengeSession, newPassword) {
        var tokens = await request('POST', '/auth/challenge', {
            anonymous: true,
            body: { username: username, session: challengeSession, newPassword: newPassword }
        });
        sessionFromTokens(tokens, username);
        return completeSession();
    }

    async function changePassword(current, next) {
        await request('POST', '/auth/password', { body: { current: current, next: next } });
        var s = loadSession();
        if (s) saveSession(Object.assign({}, s, { mustChangePassword: false }));
        return true;
    }

    /* -------------------------------------------------------------------------
       Requests, accounts
       ---------------------------------------------------------------------- */
    async function createRequest(input) {
        if (!String(input.name || '').trim()) throw ApiError('Enter your full name.', 400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email || '').trim())) {
            throw ApiError('Enter a valid email address.', 400);
        }
        return request('POST', '/requests', { anonymous: true, body: input });
    }

    async function listRequests(status) {
        return (await request('GET', '/requests', { query: { status: status } })).requests;
    }

    async function approveRequest(requestId) {
        return request('POST', '/requests/' + encodeURIComponent(requestId) + '/approve');
    }

    async function rejectRequest(requestId, reason) {
        return request('POST', '/requests/' + encodeURIComponent(requestId) + '/reject', {
            body: { reason: reason }
        });
    }

    async function listAccounts() {
        return (await request('GET', '/accounts')).accounts;
    }

    async function reissueCredentials(accountId) {
        return request('POST', '/accounts/' + encodeURIComponent(accountId) + '/reissue');
    }

    async function setAccountStatus(accountId, status) {
        return request('POST', '/accounts/' + encodeURIComponent(accountId) + '/status', {
            body: { status: status }
        });
    }

    async function listAudit() {
        return (await request('GET', '/audit')).entries;
    }

    /* -------------------------------------------------------------------------
       Submissions
       ---------------------------------------------------------------------- */
    async function getSubmission(accountId) {
        var who = accountId || 'me';
        return (await request('GET', '/submissions/' + encodeURIComponent(who))).submission;
    }

    async function saveProfile(accountId, profile) {
        return (await request('PUT', '/submissions/' + encodeURIComponent(accountId || 'me') + '/profile', {
            body: { profile: profile }
        })).profile;
    }

    async function submitDossier(accountId) {
        return request('POST', '/submissions/' + encodeURIComponent(accountId || 'me') + '/submit');
    }

    async function setSubmissionStatus(accountId, status, note) {
        return request('POST', '/submissions/' + encodeURIComponent(accountId) + '/status', {
            body: { status: status, note: note }
        });
    }

    async function listSubmissions() {
        return (await request('GET', '/submissions')).submissions;
    }

    /* -------------------------------------------------------------------------
       Documents — presigned PUT straight to S3, then the server verifies.
       The bytes never pass through the API, so a 25 MB scan costs the Lambda
       nothing but the read it does to check the file.
       ---------------------------------------------------------------------- */
    async function uploadDocument(docId, file, onStage) {
        var stage = onStage || function () {};

        stage('Preparing upload');
        var presigned = await request('POST', '/documents/upload-url', {
            body: { docId: docId, name: file.name, size: file.size, contentType: file.type || 'application/octet-stream' }
        });

        stage('Uploading ' + file.name);
        var put;
        try {
            put = await fetch(presigned.uploadUrl, {
                method: 'PUT',
                headers: { 'content-type': file.type || 'application/octet-stream' },
                body: file
            });
        } catch (e) {
            throw ApiError('The upload was interrupted. Try again.', 0);
        }
        if (!put.ok) throw ApiError('The upload was rejected by storage (' + put.status + ').', put.status);

        stage('Verifying ' + file.name);
        var finalized = await request('POST', '/documents/' + encodeURIComponent(presigned.fileId) + '/finalize', {
            body: { docId: docId }
        });
        return finalized.document;
    }

    async function removeDocument(accountId, docId, fileId) {
        return request('DELETE', '/documents/' + encodeURIComponent(fileId), {
            query: { docId: docId }
        });
    }

    async function documentUrl(accountId, docId, fileId) {
        return (await request('GET', '/documents/' + encodeURIComponent(fileId) + '/url', {
            query: { docId: docId, accountId: accountId }
        })).url;
    }

    /* -------------------------------------------------------------------------
       Public surface — unchanged names, so portal.js did not have to move.
       ---------------------------------------------------------------------- */
    SPX.store = {
        /* auth */
        login: login,
        respondToChallenge: respondToChallenge,
        logout: clearSession,
        session: loadSession,
        refreshSession: completeSession,
        changePassword: changePassword,

        /* requests + accounts */
        createRequest: createRequest,
        listRequests: listRequests,
        approveRequest: approveRequest,
        rejectRequest: rejectRequest,
        listAccounts: listAccounts,
        reissueCredentials: reissueCredentials,
        setAccountStatus: setAccountStatus,
        listAudit: listAudit,

        /* submissions */
        getSubmission: getSubmission,
        saveProfile: saveProfile,
        submitDossier: submitDossier,
        setSubmissionStatus: setSubmissionStatus,
        listSubmissions: listSubmissions,

        /* documents */
        uploadDocument: uploadDocument,
        removeDocument: removeDocument,
        documentUrl: documentUrl,

        apiBase: API
    };
})(window);
