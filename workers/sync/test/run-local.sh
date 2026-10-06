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
node executive.test.mjs | tail -1
node --test pages.test.mjs 2>/dev/null | grep -E "positions:|^# (pass|fail)"
node --test promises.test.mjs 2>/dev/null | grep -E "^# (pass|fail)"

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
echo "--- executive branch (officials, orders, outcomes, nominations):"
$D1 --command "SELECT id, slug, office, rank FROM officials WHERE chamber IN ('us-executive', 'ca-executive') AND active = 1 ORDER BY chamber DESC, rank" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT step, status, message FROM sync_log WHERE step IN ('executive-officials', 'executive-orders', 'bill-outcomes', 'nominations') ORDER BY id LIMIT 8" --json | python3 -c "import json,sys; [print(' ', r['step'], r['status'], r['message']) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT id, official_id, kind, number, substr(title, 1, 50) AS title, document_url IS NOT NULL AS pdf FROM executive_actions ORDER BY id" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT bill_id, outcome, action_date, law_number, actor_name FROM bill_outcomes ORDER BY bill_id" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT id, official_id, status FROM nominations ORDER BY id" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT o.id, f.candidate_id, f.note, (SELECT COUNT(*) FROM funding_progress p WHERE p.official_id = o.id) AS periods FROM officials o LEFT JOIN fec_candidates f ON f.official_id = o.id WHERE o.chamber = 'us-executive' AND o.rank <= 2" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
echo "--- page summaries (the Laws list and vote counts, built during the sync):"
$D1 --command "SELECT status, message FROM sync_log WHERE step = 'page-summaries' ORDER BY id LIMIT 1" | grep -E '"(status|message)"' | sed 's/^ *//'
$D1 --command "SELECT bill_id, last_final, final_result, yea, nay, outcome, routine FROM bill_list ORDER BY level, last_final DESC" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
echo "--- promises: sources found, and what the AI suggested after the checks (at most 3 a day; officials take turns):"
$D1 --command "SELECT step, status, message FROM sync_log WHERE step IN ('promise-sources', 'promises') ORDER BY id" --json | python3 -c "import json,sys; [print(' ', r['step'], r['status'], r['message']) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT p.id, o.name, p.source_kind, p.made_on, p.review, p.quote, p.check_note, p.due FROM promises p JOIN officials o ON o.id = p.official_id ORDER BY p.id" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
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
  INSERT INTO issue_bill_links (issue_slug, bill_id, reason, status, approved_by, approved_at, source_url) VALUES ('broadband-scoring', 'us-119-s-30', 'Test link', 'approved', 'Local tester', datetime('now'), 'https://example.org/link');
  INSERT INTO promise_pages (url, official_id, kind, title, added_by) VALUES ('http://127.0.0.1:8788/campaign/issues/', 'ca-exec:governor:gloria-testgovernor', 'campaign_site', 'Issues', 'local test');
  DELETE FROM sync_state WHERE key LIKE 'promises_discovered_%' OR key LIKE 'promise_suggestions_%' OR key LIKE 'promise_docs_%'" >/dev/null
curl -s "localhost:8789/analyze?token=local-test-token" >/dev/null
sleep 2
until curl -s "localhost:8789/status?token=local-test-token" | grep -q '"status": "finished"'; do sleep 2; done
curl -s "localhost:8789/status?token=local-test-token" | grep -E '"message": "(us|ca)-|earlier draft' | sed 's/^ *//'
echo "--- a campaign Issues page listed by a person, read in the next round:"
$D1 --command "SELECT url, fetched_at IS NOT NULL AS fetched, note, excerpt, excerpt_by FROM promise_pages" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT p.id, o.name, p.source_kind, p.quote FROM promises p JOIN officials o ON o.id = p.official_id WHERE p.source_kind = 'campaign_site'" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
kill $WK
echo "--- California campaign finance (Cal-Access file) and Form 700s:"
$D1 --command "SELECT step, status, message FROM sync_log WHERE message LIKE 'California campaign%' OR message LIKE 'FPPC%' OR message LIKE '%FPPC:%' ORDER BY id LIMIT 4" --json | python3 -c "import json,sys; [print(' ', r['step'], r['status'], r['message']) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT c.official_id, c.cycle, c.raised, c.spent, (SELECT COUNT(*) FROM state_money_ie i WHERE i.official_id = c.official_id) AS ie FROM state_money_cycles c ORDER BY 1" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
$D1 --command "SELECT official_id, substr(note, 1, 90) AS note FROM disclosure_checks WHERE source = 'cal-access' ORDER BY 1" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"

(cd "$REPO" && $WRANGLER pages dev . --port 8790 --d1 DB=pillory-local-test --persist-to "$STATE" \
  --binding ADMIN_LOCAL_DEV=1 --binding REVIEWER_NAME="Test Reviewer" \
  --binding TURNSTILE_SITE_KEY=1x00000000000000000000AA --binding TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA \
  --binding TURNSTILE_VERIFY_URL=http://127.0.0.1:8788/turnstile/siteverify --binding VISITOR_SALT=local-test \
  --binding CENSUS_GEOCODER_URL=http://127.0.0.1:8788/census/geographies/onelineaddress \
  --binding FPPC_SEARCH=http://127.0.0.1:8788/fppc \
  >/tmp/pillory-pages.log 2>&1) & PG=$!
until curl -s localhost:8790/ >/dev/null 2>&1; do sleep 1; done
echo "--- reader actions on the site (Turnstile is faked):"
curl -s -o /dev/null -w "report on H.R. 10's card: %{http_code} %{redirect_url}\n" -X POST -d "reason=unfair&note=Test+report&cf-turnstile-response=ok" localhost:8790/laws/bills/us-119-hr-10/flag
curl -s -o /dev/null -w "report with a failed check: %{http_code} %{redirect_url}\n" -X POST -d "reason=unfair&cf-turnstile-response=bad" localhost:8790/laws/bills/us-119-hr-10/flag
curl -s -o /dev/null -w "full analysis of H.R. 10: %{http_code} %{redirect_url}\n" -X POST -d "cf-turnstile-response=ok" localhost:8790/laws/bills/us-119-hr-10/request-full
curl -s -o /dev/null -w "full analysis of a skipped bill: %{http_code} %{redirect_url}\n" -X POST -d "cf-turnstile-response=ok" localhost:8790/laws/bills/us-119-hr-40/request-full
echo "--- pages (status, and a section that couldn't load):"
for u in / /laws/ "/laws/?votes=all" "/laws/?level=federal&offset=20" /reps/ /reps/?state=CA /explore/ /explore/ca/ /place/ca/calaveras/ /district/congressional/ca-5/ /laws/bills/us-119-hr-10/; do
  curl -s -o /tmp/pillory-page.html -w "  %{http_code} %{time_total}s $u" "localhost:8790$u"
  grep -q "Couldn't load this" /tmp/pillory-page.html && echo " (a section couldn't load)" || echo
done
echo "--- promises on the review page: approve one, record a status change (evidence and source required), and see it on the official's page:"
curl -s localhost:8790/admin/review/ | grep -o 'Suggested promises <span class="queue-count">[0-9]*' | sed 's/<[^>]*>//g; s/^/  /'
PID=$($D1 --command "SELECT id FROM promises WHERE review = 'suggested' ORDER BY id LIMIT 1" --json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['results'][0]['id'])")
curl -s -o /dev/null -w "  approve promise $PID: %{http_code} %{redirect_url}\n" -X POST -d "action=approve&reviewer=Test+Reviewer" localhost:8790/admin/review/promise/$PID/
curl -s -X POST -d "action=status&to_status=kept&evidence=&evidence_on=2026-10-01&source_url=https%3A%2F%2Fexample.org%2Fevidence&reviewer=Test+Reviewer" localhost:8790/admin/review/promise/$PID/ | grep -o 'Describe the evidence\.' | sed 's/^/  without evidence: /'
curl -s -X POST -d "action=status&to_status=kept&evidence=A+record+shows+it&evidence_on=2026-10-01&source_url=not-a-link&reviewer=Test+Reviewer" localhost:8790/admin/review/promise/$PID/ | grep -o 'Enter the source as an http(s) link\.' | sed 's/^/  without a source link: /'
curl -s -o /dev/null -w "  in progress, with evidence and a source: %{http_code}\n" -X POST -d "action=status&to_status=in_progress&evidence=A+contract+for+the+first+site+was+signed.&evidence_on=2026-10-01&source_url=https%3A%2F%2Fexample.org%2Fevidence&reviewer=Test+Reviewer" localhost:8790/admin/review/promise/$PID/
SLUG=$($D1 --command "SELECT o.slug FROM promises p JOIN officials o ON o.id = p.official_id WHERE p.id = $PID" --json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['results'][0]['slug'])")
curl -s "localhost:8790/reps/$SLUG/?fresh=$PID" | python3 -c "
import sys,re
t=sys.stdin.read()
m=t[t.find('id=\"platform\"'):t.find('id=\"votes\"')]
print('  official page:', re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',m))[:600])"
curl -s "localhost:8790/reps/$SLUG/?fresh=x" | grep -c 'class="card stack-sm promise"' | sed 's/^/  promises shown (approved only): /'
echo "--- add a promise by hand (a meeting video with its time), approve suggestions in a batch, list an Issues page:"
GOV="Gloria+Testgovernor+%C2%B7+Governor"
curl -s -X POST -d "official=$GOV&quote=We+value+our+parks+and+the+people+who+use+them.&made_on=2026-09-01&source_kind=meeting_video&source_url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dfake&source_title=Test+meeting&check_note=A+park.&reviewer=Test+Reviewer" localhost:8790/admin/review/promise/new/ | grep -o 'may not be a specific commitment[^.]*' | sed 's/^/  a value, not a commitment: /'
curl -s -o /dev/null -w "  saved: %{http_code} %{redirect_url}\n" -X POST -d "official=$GOV&quote=I+will+open+the+new+library+in+San+Andreas+by+May+2027.&made_on=2026-09-01&source_kind=meeting_video&source_url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dfake&source_time=1%3A02%3A03&source_title=Test+meeting%2C+September+1%2C+2026&check_note=The+library+in+San+Andreas+opens.&due=by+May+2027&reviewer=Test+Reviewer" localhost:8790/admin/review/promise/new/
IDS=$($D1 --command "SELECT id FROM promises WHERE review = 'suggested'" --json | python3 -c "import json,sys; print('&'.join('ids=%d' % r['id'] for r in json.load(sys.stdin)[0]['results']))")
curl -s -o /dev/null -w "  approve selected ($IDS): %{http_code} %{redirect_url}\n" -X POST -d "$IDS&reviewer=Test+Reviewer" localhost:8790/admin/review/promise/batch/
curl -s -o /dev/null -w "  list a page: %{http_code} %{redirect_url}\n" -X POST -d "action=add&official=$GOV&kind=office_site&url=https%3A%2F%2Fexample.org%2Fpriorities&title=Priorities" localhost:8790/admin/review/promise/pages/
$D1 --command "SELECT review, COUNT(*) AS n FROM promises GROUP BY review" --json | python3 -c "import json,sys; [print(' ', r) for r in json.load(sys.stdin)[0]['results']]"
curl -s "localhost:8790/reps/test-assemblymember-delta/?fresh=empty" | grep -o 'No platform recorded yet' | sed 's/^/  empty tab: /'
curl -s -X POST -d "action=add&official=Nobody&body=I+was+not+contacted+about+this+record.&submitted_on=2026-10-01&received_via=email&recorded_by=Test+Reviewer" localhost:8790/admin/review/promise/statements/ | grep -o 'Choose the official[^<]*\|Published[^<]*' | head -1 | sed 's/^/  statement without its official: /' || true
curl -s -o /dev/null -w "  record a statement: %{http_code} %{redirect_url}\n" -X POST -d "action=add&official=$GOV&title=On+rural+roads&body=Our+office+will+publish+a+repaving+schedule+for+every+county+road+by+March+2027.%0D%0A%0D%0AQuestions+can+go+to+our+district+office.&submitted_on=2026-10-01&received_via=Email+from+the+office&recorded_by=Test+Reviewer" localhost:8790/admin/review/promise/statements/
curl -s "localhost:8790/reps/gloria-testgovernor/?fresh=platform" | python3 -c "
import sys,re
t=sys.stdin.read()
m=t[t.find('id=\"platform\"'):t.find('id=\"votes\"')]
for k in ('In their own words','Submitted by the official','Campaign website','Commitments tracked','Excerpt picked automatically'):
    print('  platform tab has', repr(k), k in m)"
echo "--- district lookups (fake Census geocoder; nothing is stored):"
curl -s -X POST -H "Content-Type: application/json" -d '{"q":"1 Test Street, San Andreas, CA"}' localhost:8790/api/districts; echo
curl -s -X POST -H "Content-Type: application/json" -d '{"q":"95249"}' localhost:8790/api/districts; echo
echo "--- waitlist (Turnstile is faked):"
curl -s -o /dev/null -w "join: %{http_code} %{redirect_url}\n" -X POST -d "state=CA&county=06009&email=test%40example.org&cf-turnstile-response=ok" localhost:8790/api/waitlist
curl -s -o /dev/null -w "county not in that state: %{http_code} %{redirect_url}\n" -X POST -d "state=NV&county=06009&email=test%40example.org&cf-turnstile-response=ok" localhost:8790/api/waitlist
echo "--- site with local data: http://localhost:8790/reps/  and  http://localhost:8790/admin/review/  (Ctrl-C to stop)"
wait $PG
