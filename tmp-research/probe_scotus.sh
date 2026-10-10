#!/bin/bash
# TEMPORARY research probe: Supreme Court data sources. Remove before merge.
set -u
O=tmp-research/out-scotus; mkdir -p $O
CL="https://www.courtlistener.com/api/rest/v4"
H="Authorization: Token $COURTLISTENER_API_TOKEN"
UA="ThePillory/1.0 (+https://thepillory.co; public records)"
get() { curl -s -A "$UA" -H "$H" "$1" > "$O/$2"; echo "$2 $(wc -c < $O/$2)"; }
get "$CL/positions/?court=scotus&position_type=jus&date_termination__isnull=true" positions-current.json
get "$CL/positions/?court=scotus&position_type=c-jus&date_termination__isnull=true" positions-chief.json
get "$CL/people/?positions__court=scotus&positions__date_termination__isnull=true" people.json
get "$CL/clusters/?docket__court=scotus&date_filed__gte=2025-06-01&order_by=-date_filed" clusters.json
get "$CL/opinions/?cluster__docket__court=scotus&cluster__date_filed__gte=2025-06-20&fields=id,type,author,author_str,joined_by,joined_by_str,per_curiam,cluster,download_url" opinions.json
get "$CL/financial-disclosures/?person__positions__court=scotus&year=2024" disclosures.json
get "$CL/gifts/?financial_disclosure__year=2024&financial_disclosure__person__positions__court=scotus" gifts.json
get "$CL/reimbursements/?financial_disclosure__year=2024&financial_disclosure__person__positions__court=scotus" reimbursements.json
curl -s -A "$UA" "https://www.supremecourt.gov/RSS/Cases/JSON/24-1287.json" > $O/docket-24-1287.json; echo "docket $(wc -c < $O/docket-24-1287.json)"
curl -s -A "$UA" "https://www.supremecourt.gov/orders/grantednotedlist.aspx" > $O/granted.html; echo "granted $(wc -c < $O/granted.html)"
curl -s -A "$UA" "https://www.supremecourt.gov/oral_arguments/argument_calendars.aspx" > $O/calendars.html; echo "calendars $(wc -c < $O/calendars.html)"
curl -s -A "$UA" "https://www.supremecourt.gov/opinions/slipopinion/25" > $O/slip25.html; echo "slip25 $(wc -c < $O/slip25.html)"
curl -s -A "$UA" "https://www.supremecourt.gov/opinions/slipopinion/24" > $O/slip24.html; echo "slip24 $(wc -c < $O/slip24.html)"
curl -s -A "$UA" "https://www.supremecourt.gov/about/biographies.aspx" > $O/bios.html; echo "bios $(wc -c < $O/bios.html)"
curl -s -A "$UA" -H "X-Api-Key: $CONGRESS_API_KEY" "https://api.congress.gov/v3/nomination/119?format=json&limit=1" > $O/congress-nom.json; echo "nom $(wc -c < $O/congress-nom.json)"
curl -s -A "$UA" "https://api.congress.gov/v3/nomination/109/1?format=json&api_key=$CONGRESS_API_KEY" > $O/nom-109-1.json; echo "nom109 $(wc -c < $O/nom-109-1.json)"
