# Portal backend (AWS)

Cognito for identity, DynamoDB for records, a private S3 bucket for documents,
and one Lambda behind an HTTP API that also runs the document verification.

```
                    browser (static site on Vercel)
                          |  JSON + bearer token
                          v
        API Gateway (HTTP API)  ->  Lambda  ->  DynamoDB   (requests, submissions, audit)
                                      |     ->  Cognito    (accounts, passwords, groups)
                                      |     ->  S3         (documents, presigned in/out)
                                      +--------- verification engine (shared/verify.js)
```

The browser never talks to DynamoDB, S3 or Cognito directly. Uploads are the one
exception and even they are indirect: the API issues a presigned `PUT` scoped to
one key, the bytes go straight to S3, and the API is then asked to finalise —
which is when it reads the object and decides the verdict.

## Deploying

Prerequisites: an AWS account, the [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html),
and credentials with permission to create the resources in `template.yaml`.

```bash
cd backend
npm install

# 1. Deploy. --guided asks for a stack name and region the first time and
#    remembers them in samconfig.toml.
npm run deploy

#    When it asks for AllowedOrigins, give the site origins that will call the
#    API, comma-separated and with no trailing slash, e.g.
#      https://spherechoproductions.com,https://sphereco-production-git-....vercel.app

# 2. Create the one administrator. Server-side, once.
node scripts/seed-admin.js \
  --stack <the stack name you chose> \
  --username admin \
  --email you@spherechoproductions.com \
  --name "Your Name"

# 3. Point the site at the API: copy the stack's ApiUrl output into
#    portal/config.js as apiBase, then redeploy the site.
```

Sign in with the password `seed-admin.js` printed. Cognito will require you to
replace it before it issues a token — the same flow every approved account gets.

### Deploying again

`npm run deploy` (no `--guided`) after the first time. The DynamoDB table and the
S3 bucket are `Retain`-flagged and the user pool has deletion protection on, so
tearing the stack down will not take the records or the documents with it.

## Running it locally

No AWS account needed. The local server runs the same router and routes against
in-memory adapters, and serves the site too:

```bash
npm run local          # http://localhost:8090
```

It seeds `admin` / `spherecho-admin-local` (override with `ADMIN_USERNAME` and
`ADMIN_PASSWORD`). `portal/config.js` ships pointing at `/api`, which is what
this server provides, so the site works unchanged.

## Tests

```bash
npm test               # 50 checks over the API contract and the access rules
```

Covers the access model (partner cannot reach staff endpoints, internal cannot
approve or read the audit log, the admin cannot be revoked through the API), the
credential lifecycle (issue, challenge, the issued password dying on use,
reissue, revoke), the upload path and the verification verdicts.

## Layout

| Path | What |
| --- | --- |
| `template.yaml` | Everything the stack creates. |
| `src/index.js` | Lambda entry; normalises the API Gateway event. |
| `src/router.js` | Auth, dispatch, error shaping. Shared by Lambda and local. |
| `src/routes.js` | Every endpoint. Where authorisation is decided. |
| `src/ports/aws.js` | DynamoDB, S3, Cognito. |
| `src/ports/memory.js` | The same three interfaces, in memory, for local and tests. |
| `src/verification/` | **Generated.** Copies of `/shared`; run `npm run sync-shared`. |
| `local/server.js` | Dev server: API + presigned URLs + static site. |
| `scripts/seed-admin.js` | Creates the administrator, once, server-side. |

## Notes on the design

**The administrator is seeded, not self-served.** There is no endpoint that
creates an admin — deliberately, because the earlier browser-only version showed
a "create the administrator" screen to whoever arrived first. `seed-admin.js`
refuses to run if the `admin` group already has a member.

**Roles come from the token.** `cognito:groups` decides what a caller may do.
The `role` the browser holds only picks which tabs to draw; editing it in
devtools changes the page and nothing else.

**Passwords are never stored by us.** Cognito holds them. Approving a request
calls `AdminCreateUser` with a temporary password, which leaves the account in
`FORCE_CHANGE_PASSWORD` — Cognito itself refuses to issue tokens until the
holder sets their own. That is why the password can be shown exactly once and
why "reissue" is the answer to a lost one.

**One table, no scans.** Every list is a `Query` against a known partition key:
`REQUESTS`, `ACCOUNTS`, `AUDIT`, `SUB#<accountId>`, `HASH#<sha256>`. The hash
partition is what lets duplicate detection work across the whole tenancy without
reading everything.

**Verification runs server-side only.** `shared/verify.js` is the single
canonical engine; the browser no longer runs it, so a verdict cannot be forged
by editing client state.

## Not built yet

- **Email.** Credentials are shown to the administrator to pass on; nothing is
  sent automatically. Adding SES means one `SendEmailCommand` in the approve
  route and a verified sending identity.
- **Refresh tokens.** The client holds an 8-hour access token and signs in again
  after that. The refresh token is returned by the API but not yet used.
- **Per-document template checks.** The plug point is `expect` in
  `shared/checklist.js` — see `portal/README.md`.
