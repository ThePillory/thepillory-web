#!/bin/bash
# TEMPORARY research probe: FEC candidate data for candidate pages. Remove before merge.
set -u
O=tmp-research/out-fec; mkdir -p $O
A="https://api.open.fec.gov/v1"; K="api_key=$FEC_API_KEY"
g() { curl -s "$1&$K" > "$O/$2"; echo "$2 $(wc -c < $O/$2)"; }
g "$A/candidates/search/?state=TX&office=S&election_year=2026&candidate_status=C&per_page=3" search.json
g "$A/candidates/totals/?state=TX&office=S&election_year=2026&per_page=3" totals.json
g "$A/committee/C00840017/?per_page=1" committee.json
c=$(python3 -c "import json;r=json.load(open('$O/search.json'))['results'];print(r[0]['principal_committees'][0]['committee_id'] if r and r[0].get('principal_committees') else '')")
echo "committee $c"
[ -n "$c" ] && g "$A/committee/$c/?per_page=1" committee-p.json
[ -n "$c" ] && g "$A/schedules/schedule_a/?committee_id=$c&is_individual=false&two_year_transaction_period=2026&sort=-contribution_receipt_amount&per_page=10" sched-a.json
[ -n "$c" ] && g "$A/filings/?committee_id=$c&form_type=F1&per_page=2&sort=-receipt_date" f1.json
