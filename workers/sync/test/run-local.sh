#!/usr/bin/env bash
# End-to-end local test with FAKE data: fixture APIs -> sync Worker (sync, then
# AI-drafted analysis against a fake Claude API and fake CourtListener) -> local
# D1 -> Pages Functions. Needs Node and wrangler (`npm i -g wrangler` or npx),
# and `npm install` in workers/sync.
#   workers/sync/test/run-local.sh            # sync, then serve the site on :8790
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd ../../.. && pwd)"
STATE="${STATE_DIR:-/tmp/pillory-local-d1}"
WRANGLER="${WRANGLER:-npx wrangler}"
rm -rf "$STATE"

echo "--- unit tests (quote and citation checks):"
node verify.test.mjs | tail -1
node access.test.mjs | tail -1
node d1retry.test.mjs | tail -1

node fixture-server.mjs & FIX=$!
$WRANGLER dev -c wrangler.test.toml --port 8789 --persist-to "$STATE" --test-scheduled >/tmp/pillory-worker.log 2>&1 & WK=$!
trap 'kill $FIX $WK ${PG:-} 2>/dev/null || true' EXIT
until curl -s localhost:8789/ >/dev/null 2>&1; do sleep 1; done

echo "--- unauthorized run is refused:"
curl -s -o /dev/null -w "%{http_code}\n" "localhost:8789/run"
echo "--- manual run:"
curl -s "localhost:8789/run?token=local-test-token"
until curl -s "localhost:8789/status?token=local-test-token" | grep -q '"status": "finished"'; do sleep 2; done
echo "--- analysis results (two drafts are deliberately wrong; see fixture-server.mjs):"
curl -s "localhost:8789/status?token=local-test-token" | grep -E '"message": "(us|ca)-' | sed 's/^ *//' 
echo "--- second run (should fetch nothing new):"
curl -s "localhost:8789/run?token=local-test-token" | grep -E '"(step|status|requests|message)"'
echo "--- cron trigger:"
curl -s "localhost:8789/__scheduled?cron=0+11+*+*+*" ; echo
echo "--- status:"
curl -s "localhost:8789/status?token=local-test-token" | head -20
kill $WK

(cd "$REPO" && $WRANGLER pages dev . --port 8790 --d1 DB=pillory-local-test --persist-to "$STATE" \
  --binding ADMIN_LOCAL_DEV=1 --binding REVIEWER_NAME="Test Reviewer" >/tmp/pillory-pages.log 2>&1) & PG=$!
until curl -s localhost:8790/ >/dev/null 2>&1; do sleep 1; done
echo "--- site with local data: http://localhost:8790/reps/  and  http://localhost:8790/admin/review/  (Ctrl-C to stop)"
wait $PG
