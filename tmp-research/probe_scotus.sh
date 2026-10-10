#!/bin/bash
# TEMPORARY research probe: Supreme Court official sources, round 3. Remove before merge.
set -u
O=tmp-research/out-scotus3; mkdir -p $O
UA="ThePillory/1.0 (+https://thepillory.co; public records)"
sudo apt-get update -qq >/dev/null && sudo apt-get install -y -qq poppler-utils >/dev/null
for t in 16 17 18 19 21 22 23 24 25 26; do
  curl -sL -A "$UA" "https://www.supremecourt.gov/opinions/slipopinion/$t" > $O/slip$t.html
  echo "slip$t $(wc -c < $O/slip$t.html) rows $(grep -c '<tr' $O/slip$t.html) pdfs $(grep -o "href='/opinions/[0-9]*pdf/[^']*'" $O/slip$t.html | wc -l)"
done
# Lineups: the first page or two of argued cases from OT2024 and OT2025 (author column not PC).
n=0
for t in 24 25; do
  python3 - "$O/slip$t.html" >> $O/picks.txt <<'PY'
import re,sys
s=open(sys.argv[1]).read()
for r in re.findall(r'<tr>.*?</tr>', s, re.S):
    c=[re.sub(r'<[^>]+>','',x).strip() for x in re.findall(r'<td[^>]*>(.*?)</td>', r, re.S)]
    m=re.search(r"href='(/opinions/\d+pdf/[^']+)'", r)
    if m and len(c)>=6 and c[4] not in ("PC","D"): print(m.group(1), c[4], c[2])
PY
done
head -8 $O/picks.txt > $O/sel.txt; tail -4 $O/picks.txt >> $O/sel.txt
while read path au dk; do
  n=$((n+1)); curl -sL -A "$UA" "https://www.supremecourt.gov$path" > $O/op$n.pdf
  pdftotext -layout -f 1 -l 4 $O/op$n.pdf $O/op$n.txt; echo "$path $au $dk" > $O/op$n.meta
done < $O/sel.txt
curl -sL -A "$UA" "https://www.supremecourt.gov/orders/26grantednotedlist.pdf" > $O/granted26.pdf && pdftotext -layout $O/granted26.pdf $O/granted26.txt
cal=$(grep -o 'href="[^"]*[Cc]alendar[^"]*\.pdf"' tmp-research/out-scotus2/calendars.html | head -3 | sed 's/href="//;s/"$//')
echo "$cal" > $O/calendar-links.txt
i=0; for c in $cal; do i=$((i+1)); u="$c"; case "$u" in http*) ;; /*) u="https://www.supremecourt.gov$u";; *) u="https://www.supremecourt.gov/oral_arguments/$u";; esac; curl -sL -A "$UA" "$u" > $O/cal$i.pdf; pdftotext -layout $O/cal$i.pdf $O/cal$i.txt; done
rm -f $O/*.pdf $O/slip1[6-9].html $O/slip2[1-3].html
