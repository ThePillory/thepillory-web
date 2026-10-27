import re, sys, urllib.request, subprocess, tempfile, html
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
def get(u):
    r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=60)
    return r.geturl(), r.read()
for u in sys.argv[1:]:
    print("=" * 30, u)
    try:
        final, b = get(u)
    except Exception as e:
        print("ERR", e); continue
    print("final:", final, len(b))
    if b[:4] == b"%PDF":
        with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
            f.write(b); f.flush()
            print(subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True).stdout[:20000])
        continue
    t = b.decode("utf-8", "replace")
    for h, txt in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', t, re.S):
        txt = re.sub(r"<[^>]+>|\s+", " ", txt).strip()
        if re.search(r"2026|amend|judic|pdf|candidate|referend|explan|bill|session|fiscal|supreme|appeals|seat", h + txt, re.I):
            print("LINK", h, "|", txt[:100])
    body = re.sub(r"<script.*?</script>|<style.*?</style>", "", t, flags=re.S)
    body = html.unescape(re.sub(r"<[^>]+>", "\n", body))
    body = re.sub(r"\n\s*\n+", "\n", body)
    print(body[:12000])
