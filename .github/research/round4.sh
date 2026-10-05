#!/bin/bash
# TEMPORARY research (round 6): the Form 700 search request format. Remove before merging.
set -u
UA="ThePillory research (thepillory.co)"
B=https://form700search.fppc.ca.gov
curl -sS -A "$UA" -c /tmp/cj $B/ > /tmp/f7.html
for b in $(grep -oE '/Scripts/[a-zA-Z]+\?v=[^"]+' /tmp/f7.html); do curl -sS -A "$UA" "$B$b" >> /tmp/all.js; echo >> /tmp/all.js; done
wc -c /tmp/all.js
python3 - <<'PY'
import re
s = open('/tmp/all.js', encoding='utf-8', errors='replace').read()
for key in ['hdnSearchDocumentsUrl', 'SearchDocuments', 'hdnGetRedactedFormPdfUrl', 'GetRedactedFormPdf', 'indexID', 'searchCriteria', 'filingYear']:
    for m in list(re.finditer(re.escape(key), s))[:3]:
        print(f'--- {key} @{m.start()}')
        print(s[max(0, m.start()-500): m.start()+700].replace('\n', ' '))
PY
echo "### bootstrap keys"
curl -sS -A "$UA" -b /tmp/cj -X POST "$B/Home/GetBootstrap" -o /tmp/boot.json -w "%{http_code}\n"; python3 -c "
import json; d=json.load(open('/tmp/boot.json'))
def walk(x, p=''):
    if isinstance(x, dict):
        for k, v in x.items():
            if k in ('WebSiteLogo',): continue
            walk(v, p + '.' + k)
    elif isinstance(x, list):
        print(p, '[list', len(x), ']', json.dumps(x[:3])[:400])
    else:
        print(p, '=', str(x)[:200])
walk(d)
" | head -80
