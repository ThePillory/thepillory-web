#!/bin/bash
# TEMPORARY research (round 5). Remove before merging.
set -u
UA="ThePillory research (thepillory.co)"
echo "### A build"; time python3 tools/build_ca_campaign.py /tmp/cabuild
python3 - <<'PY'
import json
d = json.load(open('data/ca-campaign.json'))
print({k: d[k] for k in ('source', 'export_modified', 'generated')})
for k, v in d['officials'].items():
    print('==', k, v['name'])
    for c in v['committees'][:4]:
        print('  ', c['filer_id'], c['name'], len(c['reports']), c['reports'][:2])
PY
URL=$(python3 -c "import json; d=json.load(open('data/ca-campaign.json')); print(next(r['source_url'] for v in d['officials'].values() for c in v['committees'] for r in c['reports']))")
echo "### A2 statement link $URL"; curl -sS -o /tmp/s.bin -w "%{http_code} %{content_type} %{size_download}\n" -A "$UA" "$URL"; head -c 200 /tmp/s.bin | strings | head -3
echo "### B form700 hidden urls"
curl -sS -A "$UA" -c /tmp/cj https://form700search.fppc.ca.gov/ > /tmp/f7.html
grep -oE '<input[^>]+id="hdn[A-Za-z]+"[^>]*>' /tmp/f7.html | sed -E 's/.*id="([^"]+)".*value="([^"]*)".*/\1 = \2/' 
S=$(grep -oE 'id="hdnSearchDocumentsUrl"[^>]*value="[^"]*"' /tmp/f7.html | sed -E 's/.*value="([^"]*)"/\1/'); B=$(grep -oE 'id="hdnGetBootstrapUrl"[^>]*value="[^"]*"' /tmp/f7.html | sed -E 's/.*value="([^"]*)"/\1/')
echo "search=$S bootstrap=$B"
echo "### B2 bootstrap"; curl -sS -A "$UA" -b /tmp/cj "https://form700search.fppc.ca.gov$B" | head -c 2500; echo
echo "### B3 search GET"; curl -sS -A "$UA" -b /tmp/cj "https://form700search.fppc.ca.gov$S?searchText=Newsom" | head -c 1500; echo
echo "### B4 search POST json"; curl -sS -A "$UA" -b /tmp/cj -H "Content-Type: application/json" -X POST -d '{"searchText":"Newsom","pageNumber":1,"pageSize":10}' "https://form700search.fppc.ca.gov$S" | head -c 2500; echo
echo "### B5 searchExportBundle snippets"
curl -sS -A "$UA" "https://form700search.fppc.ca.gov$(grep -oE '/Scripts/bundle\?v=[^"]+' /tmp/f7.html | head -1)" | grep -oE '.{0,200}(hdnSearchDocumentsUrl|SearchDocuments|searchText|filters|pageSize).{0,300}' | head -12
