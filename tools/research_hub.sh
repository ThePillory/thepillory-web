#!/usr/bin/env bash
# TEMPORARY research script (see .github/workflows/research-hub.yml). Round 4.
set +e
L() { curl -s "$1" | grep -o 'href="[^"?/][^"]*"' | grep -v -E "census.gov|\.css|facebook|twitter|linkedin|youtube|instagram|govdelivery|oig.doc|commerce.gov|usa.gov" | head -${2:-80}; }
R=https://www2.census.gov/programs-surveys/decennial/rdo/mapping-files/2025
echo "=== 119 BEFs"; L $R/119-congressional-district-befs/
echo "=== 2024 SLD BEF"; L $R/2024-state-legislative-bef/
cd /tmp
f=$(curl -s $R/119-congressional-district-befs/ | grep -o 'href="[^"]*\.zip"' | head -1 | cut -d'"' -f2)
echo "first 119 file: $f"; curl -s -o a.zip "$R/119-congressional-district-befs/$f"; unzip -l a.zip; unzip -p a.zip | head -3
f=$(curl -s $R/2024-state-legislative-bef/ | grep -o 'href="[^"]*\.zip"' | head -1 | cut -d'"' -f2)
echo "first SLD file: $f"; curl -s -o b.zip "$R/2024-state-legislative-bef/$f"; unzip -l b.zip; for n in $(unzip -Z1 b.zip | head -3); do echo "-- $n"; unzip -p b.zip "$n" | head -3; done
echo "=== zcta-block size and head"
curl -sI https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_tabblock20_natl.txt | grep -i length
curl -s https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_tabblock20_natl.txt | head -3
echo "=== counties"
curl -s https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt | head -3
curl -sI https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt | grep -i -E "^HTTP|length"
echo "=== CA process final URLs"
for u in https://www.assembly.ca.gov/legislativeprocess https://www.senate.ca.gov/legislativeprocess https://www.assembly.ca.gov/resources/legislative-process https://www.senate.ca.gov/citizens-guide/legislative-process; do curl -s -o /dev/null -L -w '%{http_code} %{url_effective}\n' -A 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' "$u"; done
