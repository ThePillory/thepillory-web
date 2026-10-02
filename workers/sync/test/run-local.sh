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
node nationwide.test.mjs | tail -1
node funding.test.mjs | tail -1

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
echo "--- relevance check requests (bills with an official description, of those sent):"
curl -s localhost:8788/__anthropic | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin) if r.get('kind') == 'relevance']"
$WRANGLER d1 execute pillory-local-test -c wrangler.test.toml --local --persist-to "$STATE" --json --command "SELECT id, official_summary_label AS label, substr(official_summary, 1, 60) AS summary FROM bills ORDER BY id" 2>/dev/null | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
echo "--- 150 House members who left (more than D1's 100 bound values), then the federal step again:"
D1="$WRANGLER d1 execute pillory-local-test -c wrangler.test.toml --local --persist-to $STATE"
python3 -c "
rows = ','.join(f\"('bioguide:GONE{i:03d}', 'gone-{i}', 'Former Member {i}', 'U.S. Representative', 'federal', 'us-house', 'us-house', 'https://example.org/gone', '2026-01-01', 1)\" for i in range(150))
print('INSERT INTO officials (id, slug, name, office, level, chamber, body, source_url, last_verified, active) VALUES ' + rows + '; DELETE FROM sync_state WHERE key = \'federal_officials_day\';')
" > /tmp/pillory-gone.sql
$D1 --file /tmp/pillory-gone.sql >/dev/null
curl -s "localhost:8789/run?token=local-test-token" >/dev/null
sleep 2
until curl -s "localhost:8789/status?token=local-test-token" | grep -q '"status": "finished"'; do sleep 2; done
$D1 --command "SELECT status, message FROM sync_log WHERE step = 'federal-officials' ORDER BY id DESC LIMIT 1" | grep -E '"(status|message)"' | sed 's/^ *//'
$D1 --command "SELECT COUNT(*) AS still_active FROM officials WHERE id LIKE 'bioguide:GONE%' AND active = 1" | grep still_active | sed 's/^ *//'
echo "--- county meetings (IQM2, then Tyler Meeting Manager; duplicates kept once):"
$D1 --command "SELECT m.id, m.body, m.status, substr(m.starts_at, 1, 10) AS day, (SELECT COUNT(*) FROM meeting_items i WHERE i.meeting_id = m.id) AS items, m.comment_deadline_text IS NOT NULL AS deadline, m.online_url IS NOT NULL AS zoom FROM meetings m WHERE m.level = 'county' ORDER BY m.starts_at" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT status, message FROM sync_log WHERE step = 'county-meetings' ORDER BY id LIMIT 2" | grep -E '"(status|message)"' | sed 's/^ *//'
echo "--- campaign funding (FEC) and lobbying (lda.gov):"
$D1 --command "SELECT step, status, message FROM sync_log WHERE step IN ('federal-funding', 'federal-lobbying') AND status != 'skipped' ORDER BY id" --json | python3 -c "import json,sys; [print(' ', r['step'], r['status'], r['message']) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT f.official_id, f.candidate_id, f.committee_id, f.note, (SELECT COUNT(*) FROM funding_progress p WHERE p.official_id = f.official_id AND p.done_at IS NOT NULL) AS periods, (SELECT COUNT(*) FROM funding_pacs p WHERE p.official_id = f.official_id) AS pacs FROM fec_candidates f ORDER BY 1" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT l.bill_id, f.client_name, f.amount, f.industry FROM bill_lobbying l JOIN lobbying_filings f USING (filing_uuid) ORDER BY 2" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
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
  --binding CENSUS_GEOCODER_URL=http://127.0.0.1:8788/census/geographies/onelineaddress \
  >/tmp/pillory-pages.log 2>&1) & PG=$!
until curl -s localhost:8790/ >/dev/null 2>&1; do sleep 1; done
echo "--- reader actions on the site (Turnstile is faked):"
curl -s -o /dev/null -w "report on H.R. 10's card: %{http_code} %{redirect_url}\n" -X POST -d "reason=unfair&note=Test+report&cf-turnstile-response=ok" localhost:8790/laws/bills/us-119-hr-10/flag
curl -s -o /dev/null -w "report with a failed check: %{http_code} %{redirect_url}\n" -X POST -d "reason=unfair&cf-turnstile-response=bad" localhost:8790/laws/bills/us-119-hr-10/flag
curl -s -o /dev/null -w "full analysis of H.R. 10: %{http_code} %{redirect_url}\n" -X POST -d "cf-turnstile-response=ok" localhost:8790/laws/bills/us-119-hr-10/request-full
curl -s -o /dev/null -w "full analysis of a skipped bill: %{http_code} %{redirect_url}\n" -X POST -d "cf-turnstile-response=ok" localhost:8790/laws/bills/us-119-hr-40/request-full
echo "--- district lookups (fake Census geocoder; nothing is stored):"
curl -s -X POST -H "Content-Type: application/json" -d '{"q":"1 Test Street, San Andreas, CA"}' localhost:8790/api/districts; echo
curl -s -X POST -H "Content-Type: application/json" -d '{"q":"95249"}' localhost:8790/api/districts; echo
echo "--- waitlist (Turnstile is faked):"
curl -s -o /dev/null -w "join: %{http_code} %{redirect_url}\n" -X POST -d "state=CA&county=06009&email=test%40example.org&cf-turnstile-response=ok" localhost:8790/api/waitlist
curl -s -o /dev/null -w "county not in that state: %{http_code} %{redirect_url}\n" -X POST -d "state=NV&county=06009&email=test%40example.org&cf-turnstile-response=ok" localhost:8790/api/waitlist
echo "--- site with local data: http://localhost:8790/reps/  and  http://localhost:8790/admin/review/  (Ctrl-C to stop)"
wait $PG
