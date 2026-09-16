#!/usr/bin/env bash
# One command from a clean checkout to a working stack.
#
#   ./scripts/deploy.sh <stack-name> <region> <admin-email> "<allowed-origins>"
#
# e.g.
#   ./scripts/deploy.sh spherecho-portal ap-south-1 you@spherechoproductions.com \
#     "https://spherechoproductions.com,https://sphereco-production-git-claude-i-baf2df-srijan-mishras-projects.vercel.app"
#
# Re-running is safe: CloudFormation updates in place, and seeding refuses to
# create a second administrator.
set -euo pipefail

STACK="${1:?stack name required}"
REGION="${2:?region required}"
ADMIN_EMAIL="${3:?admin email required}"
ORIGINS="${4:?allowed origins required (comma-separated, no trailing slash)}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_NAME="${ADMIN_NAME:-Administrator}"

cd "$(dirname "$0")/.."

echo "==> who am I"
aws sts get-caller-identity --output text --query 'Arn'

echo "==> refreshing the shared verification engine"
node scripts/sync-shared.js

echo "==> validating the template"
sam validate --lint --template template.yaml --region "$REGION"

echo "==> building"
sam build --template template.yaml

echo "==> deploying"
sam deploy \
  --stack-name "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides "AllowedOrigins=$ORIGINS"

API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)

echo "==> smoke test"
curl -fsS "$API_URL/health" && echo

echo "==> seeding the administrator (skipped if one already exists)"
node scripts/seed-admin.js \
  --stack "$STACK" --username "$ADMIN_USERNAME" \
  --email "$ADMIN_EMAIL" --name "$ADMIN_NAME" || true

cat <<SUMMARY

-------------------------------------------------------------------
  API      $API_URL

  Last step: put that URL into portal/config.js as apiBase, commit,
  and let Vercel redeploy the site.

      SPX.config = { apiBase: '$API_URL' };
-------------------------------------------------------------------
SUMMARY
