#!/usr/bin/env bash
# One-shot deploy for mlr-guard.
#
#   bash scripts/deploy.sh
#
# Prerequisite: `npx wrangler login` (interactive, ~15 min timeout on the
# browser approval, so run it when you are actually at the keyboard).
#
# Idempotent: re-running is safe. Resource creation steps tolerate "already
# exists", and the D1 migrations use CREATE TABLE IF NOT EXISTS.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

say "Checking Cloudflare authentication"
if ! npx wrangler whoami 2>&1 | grep -qiE "account name|associated with the email"; then
  echo "Not authenticated. Run:  npx wrangler login"
  echo "Then re-run this script."
  exit 1
fi
npx wrangler whoami 2>&1 | tail -6

say "Creating D1 database (ok if it already exists)"
npx wrangler d1 create mlr_guard 2>&1 | tail -12 || true

# wrangler.toml ships with a placeholder id; fill it from the account's real one.
say "Resolving database_id into wrangler.toml"
DB_ID=$(npx wrangler d1 list --json 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{const j=JSON.parse(s);const m=j.find(x=>x.name==='mlr_guard');console.log(m?m.uuid:'')}catch(e){console.log('')}
    })")
if [ -z "$DB_ID" ]; then
  echo "Could not resolve the mlr_guard database id. Check 'npx wrangler d1 list'."
  exit 1
fi
node -e "
const fs=require('fs');
const p='wrangler.toml';
let s=fs.readFileSync(p,'utf8');
s=s.replace(/database_id = \"[^\"]*\"/, 'database_id = \"$DB_ID\"');
fs.writeFileSync(p,s);
console.log('  database_id = $DB_ID');
"

say "Creating R2 bucket (ok if it already exists)"
npx wrangler r2 bucket create mlr-guard-snapshots 2>&1 | tail -4 || true

say "Applying schema + synthetic seed to the remote D1"
npx wrangler d1 execute mlr_guard --remote --file=./migrations/0001_init.sql
npx wrangler d1 execute mlr_guard --remote --file=./migrations/0002_seed.sql

say "LLM secret"
if npx wrangler secret list 2>/dev/null | grep -q LLM_API_KEY; then
  echo "  LLM_API_KEY already set."
else
  echo "  LLM_API_KEY is NOT set."
  echo "  The app still works without it: generation falls back to a deterministic"
  echo "  selection and the audit trail records it as 'offline-fallback'."
  echo "  To use a real model:  npx wrangler secret put LLM_API_KEY"
fi

say "Building the Vue console"
npm run build

say "Deploying"
npx wrangler deploy 2>&1 | tail -20

say "Smoke test"
URL=$(npx wrangler deployments list --json 2>/dev/null | grep -o 'https://[a-z0-9.-]*workers.dev' | head -1)
if [ -z "$URL" ]; then
  echo "  Could not auto-detect the URL; check the deploy output above."
else
  echo "  $URL"
  curl -s "$URL/api/health" && echo
  echo "  Claims endpoint:"
  curl -s "$URL/api/claims?audience=hcp" | head -c 200; echo
fi

say "Done"
