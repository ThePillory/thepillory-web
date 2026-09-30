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
node meetings.test.mjs | tail -1
node review.test.mjs | grep "^# pass"

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

echo "--- review load: a legacy draft of a ceremonial bill, a draft the AI reviewer hasn't seen, and an issue link:"
D1="$WRANGLER d1 execute pillory-local-test -c wrangler.test.toml --local --persist-to $STATE"
$D1 --command "INSERT INTO bill_analyses (bill_id, status, basis, text_source_url, plain_summary, model, prompt_version) VALUES ('us-119-hr-40', 'ai_draft', 'full_text', 'https://example.org/hr40', 'A draft written before the relevance check existed.', 'claude-sonnet-5-5', 'legacy');
  UPDATE bill_analyses SET ai_review = NULL, ai_review_detail = '{}', spot_check = 0 WHERE bill_id = 'ca-20252026-ab-101';
  INSERT INTO issue_bill_links (issue_slug, bill_id, reason, status, approved_by, approved_at, source_url) VALUES ('broadband-scoring', 'us-119-s-30', 'Test link', 'approved', 'Local tester', datetime('now'), 'https://example.org/link')" >/dev/null
curl -s "localhost:8789/analyze?token=local-test-token" >/dev/null
sleep 2
until curl -s "localhost:8789/status?token=local-test-token" | grep -q '"status": "finished"'; do sleep 2; done
curl -s "localhost:8789/status?token=local-test-token" | grep -E '"message": "(us|ca)-|earlier draft' | sed 's/^ *//'
kill $WK

(cd "$REPO" && $WRANGLER pages dev . --port 8790 --d1 DB=pillory-local-test --persist-to "$STATE" \
  --binding ADMIN_LOCAL_DEV=1 --binding REVIEWER_NAME="Test Reviewer" \
  --binding TURNSTILE_SITE_KEY=1x00000000000000000000AA --binding TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA \
  --binding TURNSTILE_VERIFY_URL=http://127.0.0.1:8788/turnstile/siteverify --binding VISITOR_SALT=local-test \
  >/tmp/pillory-pages.log 2>&1) & PG=$!
until curl -s localhost:8790/ >/dev/null 2>&1; do sleep 1; done
echo "--- reader actions on the site (Turnstile is faked):"
curl -s -o /dev/null -w "report on H.R. 10's card: %{http_code} %{redirect_url}\n" -X POST -d "reason=unfair&note=Test+report&cf-turnstile-response=ok" localhost:8790/laws/bills/us-119-hr-10/flag
curl -s -o /dev/null -w "report with a failed check: %{http_code} %{redirect_url}\n" -X POST -d "reason=unfair&cf-turnstile-response=bad" localhost:8790/laws/bills/us-119-hr-10/flag
curl -s -o /dev/null -w "full analysis of H.R. 10: %{http_code} %{redirect_url}\n" -X POST -d "cf-turnstile-response=ok" localhost:8790/laws/bills/us-119-hr-10/request-full
curl -s -o /dev/null -w "full analysis of a skipped bill: %{http_code} %{redirect_url}\n" -X POST -d "cf-turnstile-response=ok" localhost:8790/laws/bills/us-119-hr-40/request-full
echo "--- site with local data: http://localhost:8790/reps/  and  http://localhost:8790/admin/review/  (Ctrl-C to stop)"
wait $PG
