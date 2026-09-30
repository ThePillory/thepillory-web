#!/usr/bin/env bash
# TEMPORARY research script (see .github/workflows/research-hub.yml). Round 3.
set +e
L() { curl -s "$1" | grep -o 'href="[^"?/][^"]*"' | grep -v -E "census.gov|\.css|facebook|twitter|linkedin|youtube|instagram|govdelivery" | head -${2:-40}; }
R=https://www2.census.gov/programs-surveys/decennial/rdo/mapping-files
echo "=== mapping-files"; L $R/
for y in 2023 2024 2025 2026; do echo "=== $y"; L $R/$y/ 60; done
echo "=== geocoder ACS2025 specific layers"
curl -s "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=1100+Congress+Ave,+Austin,+TX+78701&benchmark=Public_AR_Current&vintage=ACS2025_Current&layers=54,56,58,82&format=json" | python3 -c "
import json,sys;d=json.load(sys.stdin);m=d['result']['addressMatches']
print([(k,{kk:v[0].get(kk) for kk in ('GEOID','BASENAME','STATE','CD119','SLDU','SLDL','NAME')}) for k,v in m[0]['geographies'].items()] if m else d)"
echo "=== geocoder bad address"
curl -s "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=nowhere+zzz&benchmark=Public_AR_Current&vintage=ACS2025_Current&layers=54&format=json" | head -c 400; echo
echo "=== CA process links"
for u in https://www.assembly.ca.gov/ https://www.senate.ca.gov/ ; do curl -s -A 'Mozilla/5.0' "$u" | grep -o -i 'href="[^"]*\(process\|bill\|how\)[^"]*"' | sort -u | head -20; done
for u in https://www.assembly.ca.gov/about https://www.senate.ca.gov/about https://www.senate.ca.gov/how-bill-becomes-law https://www.assembly.ca.gov/how-bill-becomes-law https://www.assembly.ca.gov/legislativeprocess https://www.senate.ca.gov/legislativeprocess https://clerk.assembly.ca.gov/ https://www.senate.ca.gov/senators; do printf "%s %s\n" "$(curl -s -o /dev/null -L -w '%{http_code}' -A 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' "$u")" "$u"; done
