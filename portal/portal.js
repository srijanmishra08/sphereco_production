/* =============================================================================
   Spherecho Portal — interface
   -----------------------------------------------------------------------------
   One overlay, four faces:

     • bootstrap  — first run: the administrator sets their own password
     • login      — everyone signs in here; new people request access
     • admin      — approve requests (which mints credentials), manage accounts
     • internal   — the Spherecho team reviewing what partners have filed
     • partner    — entity/film profile, then the document checklist with
                    automatic verification on every upload

   Views render as HTML strings and wire up through one delegated click handler,
   so a state change is always a re-render rather than a patch — with this much
   conditional structure that is the version that stays correct.
   ========================================================================== */
(function (global) {
    'use strict';

    var SPX = global.SPX = global.SPX || {};
    var store = SPX.store;
    var checklist = SPX.checklist;
    var verify = SPX.verify;

    var doc = global.document;
    var scrim, sheet, head, tabsEl, bodyEl, titleEl, eyebrowEl, whoamiEl, fileInput;
    var lastFocused = null;
    var scrollLock = '';
    var view = 'login';
    var activeTab = null;
    var flash = null;            /* one-shot message shown at the top of a view */
    var credential = null;       /* freshly minted credentials, shown once */
    var pendingDocId = null;
    var busyDocs = {};           /* docId → status text while verifying */
    var openSections = {};       /* section id → expanded, so a re-render does not collapse the page */

    /* -------------------------------------------------------------------------
       Helpers
       ---------------------------------------------------------------------- */
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function when(ts) {
        if (!ts) return '—';
        var d = new Date(ts);
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
               ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    function icon(name) {
        var paths = {
            lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
            close: '<path d="M5 5l14 14M19 5L5 19"/>',
            caret: '<path d="M6 9l6 6 6-6"/>',
            info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
            plus: '<path d="M12 5v14M5 12h14"/>',
            copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'
        };
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
               'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || '') + '</svg>';
    }

    function badge(text, tone) {
        return '<span class="spx-badge"' + (tone ? ' data-tone="' + tone + '"' : '') + '>' + esc(text) + '</span>';
    }

    var VERDICT = {
        verified: { tone: 'ok', label: 'Verified' },
        review:   { tone: 'warn', label: 'Needs review' },
        failed:   { tone: 'danger', label: 'Failed' }
    };

    function note(text, tone) {
        return '<div class="spx-note"' + (tone ? ' data-tone="' + tone + '"' : '') + '>' +
               icon('info') + '<div>' + text + '</div></div>';
    }

    function setFlash(text, state) { flash = text ? { text: text, state: state || 'ok' } : null; }

    function renderFlash() {
        if (!flash) return '';
        var tone = flash.state === 'error' ? 'danger' : (flash.state === 'warn' ? 'warn' : '');
        var html = note(esc(flash.text), tone);
        flash = null;
        return html;
    }

    function field(cfg) {
        var value = cfg.value == null ? '' : cfg.value;
        var wide = cfg.wide ? ' spx-field--wide' : '';
        var req = cfg.required ? ' <span class="spx-req">*</span>' : '';
        var input;

        if (cfg.type === 'textarea') {
            input = '<textarea id="' + cfg.id + '" name="' + cfg.id + '"' +
                (cfg.placeholder ? ' placeholder="' + esc(cfg.placeholder) + '"' : '') +
                (cfg.required ? ' required' : '') + '>' + esc(value) + '</textarea>';
        } else if (cfg.type === 'select') {
            input = '<select id="' + cfg.id + '" name="' + cfg.id + '"' + (cfg.required ? ' required' : '') + '>' +
                '<option value="">Select…</option>' +
                (cfg.options || []).map(function (o) {
                    return '<option value="' + esc(o) + '"' + (String(value) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
                }).join('') + '</select>';
        } else if (cfg.type === 'checkbox') {
            return '<div class="spx-field spx-field--wide"><div class="spx-check">' +
                '<input type="checkbox" id="' + cfg.id + '" name="' + cfg.id + '"' + (value ? ' checked' : '') + '>' +
                '<label for="' + cfg.id + '">' + esc(cfg.label) + (cfg.required ? ' <span class="spx-req">*</span>' : '') + '</label>' +
                '</div></div>';
        } else {
            input = '<input type="' + (cfg.type || 'text') + '" id="' + cfg.id + '" name="' + cfg.id + '"' +
                ' value="' + esc(value) + '"' +
                (cfg.placeholder ? ' placeholder="' + esc(cfg.placeholder) + '"' : '') +
                (cfg.autocomplete ? ' autocomplete="' + cfg.autocomplete + '"' : '') +
                (cfg.required ? ' required' : '') + '>';
        }

        return '<div class="spx-field' + wide + '">' +
            '<label for="' + cfg.id + '">' + esc(cfg.label) + req + '</label>' + input +
            (cfg.hint ? '<p class="spx-hint">' + esc(cfg.hint) + '</p>' : '') +
            '</div>';
    }

    function formValues(form) {
        var out = {};
        Array.prototype.forEach.call(form.elements, function (el) {
            if (!el.name) return;
            out[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
        });
        return out;
    }

    function setStatus(text, state) {
        var el = bodyEl.querySelector('.spx-status');
        if (!el) return;
        el.textContent = text || '';
        if (state) el.setAttribute('data-state', state); else el.removeAttribute('data-state');
    }

    /* -------------------------------------------------------------------------
       Screen: administrator bootstrap
       ---------------------------------------------------------------------- */
    function viewBootstrap() {
        return {
            eyebrow: 'First run',
            title: 'Set up the administrator',
            width: 'narrow',
            tabs: null,
            html: renderFlash() + note(
                'The administrator is the only account that can exist before anyone is approved. ' +
                'Every other login — internal team or partner — is created from here, by approving a request.'
            ) +
            '<form class="spx-form" data-form="bootstrap" novalidate>' +
                '<div class="spx-grid">' +
                    field({ id: 'name', label: 'Your name', required: true, autocomplete: 'name' }) +
                    field({ id: 'email', label: 'Work email', type: 'email', required: true, autocomplete: 'email' }) +
                    field({ id: 'username', label: 'Username', required: true, placeholder: 'admin', autocomplete: 'username', hint: '4–32 characters: letters, numbers, dot, dash or underscore.' }) +
                    field({ id: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters.' }) +
                    field({ id: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password', wide: true }) +
                '</div>' +
                '<div class="spx-actions">' +
                    '<button type="submit" class="spx-btn spx-btn--primary">Create administrator</button>' +
                '</div>' +
                '<p class="spx-status" role="status"></p>' +
            '</form>'
        };
    }

    /* -------------------------------------------------------------------------
       Screen: login
       ---------------------------------------------------------------------- */
    function viewLogin() {
        return {
            eyebrow: 'Spherecho',
            title: 'Internal & partner login',
            width: 'narrow',
            tabs: null,
            html: renderFlash() +
            '<form class="spx-form" data-form="login" novalidate>' +
                '<div class="spx-grid">' +
                    field({ id: 'username', label: 'Username', required: true, autocomplete: 'username', wide: true }) +
                    field({ id: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password', wide: true }) +
                '</div>' +
                '<div class="spx-actions">' +
                    '<button type="submit" class="spx-btn spx-btn--primary">Sign in</button>' +
                    '<span class="spx-spacer"></span>' +
                    '<button type="button" class="spx-link" data-action="go-request">Request access</button>' +
                '</div>' +
                '<p class="spx-status" role="status"></p>' +
            '</form>'
        };
    }

    /* -------------------------------------------------------------------------
       Screen: request access
       ---------------------------------------------------------------------- */
    function viewRequest() {
        return {
            eyebrow: 'Access',
            title: 'Request a login',
            width: 'narrow',
            tabs: null,
            html: renderFlash() + note(
                'Requests are reviewed by the Spherecho administrator. Once approved, a username and a ' +
                'one-time password are generated and sent to you — credentials are never self-serve.'
            ) +
            '<form class="spx-form" data-form="request" novalidate>' +
                '<div class="spx-grid">' +
                    field({ id: 'name', label: 'Full name', required: true, autocomplete: 'name' }) +
                    field({ id: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' }) +
                    field({ id: 'org', label: 'Company / organisation', autocomplete: 'organization' }) +
                    field({ id: 'phone', label: 'Phone', type: 'tel', autocomplete: 'tel' }) +
                    field({ id: 'type', label: 'Access needed', type: 'select', required: true, wide: true,
                            options: ['partner', 'internal'], value: 'partner' }) +
                    field({ id: 'note', label: 'What do you need access for?', type: 'textarea', wide: true,
                            placeholder: 'Film title, the deal in question, or your role at Spherecho.' }) +
                '</div>' +
                '<p class="spx-hint" style="margin-top:0.6rem">' +
                    '<strong>Partner</strong> — sellers, producers and their advisors submitting a film and its documents.<br>' +
                    '<strong>Internal</strong> — Spherecho staff reviewing what partners submit.' +
                '</p>' +
                '<div class="spx-actions">' +
                    '<button type="submit" class="spx-btn spx-btn--primary">Send request</button>' +
                    '<button type="button" class="spx-btn spx-btn--ghost" data-action="go-login">Back to sign in</button>' +
                '</div>' +
                '<p class="spx-status" role="status"></p>' +
            '</form>'
        };
    }

    /* -------------------------------------------------------------------------
       Screen: forced password change on first sign-in
       ---------------------------------------------------------------------- */
    function viewChangePassword() {
        var session = store.session();
        return {
            eyebrow: 'Security',
            title: 'Choose your own password',
            width: 'narrow',
            tabs: null,
            html: renderFlash() + note(
                'You signed in with the one-time password issued on approval. Replace it now — ' +
                'the issued password stops working as soon as you do.'
            ) +
            '<form class="spx-form" data-form="change-password" novalidate>' +
                '<input type="hidden" name="username" value="' + esc(session.username) + '" autocomplete="username">' +
                '<div class="spx-grid">' +
                    field({ id: 'current', label: 'Issued password', type: 'password', required: true, autocomplete: 'current-password', wide: true }) +
                    field({ id: 'next', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', wide: true, hint: 'At least 12 characters.' }) +
                    field({ id: 'confirm', label: 'Confirm new password', type: 'password', required: true, autocomplete: 'new-password', wide: true }) +
                '</div>' +
                '<div class="spx-actions">' +
                    '<button type="submit" class="spx-btn spx-btn--primary">Set password</button>' +
                    '<button type="button" class="spx-btn spx-btn--ghost" data-action="logout">Sign out</button>' +
                '</div>' +
                '<p class="spx-status" role="status"></p>' +
            '</form>'
        };
    }

    /* -------------------------------------------------------------------------
       Screen: administrator console
       ---------------------------------------------------------------------- */
    function credentialCard() {
        if (!credential) return '';
        return '<div class="spx-cred">' +
            '<h4>Credentials for ' + esc(credential.name || credential.username) + '</h4>' +
            '<p>Shown once. Nothing stores the password in a readable form — if it is lost, reissue rather than look it up. ' +
               'Send it over a channel the recipient already trusts, and separately from the username.</p>' +
            '<div class="spx-cred-rows">' +
                '<div class="spx-cred-row"><span>Username</span><code>' + esc(credential.username) + '</code>' +
                    '<button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="copy" data-copy="' + esc(credential.username) + '">Copy</button></div>' +
                '<div class="spx-cred-row"><span>Password</span><code>' + esc(credential.password) + '</code>' +
                    '<button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="copy" data-copy="' + esc(credential.password) + '">Copy</button></div>' +
            '</div>' +
            '<div class="spx-actions" style="margin-top:0.5rem">' +
                '<button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="copy" data-copy="' +
                    esc('Username: ' + credential.username + '\nPassword: ' + credential.password) + '">Copy both</button>' +
                '<button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="dismiss-credential">Done</button>' +
            '</div>' +
        '</div>';
    }

    function adminRequests() {
        var requests = store.listRequests();
        var pending = requests.filter(function (r) { return r.status === 'pending'; });
        var decided = requests.filter(function (r) { return r.status !== 'pending'; });

        var html = credentialCard();
        html += '<p class="spx-lede">Approving a request creates the account and generates its credentials on the spot. ' +
                'Nothing else can create a login.</p>';

        html += '<h3 class="spx-section-title">Awaiting review (' + pending.length + ')</h3>';
        html += pending.length ? '<div class="spx-card">' + pending.map(function (r) {
            return '<div class="spx-row">' +
                '<div class="spx-row-main">' +
                    '<div class="spx-row-title">' + esc(r.name) + badge(r.type, r.type === 'internal' ? 'accent' : 'muted') + '</div>' +
                    '<div class="spx-row-meta">' + esc(r.email) +
                        (r.org ? ' · ' + esc(r.org) : '') + (r.phone ? ' · ' + esc(r.phone) : '') +
                        '<br>' + when(r.createdAt) +
                        (r.note ? '<br><em>' + esc(r.note) + '</em>' : '') +
                    '</div>' +
                '</div>' +
                '<div class="spx-row-actions">' +
                    '<button type="button" class="spx-btn spx-btn--primary spx-btn--small" data-action="approve" data-id="' + r.id + '">Approve &amp; issue login</button>' +
                    '<button type="button" class="spx-btn spx-btn--danger spx-btn--small" data-action="reject" data-id="' + r.id + '">Decline</button>' +
                '</div>' +
            '</div>';
        }).join('') + '</div>' : '<div class="spx-empty">No requests waiting.</div>';

        if (decided.length) {
            html += '<h3 class="spx-section-title">Decided</h3><div class="spx-card">' + decided.map(function (r) {
                return '<div class="spx-row">' +
                    '<div class="spx-row-main">' +
                        '<div class="spx-row-title">' + esc(r.name) +
                            badge(r.status, r.status === 'approved' ? 'ok' : 'danger') + '</div>' +
                        '<div class="spx-row-meta">' + esc(r.email) + ' · ' + when(r.decidedAt) +
                            (r.decidedBy ? ' by ' + esc(r.decidedBy) : '') +
                            (r.reason ? '<br>Reason: ' + esc(r.reason) : '') + '</div>' +
                    '</div>' +
                '</div>';
            }).join('') + '</div>';
        }
        return html;
    }

    function adminAccounts() {
        var accounts = store.listAccounts();
        return '<p class="spx-lede">Every account here was created by approving a request, except the administrator.</p>' +
            '<div class="spx-card">' + accounts.map(function (a) {
                var tone = a.status === 'active' ? 'ok' : 'danger';
                return '<div class="spx-row">' +
                    '<div class="spx-row-main">' +
                        '<div class="spx-row-title">' + esc(a.name || a.username) +
                            badge(a.role, a.role === 'admin' ? 'accent' : 'muted') + badge(a.status, tone) +
                            (a.mustChangePassword ? badge('password not yet changed', 'warn') : '') + '</div>' +
                        '<div class="spx-row-meta"><code>' + esc(a.username) + '</code>' +
                            (a.email ? ' · ' + esc(a.email) : '') + (a.org ? ' · ' + esc(a.org) : '') +
                            '<br>Created ' + when(a.createdAt) +
                            ' · Last signed in ' + (a.lastLoginAt ? when(a.lastLoginAt) : 'never') + '</div>' +
                    '</div>' +
                    (a.role === 'admin' ? '' : '<div class="spx-row-actions">' +
                        '<button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="reissue" data-id="' + a.id + '">Reissue password</button>' +
                        (a.status === 'active'
                            ? '<button type="button" class="spx-btn spx-btn--danger spx-btn--small" data-action="revoke" data-id="' + a.id + '">Revoke</button>'
                            : '<button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="restore" data-id="' + a.id + '">Restore</button>') +
                    '</div>') +
                '</div>';
            }).join('') + '</div>';
    }

    function adminActivity() {
        var entries = store.listAudit(120);
        return '<p class="spx-lede">Approvals, sign-ins, uploads and status changes, newest first.</p>' +
            (entries.length ? '<div class="spx-card">' + entries.map(function (e) {
                return '<div class="spx-row"><div class="spx-row-main">' +
                    '<div class="spx-row-title" style="font-size:0.87rem">' + esc(e.action) + '</div>' +
                    '<div class="spx-row-meta">' + esc(e.actor) + ' · ' + when(e.ts) +
                        (e.detail ? ' · ' + esc(e.detail) : '') + '</div>' +
                '</div></div>';
            }).join('') + '</div>' : '<div class="spx-empty">Nothing recorded yet.</div>') +
            '<div class="spx-actions"><button type="button" class="spx-btn spx-btn--danger spx-btn--small" data-action="reset-portal">Erase all portal data</button></div>' +
            '<p class="spx-hint" style="margin-top:0.5rem">Removes every account, request, submission and uploaded file from this browser. There is no undo.</p>';
    }

    /* -------------------------------------------------------------------------
       Submission review — shared by the admin and internal team
       ---------------------------------------------------------------------- */
    function verdictCounts(submission) {
        var counts = { verified: 0, review: 0, failed: 0, total: 0 };
        Object.keys(submission.docs || {}).forEach(function (docId) {
            (submission.docs[docId] || []).forEach(function (rec) {
                counts.total++;
                var v = rec.verification && rec.verification.verdict;
                if (counts[v] != null) counts[v]++;
            });
        });
        return counts;
    }

    function completeness(submission) {
        var required = checklist.requiredDocs(submission.profile || {});
        var filled = required.filter(function (d) { return (submission.docs[d.id] || []).length > 0; });
        return { done: filled.length, total: required.length, pct: required.length ? Math.round(filled.length / required.length * 100) : 0 };
    }

    function reviewList() {
        var rows = store.listSubmissions();
        if (!rows.length) return '<div class="spx-empty">No partner has started a submission yet.</div>';

        return '<p class="spx-lede">Every partner submission, with the automatic verification results already applied. ' +
               'Anything marked <em>needs review</em> or <em>failed</em> is waiting on a person.</p>' +
            '<div class="spx-card">' + rows.map(function (row) {
                var s = row.submission;
                var counts = verdictCounts(s);
                var prog = completeness(s);
                var film = (s.profile && s.profile.filmTitle) || '—';
                return '<div class="spx-row">' +
                    '<div class="spx-row-main">' +
                        '<div class="spx-row-title">' + esc(film) +
                            badge(s.status, s.status === 'accepted' ? 'ok' : (s.status === 'submitted' ? 'accent' : 'muted')) + '</div>' +
                        '<div class="spx-row-meta">' + esc(row.account.org || row.account.name) +
                            ' · <code>' + esc(row.account.username) + '</code><br>' +
                            prog.done + ' of ' + prog.total + ' required documents filed · ' +
                            counts.verified + ' verified, ' + counts.review + ' need review, ' + counts.failed + ' failed<br>' +
                            'Updated ' + when(s.updatedAt) + '</div>' +
                    '</div>' +
                    '<div class="spx-row-actions">' +
                        '<button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="open-submission" data-id="' + esc(row.accountId) + '">Open</button>' +
                    '</div>' +
                '</div>';
            }).join('') + '</div>';
    }

    var openSubmissionId = null;

    function reviewDetail(accountId) {
        var account = store.accountById(accountId);
        var submission = store.getSubmission(accountId);
        var profile = submission.profile || {};

        var html = '<div class="spx-actions" style="margin-top:0"><button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="close-submission">← All submissions</button></div>';
        html += '<h3 class="spx-section-title">' + esc(profile.filmTitle || 'Untitled film') + '</h3>';
        html += '<div class="spx-card"><div class="spx-row-meta">' +
            '<strong>' + esc(account ? (account.org || account.name) : accountId) + '</strong><br>' +
            checklist.profileFields.reduce(function (acc, group) {
                return acc.concat(group.fields.filter(function (f) {
                    return f.type !== 'checkbox' && profile[f.id];
                }).map(function (f) {
                    return esc(f.label) + ': ' + esc(profile[f.id]);
                }));
            }, []).join('<br>') +
            '</div></div>';

        /* Disclosures and confirmations are the part a reviewer must actually read. */
        var ticked = checklist.profileFields
            .filter(function (g) { return g.group === 'Disclosures' || g.group === 'Seller confirmations'; })
            .reduce(function (acc, g) { return acc.concat(g.fields.filter(function (f) { return f.type === 'checkbox'; })); }, [])
            .map(function (f) {
                return '<div class="spx-check-row" data-status="' + (profile[f.id] ? 'pass' : 'skip') + '">' +
                    '<span class="spx-check-dot"></span><div class="spx-check-text"><span>' + esc(f.label) + '</span></div></div>';
            }).join('');
        html += '<h3 class="spx-section-title">Disclosures &amp; confirmations</h3><div class="spx-card"><div class="spx-checks" style="border:0;padding:0;background:none">' + ticked + '</div>' +
            (profile.disclosures ? '<div class="spx-excerpt" style="margin-top:0.7rem">' + esc(profile.disclosures) + '</div>' : '') + '</div>';

        html += '<h3 class="spx-section-title">Documents</h3>';
        html += checklist.sections.filter(function (section) {
            return checklist.sectionApplies(section, profile);
        }).map(function (section) {
            var filed = section.docs.filter(function (d) { return (submission.docs[d.id] || []).length; });
            if (!filed.length) return '';
            return '<details class="spx-doc-section" open><summary>' +
                '<span class="spx-doc-section-no">' + esc(section.no) + '</span>' +
                '<span class="spx-doc-section-titles"><h4>' + esc(section.title) + '</h4></span>' +
                '<span class="spx-caret">' + icon('caret') + '</span></summary>' +
                '<div class="spx-doc-section-body">' + filed.map(function (d) {
                    return '<div class="spx-doc"><div class="spx-doc-info"><div class="spx-doc-label">' +
                        '<span class="spx-doc-ref">' + esc(d.ref) + '</span>' + esc(d.label) + '</div></div>' +
                        renderFiles(d, submission.docs[d.id] || [], true) + '</div>';
                }).join('') + '</div></details>';
        }).join('') || '<div class="spx-empty">Nothing uploaded yet.</div>';

        html += '<h3 class="spx-section-title">Decision</h3>' +
            '<form class="spx-form" data-form="review-decision" data-account="' + esc(accountId) + '">' +
            field({ id: 'note', label: 'Note to the partner', type: 'textarea', wide: true, placeholder: 'What is missing, or what needs re-filing.' }) +
            '<div class="spx-actions">' +
                '<button type="button" class="spx-btn spx-btn--primary spx-btn--small" data-action="set-status" data-status="in-review" data-id="' + esc(accountId) + '">Mark in review</button>' +
                '<button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="set-status" data-status="returned" data-id="' + esc(accountId) + '">Return to partner</button>' +
                '<button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="set-status" data-status="accepted" data-id="' + esc(accountId) + '">Accept</button>' +
            '</div><p class="spx-status" role="status"></p></form>';

        if (submission.notes && submission.notes.length) {
            html += '<h3 class="spx-section-title">History</h3><div class="spx-card">' + submission.notes.slice().reverse().map(function (n) {
                return '<div class="spx-row"><div class="spx-row-main"><div class="spx-row-title" style="font-size:0.87rem">' +
                    esc(n.status) + '</div><div class="spx-row-meta">' + esc(n.by) + ' · ' + when(n.ts) + '<br>' + esc(n.text) + '</div></div></div>';
            }).join('') + '</div>';
        }
        return html;
    }

    /* -------------------------------------------------------------------------
       Partner: profile form
       ---------------------------------------------------------------------- */
    function partnerProfile() {
        var session = store.session();
        var submission = store.getSubmission(session.accountId);
        var profile = submission.profile || {};

        return renderFlash() +
            '<p class="spx-lede">Start here. The entity, signatory and film details below are cross-checked against the ' +
            'documents you upload — a PAN that disagrees with the PAN card, or a film title that never appears in the ' +
            'chain-of-title papers, is flagged automatically.</p>' +
            '<form class="spx-form" data-form="profile" novalidate>' +
            checklist.profileFields.map(function (group) {
                return '<h3 class="spx-section-title">' + esc(group.group) + '</h3><div class="spx-grid">' +
                    group.fields.map(function (f) {
                        var cfg = {};
                        Object.keys(f).forEach(function (k) { cfg[k] = f[k]; });
                        cfg.value = profile[f.id];
                        return field(cfg);
                    }).join('') + '</div>';
            }).join('') +
            '<div class="spx-actions"><button type="submit" class="spx-btn spx-btn--primary">Save details</button></div>' +
            '<p class="spx-status" role="status"></p>' +
            '</form>';
    }

    /* -------------------------------------------------------------------------
       Partner: documents
       ---------------------------------------------------------------------- */
    function renderChecks(rec) {
        var v = rec.verification;
        if (!v) return '';
        return '<div class="spx-checks" id="checks-' + esc(rec.fileId) + '" hidden>' +
            v.checks.map(function (c) {
                return '<div class="spx-check-row" data-status="' + esc(c.status) + '">' +
                    '<span class="spx-check-dot"></span>' +
                    '<div class="spx-check-text"><strong>' + esc(c.label) + '</strong><span>' + esc(c.detail) + '</span></div>' +
                '</div>';
            }).join('') +
            (v.excerpt ? '<div class="spx-excerpt">' + esc(v.excerpt) + '…</div>' : '') +
        '</div>';
    }

    function renderFiles(docCfg, records, readOnly) {
        if (!records.length) return '';
        return '<div class="spx-files">' + records.map(function (rec) {
            var v = rec.verification || {};
            var meta = VERDICT[v.verdict] || { tone: 'muted', label: 'Not checked' };
            return '<div class="spx-file" data-verdict="' + esc(v.verdict || '') + '">' +
                '<div class="spx-file-head">' +
                    '<span class="spx-file-name">' + esc(rec.name) + '</span>' +
                    '<span class="spx-file-meta">' + esc(verify.formatBytes(rec.size)) + ' · ' + when(rec.uploadedAt) + '</span>' +
                    badge(meta.label, meta.tone) +
                    '<button type="button" class="spx-file-toggle" data-action="toggle-checks" data-id="' + esc(rec.fileId) + '">Details</button>' +
                    (readOnly ? '' : '<button type="button" class="spx-btn spx-btn--danger spx-btn--small" data-action="remove-file" data-doc="' + esc(docCfg.id) + '" data-id="' + esc(rec.fileId) + '">Remove</button>') +
                '</div>' +
                renderChecks(rec) +
            '</div>';
        }).join('') + '</div>';
    }

    function partnerDocuments() {
        var session = store.session();
        var submission = store.getSubmission(session.accountId);
        var profile = submission.profile || {};
        var prog = completeness(submission);

        var html = renderFlash();

        if (!profile.entityName || !profile.filmTitle) {
            html += note('Fill in <strong>Entity &amp; film</strong> first. Without the entity name, PAN and film title, ' +
                         'uploads can still be checked for format and integrity, but not cross-checked against your details.', 'warn');
        }

        html += '<div class="spx-progress">' +
            '<div class="spx-progress-track"><div class="spx-progress-fill" style="width:' + prog.pct + '%"></div></div>' +
            '<div class="spx-progress-label">' + prog.done + ' / ' + prog.total + ' required</div></div>';

        html += '<p class="spx-lede">Every file is checked as it is uploaded: the real format is read from the bytes, ' +
                'a SHA-256 fingerprint catches the same document filed twice, and where the document has a text layer we ' +
                'read it for the wording, identifiers, signature block and dates the requirement expects. ' +
                'A scan with no text layer is marked <em>needs review</em> rather than passed.</p>';

        html += checklist.sections.filter(function (section) {
            return checklist.sectionApplies(section, profile);
        }).map(function (section) {
            var required = section.docs.filter(function (d) { return d.required; });
            var done = required.filter(function (d) { return (submission.docs[d.id] || []).length; });
            var uploaded = section.docs.reduce(function (n, d) { return n + (submission.docs[d.id] || []).length; }, 0);
            var complete = required.length && done.length === required.length;

            return '<details class="spx-doc-section" data-section="' + esc(section.id) + '"' +
                    (openSections[section.id] ? ' open' : '') + '>' +
                '<summary>' +
                    '<span class="spx-doc-section-no">' + esc(section.no) + '</span>' +
                    '<span class="spx-doc-section-titles"><h4>' + esc(section.title) + '</h4><p>' + esc(section.blurb) + '</p></span>' +
                    badge(done.length + '/' + required.length, complete ? 'ok' : (done.length ? 'warn' : 'muted')) +
                    '<span class="spx-caret">' + icon('caret') + '</span>' +
                '</summary>' +
                '<div class="spx-doc-section-body">' + section.docs.map(function (d) {
                    var records = submission.docs[d.id] || [];
                    var busy = busyDocs[d.id];
                    return '<div class="spx-doc">' +
                        '<div class="spx-doc-head">' +
                            '<div class="spx-doc-info">' +
                                '<div class="spx-doc-label"><span class="spx-doc-ref">' + esc(d.ref) + '</span>' + esc(d.label) +
                                    (d.required ? badge('required', records.length ? 'ok' : 'accent') : badge('if applicable', 'muted')) + '</div>' +
                                (d.hint ? '<p class="spx-doc-hint">' + esc(d.hint) + '</p>' : '') +
                            '</div>' +
                            '<div class="spx-row-actions">' +
                                (busy
                                    ? '<span class="spx-busy"><span class="spx-spinner"></span>' + esc(busy) + '</span>'
                                    : '<button type="button" class="spx-btn spx-btn--ghost spx-btn--small" data-action="upload" data-doc="' + esc(d.id) + '">' +
                                        icon('plus') + (records.length ? 'Add another' : 'Upload') + '</button>') +
                            '</div>' +
                        '</div>' +
                        renderFiles(d, records) +
                    '</div>';
                }).join('') + '</div></details>';
        }).join('');

        html += '<div class="spx-actions">' +
            '<button type="button" class="spx-btn spx-btn--primary" data-action="submit-dossier">Submit for review</button>' +
            '<span class="spx-spacer"></span>' +
            badge('Status: ' + submission.status, submission.status === 'accepted' ? 'ok' : 'muted') +
        '</div><p class="spx-status" role="status"></p>';

        return html;
    }

    /* -------------------------------------------------------------------------
       Partner: closing readiness
       ---------------------------------------------------------------------- */
    function partnerClosing() {
        var session = store.session();
        var submission = store.getSubmission(session.accountId);

        return '<p class="spx-lede">The documents that must be in hand before closing. Each line turns green once every ' +
               'document behind it has been filed and cleared automatic verification.</p>' +
            '<div class="spx-card">' + checklist.closing.map(function (item) {
                var docs = item.docs.map(function (id) { return checklist.get(id); }).filter(Boolean);
                var filed = docs.filter(function (d) { return (submission.docs[d.id] || []).length; });
                var clean = docs.filter(function (d) {
                    return (submission.docs[d.id] || []).some(function (r) {
                        return r.verification && r.verification.verdict === 'verified';
                    });
                });
                var satisfied = item.anyOf ? filed.length > 0 : filed.length === docs.length;
                var tone = satisfied && clean.length === docs.length ? 'ok' : (filed.length ? 'warn' : (item.optional ? 'muted' : 'danger'));
                var label = satisfied && clean.length === docs.length ? 'Ready'
                    : (filed.length ? filed.length + ' of ' + docs.length + ' filed' : (item.optional ? 'If applicable' : 'Outstanding'));

                var missing = docs.filter(function (d) { return !(submission.docs[d.id] || []).length; });
                return '<div class="spx-row"><div class="spx-row-main">' +
                    '<div class="spx-row-title">' + esc(item.label) + badge(label, tone) + '</div>' +
                    (missing.length ? '<div class="spx-row-meta">Still needed: ' +
                        missing.map(function (d) { return esc(d.ref + ' ' + d.label); }).join(', ') + '</div>' : '') +
                '</div></div>';
            }).join('') + '</div>';
    }

    /* -------------------------------------------------------------------------
       Screen assembly
       ---------------------------------------------------------------------- */
    function tabsFor(role) {
        if (role === 'admin') {
            var pending = 0;
            try { pending = store.listRequests('pending').length; } catch (e) {}
            return [
                { id: 'requests', label: 'Access requests', count: pending },
                { id: 'accounts', label: 'Accounts' },
                { id: 'submissions', label: 'Submissions' },
                { id: 'activity', label: 'Activity' }
            ];
        }
        if (role === 'internal') {
            return [
                { id: 'submissions', label: 'Partner submissions' },
                { id: 'accounts', label: 'Directory' }
            ];
        }
        return [
            { id: 'profile', label: 'Entity & film' },
            { id: 'documents', label: 'Documents' },
            { id: 'closing', label: 'Closing checklist' }
        ];
    }

    function viewConsole() {
        var session = store.session();
        var tabs = tabsFor(session.role);
        if (!activeTab || !tabs.some(function (t) { return t.id === activeTab; })) activeTab = tabs[0].id;

        var titles = {
            admin: 'Administrator console',
            internal: 'Internal team',
            partner: 'Partner portal'
        };

        var html;
        if (session.role === 'admin') {
            html = activeTab === 'requests' ? adminRequests()
                 : activeTab === 'accounts' ? adminAccounts()
                 : activeTab === 'activity' ? adminActivity()
                 : (openSubmissionId ? reviewDetail(openSubmissionId) : reviewList());
        } else if (session.role === 'internal') {
            html = activeTab === 'accounts' ? adminAccounts()
                 : (openSubmissionId ? reviewDetail(openSubmissionId) : reviewList());
        } else {
            html = activeTab === 'profile' ? partnerProfile()
                 : activeTab === 'closing' ? partnerClosing()
                 : partnerDocuments();
        }

        return {
            eyebrow: 'Spherecho',
            title: titles[session.role] || 'Portal',
            width: session.role === 'partner' || session.role === 'admin' || session.role === 'internal' ? 'wide' : 'narrow',
            tabs: tabs,
            html: (session.role === 'admin' && activeTab !== 'requests' ? credentialCard() : '') + html
        };
    }

    function currentView() {
        var session = store.session();
        if (view === 'request') return viewRequest();
        if (!session) {
            if (!store.hasAdmin()) return viewBootstrap();
            return viewLogin();
        }
        if (session.mustChangePassword) return viewChangePassword();
        return viewConsole();
    }

    function render() {
        /* Remember which document sections are expanded before the DOM is
           replaced — an upload re-renders the whole tab, and collapsing the
           section the partner is working in would be maddening. */
        Array.prototype.forEach.call(bodyEl.querySelectorAll('.spx-doc-section[data-section]'), function (el) {
            openSections[el.getAttribute('data-section')] = el.open;
        });

        var v = currentView();
        var session = store.session();

        eyebrowEl.textContent = v.eyebrow;
        titleEl.textContent = v.title;
        sheet.setAttribute('data-width', v.width === 'narrow' ? 'narrow' : 'wide');

        if (v.tabs) {
            tabsEl.hidden = false;
            tabsEl.innerHTML = v.tabs.map(function (t) {
                return '<button type="button" class="spx-tab" role="tab" data-action="tab" data-tab="' + t.id + '"' +
                    ' aria-selected="' + (t.id === activeTab) + '">' + esc(t.label) +
                    (t.count != null ? '<span class="spx-tab-count" data-zero="' + (t.count === 0) + '">' + t.count + '</span>' : '') +
                    '</button>';
            }).join('');
        } else {
            tabsEl.hidden = true;
            tabsEl.innerHTML = '';
        }

        if (session && !session.mustChangePassword) {
            whoamiEl.innerHTML = '<strong>' + esc(session.name || session.username) + '</strong>' + esc(session.username) + ' · ' + esc(session.role);
            whoamiEl.hidden = false;
            headSignOut.hidden = false;
        } else {
            whoamiEl.hidden = true;
            headSignOut.hidden = true;
        }

        bodyEl.innerHTML = v.html;
        bodyEl.scrollTop = 0;
    }

    /* -------------------------------------------------------------------------
       Upload handling
       ---------------------------------------------------------------------- */
    async function handleFiles(docId, fileList) {
        var session = store.session();
        if (!session || session.role !== 'partner') return;

        var cfg = checklist.get(docId);
        var submission = store.getSubmission(session.accountId);
        var files = Array.prototype.slice.call(fileList);
        if (!cfg || !files.length) return;
        if (!cfg.multiple) files = files.slice(0, 1);

        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            busyDocs[docId] = 'Verifying ' + file.name + '…';
            render();

            try {
                var result = await verify.file(file, cfg, {
                    profile: submission.profile || {},
                    knownHashes: store.knownHashes()
                });

                var fileId = 'f_' + (result.evidence.sha256 || Date.now().toString(16)).slice(0, 16) + '_' + Date.now().toString(36);
                await store.files.put(fileId, file);

                store.addDocument(session.accountId, docId, {
                    fileId: fileId,
                    name: file.name,
                    size: file.size,
                    mime: file.type,
                    sha256: result.evidence.sha256 || '',
                    uploadedAt: Date.now(),
                    verification: result
                });

                if (result.verdict === 'failed') {
                    setFlash(file.name + ' did not pass verification — open Details on the file to see why.', 'error');
                }
            } catch (err) {
                console.error('[portal] upload failed', err);
                setFlash('Could not process ' + file.name + ': ' + err.message, 'error');
            } finally {
                delete busyDocs[docId];
            }
        }
        render();
    }

    /* -------------------------------------------------------------------------
       Events
       ---------------------------------------------------------------------- */
    var ACTIONS = {
        'go-request': function () { view = 'request'; render(); },
        'go-login': function () { view = 'login'; render(); },

        'tab': function (el) {
            activeTab = el.getAttribute('data-tab');
            openSubmissionId = null;
            render();
        },

        'logout': function () {
            store.logout();
            view = 'login';
            activeTab = null;
            openSubmissionId = null;
            credential = null;
            render();
        },

        'copy': async function (el) {
            var text = el.getAttribute('data-copy');
            try {
                await navigator.clipboard.writeText(text);
                var original = el.textContent;
                el.textContent = 'Copied';
                setTimeout(function () { el.textContent = original; }, 1600);
            } catch (e) {
                setFlash('Copy is blocked in this browser — select the text manually.', 'warn');
                render();
            }
        },

        'dismiss-credential': function () { credential = null; render(); },

        'approve': async function (el) {
            try {
                var result = await store.approveRequest(el.getAttribute('data-id'));
                credential = { username: result.username, password: result.password, name: result.account.name };
                setFlash('Account created for ' + result.account.name + '. The credentials below are shown once.', 'ok');
            } catch (e) { setFlash(e.message, 'error'); }
            render();
        },

        'reject': function (el) {
            var reason = global.prompt('Reason for declining (optional, shared with nobody automatically):', '');
            if (reason === null) return;
            try { store.rejectRequest(el.getAttribute('data-id'), reason); setFlash('Request declined.', 'ok'); }
            catch (e) { setFlash(e.message, 'error'); }
            render();
        },

        'reissue': async function (el) {
            if (!global.confirm('Issue a new password? The current one stops working immediately.')) return;
            try {
                var result = await store.reissueCredentials(el.getAttribute('data-id'));
                credential = { username: result.username, password: result.password, name: result.username };
                setFlash('New password issued. Shown once.', 'ok');
            } catch (e) { setFlash(e.message, 'error'); }
            render();
        },

        'revoke': function (el) {
            if (!global.confirm('Revoke this account? They will not be able to sign in.')) return;
            try { store.setAccountStatus(el.getAttribute('data-id'), 'revoked'); } catch (e) { setFlash(e.message, 'error'); }
            render();
        },

        'restore': function (el) {
            try { store.setAccountStatus(el.getAttribute('data-id'), 'active'); } catch (e) { setFlash(e.message, 'error'); }
            render();
        },

        'reset-portal': async function () {
            if (!global.confirm('Erase every account, request and uploaded document from this browser? There is no undo.')) return;
            if (!global.confirm('Really erase everything?')) return;
            await store.reset();
            view = 'login';
            activeTab = null;
            credential = null;
            render();
        },

        'open-submission': function (el) { openSubmissionId = el.getAttribute('data-id'); render(); },
        'close-submission': function () { openSubmissionId = null; render(); },

        'set-status': function (el) {
            var form = bodyEl.querySelector('[data-form="review-decision"]');
            var noteText = form ? form.elements.note.value.trim() : '';
            try {
                store.setSubmissionStatus(el.getAttribute('data-id'), el.getAttribute('data-status'), noteText);
                setFlash('Submission marked ' + el.getAttribute('data-status') + '.', 'ok');
            } catch (e) { setFlash(e.message, 'error'); }
            render();
        },

        'upload': function (el) {
            pendingDocId = el.getAttribute('data-doc');
            var cfg = checklist.get(pendingDocId);
            fileInput.accept = (cfg.accept || []).map(function (e2) { return '.' + e2; }).join(',');
            fileInput.multiple = !!cfg.multiple;
            fileInput.value = '';
            fileInput.click();
        },

        'toggle-checks': function (el) {
            var panel = doc.getElementById('checks-' + el.getAttribute('data-id'));
            if (panel) {
                panel.hidden = !panel.hidden;
                el.textContent = panel.hidden ? 'Details' : 'Hide';
            }
        },

        'remove-file': async function (el) {
            if (!global.confirm('Remove this file from the submission?')) return;
            var session = store.session();
            try { await store.removeDocument(session.accountId, el.getAttribute('data-doc'), el.getAttribute('data-id')); }
            catch (e) { setFlash(e.message, 'error'); }
            render();
        },

        'submit-dossier': function () {
            var session = store.session();
            var submission = store.getSubmission(session.accountId);
            var profile = submission.profile || {};
            var prog = completeness(submission);

            var missingConfirmations = ['confirmOwnership', 'confirmEncumbrance', 'confirmDues', 'confirmLitigation', 'confirmAccuracy']
                .filter(function (k) { return !profile[k]; });

            if (missingConfirmations.length) {
                setStatus('Tick every Seller confirmation on the Entity & film tab before submitting.', 'error');
                return;
            }
            if (prog.done < prog.total) {
                if (!global.confirm(prog.total - prog.done + ' required document(s) are still missing. Submit anyway?')) return;
            }
            store.setSubmissionStatus(session.accountId, 'submitted', 'Submitted by the partner.');
            setFlash('Submitted for review. You can keep uploading — we will see the updates.', 'ok');
            render();
        }
    };

    async function onClick(e) {
        /* The listener is bound to the scrim, so anything this finds is already
           inside the portal — head, tab strip or body alike. */
        var el = e.target.closest('[data-action]');
        if (!el) return;
        var action = el.getAttribute('data-action');
        if (!ACTIONS[action]) return;
        e.preventDefault();
        await ACTIONS[action](el);
    }

    var FORMS = {
        'bootstrap': async function (values) {
            await store.createAdmin(values);
            setFlash('Administrator created. You are signed in.', 'ok');
            view = 'console';
            render();
        },

        'login': async function (values) {
            await store.login(values.username, values.password);
            view = 'console';
            activeTab = null;
            render();
        },

        'request': function (values) {
            store.createRequest(values);
            view = 'login';
            setFlash('Request sent. The administrator will review it and issue your credentials.', 'ok');
            render();
        },

        'change-password': async function (values) {
            if (values.next !== values.confirm) throw new Error('The two new passwords do not match.');
            var session = store.session();
            await store.changePassword(session.accountId, values.current, values.next);
            setFlash('Password updated.', 'ok');
            render();
        },

        'profile': function (values) {
            var session = store.session();
            store.saveProfile(session.accountId, values);
            setFlash('Details saved. Uploads will now be cross-checked against them.', 'ok');
            activeTab = 'documents';
            render();
        }
    };

    async function onSubmit(e) {
        var form = e.target.closest('[data-form]');
        if (!form) return;
        e.preventDefault();

        var name = form.getAttribute('data-form');
        var handler = FORMS[name];
        if (!handler) return;

        var button = form.querySelector('button[type="submit"]');
        if (button) { button.disabled = true; }
        setStatus('Working…');

        try {
            await handler(formValues(form));
        } catch (err) {
            setStatus(err.message || String(err), 'error');
            if (button) button.disabled = false;
        }
    }

    /* -------------------------------------------------------------------------
       Overlay open/close, focus trap
       ---------------------------------------------------------------------- */
    function focusables() {
        return Array.prototype.slice.call(sheet.querySelectorAll(
            'button:not([disabled]), [href], input:not([type="hidden"]), textarea, select, summary, [tabindex]:not([tabindex="-1"])'
        )).filter(function (el) { return el.offsetParent !== null; });
    }

    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key !== 'Tab') return;
        var list = focusables();
        if (!list.length) return;
        var first = list[0], last = list[list.length - 1];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function open() {
        lastFocused = doc.activeElement;
        view = store.session() ? 'console' : 'login';
        render();
        scrim.hidden = false;
        requestAnimationFrame(function () { scrim.classList.add('is-open'); });
        scrollLock = doc.body.style.overflow;
        doc.body.style.overflow = 'hidden';
        doc.addEventListener('keydown', onKey);
        var firstInput = bodyEl.querySelector('input, select, textarea, button');
        if (firstInput) firstInput.focus();
    }

    function close() {
        scrim.classList.remove('is-open');
        doc.removeEventListener('keydown', onKey);
        doc.body.style.overflow = scrollLock;
        credential = null;
        var done = function () { scrim.hidden = true; };
        if (global.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
        else setTimeout(done, 340);
        if (lastFocused && lastFocused.focus) lastFocused.focus();
    }

    /* -------------------------------------------------------------------------
       Boot
       ---------------------------------------------------------------------- */
    var headSignOut;

    function mount() {
        scrim = doc.getElementById('spxPortal');
        if (!scrim) return;

        sheet = scrim.querySelector('.spx-sheet');
        head = scrim.querySelector('.spx-head');
        tabsEl = scrim.querySelector('.spx-tabs');
        bodyEl = scrim.querySelector('.spx-body');
        titleEl = scrim.querySelector('.spx-head h2');
        eyebrowEl = scrim.querySelector('.spx-eyebrow');
        whoamiEl = scrim.querySelector('.spx-whoami');
        headSignOut = scrim.querySelector('[data-action="logout"]');
        fileInput = scrim.querySelector('#spxFileInput');

        scrim.addEventListener('click', function (e) {
            if (e.target === scrim) close();
        });
        scrim.querySelector('.spx-close').addEventListener('click', close);
        scrim.addEventListener('click', onClick);
        scrim.addEventListener('submit', onSubmit);

        fileInput.addEventListener('change', function () {
            var docId = pendingDocId;
            pendingDocId = null;
            if (docId && fileInput.files.length) handleFiles(docId, fileInput.files);
        });

        var tab = doc.getElementById('spxLoginTab');
        if (tab) tab.addEventListener('click', open);

        /* Deep link: /#portal opens straight into the sign-in sheet. */
        if (global.location.hash === '#portal') open();
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount);
    else mount();

    SPX.portal = { open: open, close: close, render: render };
})(window);
