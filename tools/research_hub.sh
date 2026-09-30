#!/usr/bin/env bash
# TEMPORARY research script (see .github/workflows/research-hub.yml). Round 2.
set +e
G="https://geocoding.geo.census.gov/geocoder"
A="address=891+Mountain+Ranch+Road,+San+Andreas,+CA+95249&benchmark=Public_AR_Current"
echo "=== CORS headers, full"
curl -s -D - -o /dev/null -H "Origin: https://thepillory.co" "$G/geographies/onelineaddress?$A&vintage=Current_Current&format=json"
for v in Current_Current ACS2025_Current ACS2024_Current Census2020_Current; do
  echo "=== vintage $v layer keys"
  curl -s "$G/geographies/onelineaddress?$A&vintage=$v&layers=all&format=json" | python3 -c "
import json,sys
d=json.load(sys.stdin); m=d['result']['addressMatches']
g=m[0]['geographies'] if m else {}
for k,v in g.items():
  if 'Congress' in k or 'Legislative' in k: print(repr(k), v[0].get('GEOID'), v[0].get('BASENAME'))
"
done
echo "=== TIGERweb layer ids (Current)"
curl -s "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer?f=json" | python3 -c "import json,sys;d=json.load(sys.stdin);print([(l['id'],l['name']) for l in d.get('layers',[])])"
curl -s "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer?f=json" | python3 -c "import json,sys;d=json.load(sys.stdin);print([(l['id'],l['name']) for l in d.get('layers',[]) if 'Congress' in l['name'] or 'Legislative' in l['name'] or 'Count' in l['name']])"
curl -s "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2025/MapServer?f=json" | python3 -c "import json,sys;d=json.load(sys.stdin);print([(l['id'],l['name']) for l in d.get('layers',[]) if 'Congress' in l['name'] or 'Legislative' in l['name'] or 'Count' in l['name']])"
echo "=== layers by number on Current_Current"
for L in 50 52 54 56 58 60 62 64; do printf "%s: " $L; curl -s "$G/geographies/onelineaddress?$A&vintage=Current_Current&layers=$L&format=json" | python3 -c "import json,sys;d=json.load(sys.stdin);m=d['result']['addressMatches'];print(list(m[0]['geographies'].keys()) if m else d)"; done
echo "=== TX address (mid-decade redistricting check), Current vs ACS2025"
for v in Current_Current ACS2025_Current; do curl -s "$G/geographies/onelineaddress?address=1100+Congress+Ave,+Austin,+TX+78701&benchmark=Public_AR_Current&vintage=$v&layers=all&format=json" | python3 -c "
import json,sys
d=json.load(sys.stdin); m=d['result']['addressMatches']
g=m[0]['geographies'] if m else {}
print('$v', [(k, v[0].get('BASENAME')) for k,v in g.items() if 'Congress' in k])"; done
echo "=== cd-sld files with zcta or 119/120"
curl -s https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/ | grep -o 'href="[^"]*"' | grep -i -E "zcta|cd119|cd120|natl" | head -60
echo "=== zcta-county head"
curl -s https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt | head -3
echo "=== congress.gov with DEMO_KEY"
C="https://api.congress.gov/v3"
curl -s "$C/member?currentMember=true&limit=3&format=json&api_key=DEMO_KEY" | head -c 2500; echo
curl -s "$C/member/AK?currentMember=true&format=json&api_key=DEMO_KEY" | head -c 1500; echo
curl -s "$C/member/DC?currentMember=true&format=json&api_key=DEMO_KEY" | head -c 1200; echo
curl -s "$C/member?currentMember=true&limit=250&offset=500&format=json&api_key=DEMO_KEY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d.get('members',[])), d.get('pagination'))"
curl -s "$C/house-vote/119/1/100?format=json&api_key=DEMO_KEY" | head -c 3000; echo
echo "=== senate xml counts"
curl -s -A 'Mozilla/5.0' https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00100.xml | grep -A8 "<count>"
echo "=== CA process pages"
for u in https://www.assembly.ca.gov/legislative-process https://www.assembly.ca.gov/about-assembly/legislative-process https://www.senate.ca.gov/legislative-process-overview https://www.senate.ca.gov/about-california-state-senate https://leginfo.legislature.ca.gov/faces/home.xhtml https://www.assembly.ca.gov/sites/assembly.ca.gov/files/Publications/guide_to_the_legislative_process.pdf https://clerk.assembly.ca.gov/content/guide-legislative-process https://www.congress.gov/help/learn-about-the-legislative-process https://www.house.gov/the-house-explained https://www.senate.gov/legislative/nominations.htm https://www.senate.gov/about/powers-procedures/voting.htm https://www.senate.gov/about/origins-foundations/senate-and-constitution/constitution.htm https://clerk.house.gov/Help https://www.govinfo.gov/app/details/CDOC-110hdoc49 https://www.senate.gov/reference/glossary_term/cloture.htm https://www.senate.gov/reference/glossary_term/motion_to_proceed.htm https://www.senate.gov/reference/glossary_term/roll_call_vote.htm https://www.senate.gov/reference/glossary_term/nomination.htm https://www.senate.gov/reference/glossary_term/motion_to_recommit.htm https://www.senate.gov/reference/glossary_term/table.htm; do printf "%s %s\n" "$(curl -s -o /dev/null -L -w '%{http_code}' -A 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' "$u")" "$u"; done
