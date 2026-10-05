#!/bin/bash
# TEMPORARY research (round 7): Form 700 search body and PDF links. Remove before merging.
set -u
UA="ThePillory research (thepillory.co)"
B=https://form700search.fppc.ca.gov
curl -sS -A "$UA" -c /tmp/cj $B/ > /tmp/f7.html
for b in $(grep -oE '/Scripts/[a-zA-Z]+\?v=[^"]+' /tmp/f7.html); do curl -sS -A "$UA" "$B$b" >> /tmp/all.js; echo >> /tmp/all.js; done
python3 - <<'PY'
import re
s = open('/tmp/all.js', encoding='utf-8', errors='replace').read()
for key in ['generateSearchQueryInfo=', 'generateSearchQueryInfo:', 'function generateSearchQueryInfo', 'fetch(wt', 'wt,{', 'SearchTerm', 'searchTerm', 'FilerName', 'lastName:', 'pageSize:', 'PageSize']:
    for m in list(re.finditer(re.escape(key), s))[:2]:
        print(f'--- {key} @{m.start()}')
        print(s[max(0, m.start()-300): m.start()+1200].replace('\n', ' '))
PY
