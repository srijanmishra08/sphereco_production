# Internal & Partner Portal

Opens from the **Internal & Partner Login** tab in the site footer, or by visiting `/#portal`.

| File | Does |
| --- | --- |
| `checklist.js` | The document requirements — sections 1–12, the closing checklist, and the partner profile form. Data only. |
| `store.js` | Accounts, access requests, sessions, submissions, uploaded bytes. The only file that touches storage. |
| `verify.js` | Reads an uploaded file and decides `verified` / `review` / `failed`. |
| `portal.js` | The interface. |
| `portal.css` | Styles, using the site's existing tokens. |

## How access works

There is no sign-up. The chain is deliberately one-way:

1. **First run** — the portal has no accounts, so it asks for an administrator to be created. This is the only account that can come into existence on its own.
2. **Someone requests access** from the login screen, choosing *partner* or *internal*.
3. **The administrator approves**, which creates the account and generates a username and a 16-character password on the spot. The password is displayed **once** — it is stored only as a PBKDF2-SHA256 hash, so a lost password is reissued, never looked up.
4. **First sign-in forces a password change.** The issued password stops working at that moment.

Accounts can be revoked, restored, or given a fresh password from the Accounts tab. Five failed sign-ins lock a username for five minutes.

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

## Before this handles real deal documents

The portal runs entirely in the browser: accounts and submission metadata in `localStorage`, uploaded files in IndexedDB. That is what lets it ship on the current static site with no backend, and it is genuinely useful for walking a partner through the checklist — but it is **not a security boundary**, and it has consequences worth being explicit about:

- Anyone who opens devtools can read the store. Password hashing keeps passwords out of it; it does not make the data private.
- Data lives in one browser on one machine. A partner uploading from their laptop is invisible to a reviewer on theirs, and clearing site data erases everything.
- Uploaded documents never leave the partner's machine — good for confidentiality, useless for actually receiving the documents.

Moving this to real infrastructure means replacing the body of `store.js` with API calls and running the same verification server-side (the checks in `verify.js` port directly to Node). The rest of the portal is written against `SPX.store`'s interface and would not change.
