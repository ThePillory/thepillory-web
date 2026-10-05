#!/bin/bash
# TEMPORARY research (round 8): Form 700 search by filer name; PDF links. Remove before merging.
set -u
B=https://form700search.fppc.ca.gov
python3 - <<'PY'
import json, urllib.request
B = 'https://form700search.fppc.ca.gov'
UA = {'User-Agent': 'ThePillory research (thepillory.co)', 'Content-Type': 'application/json'}
def post(body):
    req = urllib.request.Request(B + '/Home/SearchDocuments', data=json.dumps(body).encode(), headers=UA, method='POST')
    raw = urllib.request.urlopen(req, timeout=40).read().decode()
    d = json.loads(raw)
    if isinstance(d, str): d = json.loads(d)
    return d
tries = []
for field in ['FilerLastName', 'FilerName', 'LastName', 'Filer']:
    for qt in ['Match', 'Exact Match', 'Start Match', 'Start With']:
        tries.append({'searchFieldQueryInfos': [{'queryField': field, 'queryType': qt, 'filterValue': 'Newsom'}], 'showOnlyHeldPositions': False})
hit = None
for body in tries:
    try:
        d = post(body)
        docs = d.get('documents') or []
        names = sorted({(x['filer']['lastName'], x['filer']['firstName']) for x in docs})[:6]
        print(body['searchFieldQueryInfos'][0]['queryField'], body['searchFieldQueryInfos'][0]['queryType'], '->', len(docs), 'docs; total', d.get('total', d.get('totalCount')), names, list(d.keys())[:8])
        if docs and all(n[0].lower() == 'newsom' for n in names) and not hit: hit = (body, d)
    except Exception as e:
        print(body['searchFieldQueryInfos'][0], 'ERR', str(e)[:200])
if hit:
    body, d = hit
    print('### hit body', json.dumps(body))
    for x in d['documents'][:12]:
        print(json.dumps({'indexID': x['indexID'], 'filer': x['filer'], 'filingInfo': x['filingInfo'], 'positions': x['filingPositions']})[:500])
    x = d['documents'][0]; p = x['filingPositions'][0]
    import urllib.parse
    q = {'indexID': x['indexID'], 'fileNameInfo.LastName': x['filer']['lastName'], 'fileNameInfo.FirstName': x['filer']['firstName'], 'fileNameInfo.FilingYear': p['filingYear'], 'fileNameInfo.Agency': p['agency'], 'fileNameInfo.Position': p['position'], 'fileNameInfo.FilingType': p['filingType'], 'fileNameInfo.IsAmendment': 'true' if x['filingInfo']['isAmendment'] else 'false', 'fileNameInfo.FilingDate': x['filingInfo']['filedDate']}
    for i in range(2):
        u = B + '/Home/GetRedactedFormPdf?' + urllib.parse.urlencode(q)
        r = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA['User-Agent']}), timeout=40).read().decode()
        print('### pdf', i, r[:600])
    # Is there a stable view link? try GetRedactedFormPdf with only indexID
    try:
        r = urllib.request.urlopen(urllib.request.Request(B + '/Home/GetRedactedFormPdf?indexID=' + x['indexID'], headers={'User-Agent': UA['User-Agent']}), timeout=40).read().decode()
        print('### pdf indexID-only', r[:400])
    except Exception as e:
        print('### pdf indexID-only ERR', e)
PY
