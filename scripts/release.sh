#!/usr/bin/env bash
# Release dev → production in one go:
#   1. fast-forward master to dev and push (Render deploys the server)
#   2. wait until Render is serving that exact commit (/healthz)
#   3. deploy the Shopify side (theme block, pixel, app config) to the production app
#   4. switch the local theme block back to the dev app
#
#   npm run release
set -euo pipefail
cd "$(dirname "$0")/.."

PROD_URL="https://social-wall.cloverkitstudio.com"
TIMEOUT_SECS=900

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31m✗ %s\033[0m\n" "$*"; exit 1; }

[ "$(git branch --show-current)" = "dev" ] || fail "Run this from the dev branch."
[ -z "$(git status --porcelain)" ] || fail "Commit or stash your changes first."

say "1/4  Merging dev into master and pushing…"
git push -q origin dev
git checkout -q master
git pull -q --ff-only origin master
git merge -q --ff-only dev || { git checkout -q dev; fail "master has commits dev doesn't. On dev: git merge master, then retry."; }
git push -q origin master
SHA="$(git rev-parse master)"
git checkout -q dev
echo "   pushed ${SHA:0:12}"

say "2/4  Waiting for Render to serve ${SHA:0:12}… (usually ~5 min)"
start=$(date +%s)
while true; do
  live="$(curl -s -m 10 "$PROD_URL/healthz" || true)"
  case "$live" in
    "ok ${SHA:0:12}"*) echo "   ✓ live"; break ;;
  esac
  [ $(( $(date +%s) - start )) -gt $TIMEOUT_SECS ] && fail "Render isn't serving ${SHA:0:12} after $((TIMEOUT_SECS/60)) min (it says: ${live:-no answer}). Check Render → social-wall → Events/Logs. Shopify was NOT deployed."
  printf "."
  sleep 15
done

say "3/4  Deploying the Shopify side to the production app…"
# --allow-updates: no prompt for changes; Shopify still asks before deleting anything
node scripts/block-app-id.mjs shopify.app.toml
shopify app deploy --config shopify.app.toml --allow-updates --version "${SHA:0:12}" --message "Release ${SHA:0:12}"

say "4/4  Switching the local theme block back to the dev app…"
node scripts/block-app-id.mjs shopify.app.dev.toml

say "✓ Released ${SHA:0:12} — server on Render and Shopify app version ${SHA:0:12}."
