#!/usr/bin/env bash
# TEMPORARY research script (see .github/workflows/research-hub.yml).
set +e
G="https://geocoding.geo.census.gov/geocoder"
echo "=== geocoder: CORS preflight and headers"
curl -s -D - -o /dev/null -H "Origin: https://thepillory.co" "$G/geographies/onelineaddress?address=891+Mountain+Ranch+Road,+San+Andreas,+CA+95249&benchmark=Public_AR_Current&vintage=Current_Current&format=json" | grep -i -E "^HTTP|access-control|content-type"
curl -s -D - -o /dev/null -X OPTIONS -H "Origin: https://thepillory.co" -H "Access-Control-Request-Method: GET" "$G/geographies/onelineaddress" | grep -i -E "^HTTP|access-control"
echo "=== geocoder: layers list"
curl -s "$G/vintages?benchmark=Public_AR_Current&format=json" | head -c 1500; echo
echo "=== geocoder: address, all layers (keys and relevant fields)"
curl -s "$G/geographies/onelineaddress?address=891+Mountain+Ranch+Road,+San+Andreas,+CA+95249&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json" > /tmp/g.json
python3 - <<'PY'
import json
d=json.load(open('/tmp/g.json'))
r=d.get('result',{})
ms=r.get('addressMatches',[])
print('matches', len(ms))
if ms:
    m=ms[0]; print('matchedAddress', m.get('matchedAddress'))
    for k,v in m.get('geographies',{}).items():
        if any(w in k for w in ['Congress','Legislative','Count','State']) and v:
            print(repr(k), {kk: v[0].get(kk) for kk in v[0] if kk in ('GEOID','NAME','BASENAME','CD119','CD118','SLDU','SLDL','STATE','COUNTY','CDSESSN','LSY','FUNCSTAT')})
PY
echo "=== geocoder: specific layers param names"
curl -s "$G/geographies/onelineaddress?address=1600+Pennsylvania+Ave+NW,+Washington,+DC+20500&benchmark=Public_AR_Current&vintage=Current_Current&layers=54,56,58,82&format=json" | python3 -c "import json,sys;d=json.load(sys.stdin);m=d['result']['addressMatches'];print([ (k,[x.get('GEOID') for x in v]) for k,v in m[0]['geographies'].items()] if m else d)"
echo "=== geocoder: ZIP only"
curl -s "$G/geographies/onelineaddress?address=95249&benchmark=Public_AR_Current&vintage=Current_Current&format=json" | head -c 300; echo
echo "=== census rel2020 listing"
curl -s https://www2.census.gov/geo/docs/maps-data/data/rel2020/ | grep -o 'href="[^"]*"' | head -40
echo "=== cd-sld listing"
curl -s https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/ | grep -o 'href="[^"]*"' | head -60
echo "=== zcta520 listing"
curl -s https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/ | grep -o 'href="[^"]*"' | head -40
echo "=== explainer sources"
for u in https://www.congress.gov/help/learn-about-the-legislative-process https://www.congress.gov/help/legislative-glossary https://www.house.gov/the-house-explained/the-legislative-process https://www.senate.gov/about/powers-procedures/filibusters-cloture.htm https://www.senate.gov/about/powers-procedures/nominations.htm https://www.senate.gov/legislative/votes_new.htm https://clerk.house.gov/Votes https://www.congress.gov/help/legislative-glossary#glossary_cloturemotion https://leginfo.legislature.ca.gov/faces/billSearchClient.xhtml https://www.assembly.ca.gov/about-assembly https://www.senate.ca.gov/legislative-process https://www.senate.ca.gov/ https://www.assembly.ca.gov/ https://leginfo.legislature.ca.gov/faces/codes.xhtml https://www.archives.gov/founding-docs/constitution https://www.regulations.gov/ https://www.usa.gov/elected-officials https://www.census.gov/programs-surveys/geography/technical-documentation/records-layout/2020-zcta-record-layout.html https://www.senate.gov/legislative/common/briefing/Senate_legislative_process.htm https://www.govinfo.gov/content/pkg/CDOC-110hdoc49/pdf/CDOC-110hdoc49.pdf; do printf "%s %s\n" "$(curl -s -o /dev/null -L -w '%{http_code}' -A 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' "$u")" "$u"; done
