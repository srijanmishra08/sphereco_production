# Internal & Partner Portal

Opens from the **Internal & Partner Login** tab in the site footer, or by visiting `/#portal`.

| File | Does |
| --- | --- |
| `config.js` | Where the API lives. Set `apiBase` to the stack's `ApiUrl`. |
| `store.js` | The API client. The only file that talks to the backend. |
| `portal.js` | The interface. |
| `portal.css` | Styles, using the site's existing tokens. |
| `../shared/checklist.js` | The document requirements — sections 1–12, the closing checklist, the profile form. Shared with the backend. |
| `../shared/verify.js` | The verification engine. Runs in Lambda; the browser no longer loads it. |
| `../backend/` | The AWS stack. See `backend/README.md`. |

## How access works

There is no sign-up. The chain is deliberately one-way:

1. **The administrator is seeded server-side**, once, by `backend/scripts/seed-admin.js` against the deployed stack. There is no endpoint and no screen that creates one — an earlier version offered a public "create the administrator" page, which meant whoever arrived first got it.
2. **Someone requests access** from the login screen, choosing *partner* or *internal*.
3. **The administrator approves**, which creates the Cognito account and generates a username and a 16-character password on the spot. The password is displayed **once**; we never store it, so a lost password is reissued, never looked up.
4. **First sign-in is challenged.** The issued password buys no session — Cognito holds the account in `FORCE_CHANGE_PASSWORD` and issues no token until the holder sets their own password.

Accounts can be revoked, restored, or given a fresh password from the Accounts tab; revoking disables the Cognito user, so it takes effect on the next request rather than at the next sign-in. Repeated failed sign-ins are rate-limited by Cognito.

### The two non-admin roles

- **Internal** — Spherecho staff. Sees partner submissions and the verification results, and can move a submission to *in review*, *returned* or *accepted*. Cannot approve access requests, create accounts, or read the audit log; those are the administrator's alone.
- **Partner** — sellers, producers and their advisors. Sees only their own entity profile, documents and closing checklist.

## What the automatic verification actually does

Every upload runs through the same pipeline before it is stored:

1. **Format** — read from the file's magic bytes, not its extension. A `.exe` renamed `.pdf` fails here.
2. **Integrity** — SHA-256, compared against every other file already uploaded. The same PDF filed against two requirements is flagged.
3. **Text extraction** — PDF content streams are inflated and the text-showing operators read; DOCX is read straight out of the zip. A scan with no text layer produces nothing, which is reported as *needs review* rather than passed.
4. **Content checks**, from the document's `expect` block:
   - expected wording for that document type,
   - identifiers (PAN, GSTIN, CIN/LLPIN, CBFC) extracted and validated — the GSTIN check digit is actually computed,
   - cross-checks against the entity profile (the PAN on the card must match the PAN typed on the form),
   - the seller's name and the film title appearing in the document,
   - a signature block, an execution date, term/territory wording, and whether a declaration carries an "except as disclosed" carve-out.

A single failing check makes the file *failed*; any warning makes it *needs review*; otherwise *verified*. None of this replaces a lawyer reading the paper — it catches the wrong file, the missing signature and the typo'd number before a person spends time on them.

## Adding the per-document template checks

This is the plug point for the checks to be defined from your templates. Each document in `checklist.js` carries an `expect` block, and `verify.js` reads whatever is in it. To tighten one document, overlay rules onto it — no other file changes:

```js
SPX.checklist.applyTemplate('cbfc.certificate', {
    keywordsAll: ['central board of film certification', 'certificate no'],
    identifiers: ['cbfc'],
    identifiersMode: 'all',
    wantsDate: true,
    matchFilmTitle: true
});
```

Supported keys: `keywordsAll`, `keywordsAny`, `identifiers` + `identifiersMode`, `crossCheck`, `matchEntityName`, `matchFilmTitle`, `wantsSignature`, `wantsDate`, `wantsTerm`, `noDues`, `declaration`. Anything a template needs beyond these becomes a new check in `verify.js` and a new key here.

## Where things run now

Accounts live in Cognito, records in DynamoDB, uploaded documents in a private,
encrypted, versioned S3 bucket. The browser holds one thing: an access token in
`sessionStorage`, which dies with the tab. Nothing is written to `localStorage`.

Uploads go straight to S3 through a presigned `PUT` scoped to a single key, so a
25 MB scan never passes through the API. The verdict is produced by the service
afterwards, reading the object — the browser cannot forge one.

Every authorisation decision is made server-side from the token's group claim.
The `role` the browser keeps only chooses which tabs to draw.

See `backend/README.md` for deploying, running locally, and what is still to do
(email delivery of credentials, refresh tokens).
