#!/bin/bash
# TEMPORARY research probe: Supreme Court official sources, round 2. Remove before merge.
set -u
O=tmp-research/out-scotus2; mkdir -p $O
UA="ThePillory/1.0 (+https://thepillory.co; public records)"
g() { curl -sL -A "$UA" "$1" > "$O/$2"; echo "$2 $(wc -c < $O/$2) $(file -b $O/$2 | cut -c1-30)"; }
for t in 11 12 15 20; do g "https://www.supremecourt.gov/opinions/slipopinion/$t" slip$t.html; done
g "https://www.supremecourt.gov/opinions/slipopinion/25" slip25.html
g "https://www.supremecourt.gov/oral_arguments/calendarsandlists.aspx" calendars.html
g "https://www.supremecourt.gov/orders/grantednotedlists.aspx" granted2.html
g "https://www.senate.gov/legislative/nominations/SupremeCourtNominations1789present.htm" senate-nominations.html
g "https://www.supremecourt.gov/about/members_text.aspx" members.html
g "https://www.supremecourt.gov/qp/24-01287qp.pdf" qp.pdf
# the newest argued-term opinion PDF linked from the 2025 term page
pdf=$(grep -o 'href="[^"]*opinions/2[45]pdf/[^"]*\.pdf"' $O/slip25.html | head -1 | sed 's/href="//;s/"$//')
echo "pdf: $pdf"; [ -n "$pdf" ] && g "https://www.supremecourt.gov${pdf#..}" op.pdf
sudo apt-get update -qq >/dev/null && sudo apt-get install -y -qq poppler-utils >/dev/null
for f in qp op; do [ -s $O/$f.pdf ] && pdftotext -layout $O/$f.pdf $O/$f.txt; done
head -c 300000 $O/op.txt > $O/op-head.txt 2>/dev/null; rm -f $O/op.txt $O/*.pdf
