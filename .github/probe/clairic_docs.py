#!/usr/bin/env python3
"""Temporary, read-only: Clairic's schemas and the post's end; whether the Actions token can call Workers AI; and the verified records a pilot could compare against."""
import html, json, os, re, sys, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import load_trades as T  # noqa: E402
UA = "ThePillory research (+https://thepillory.co)"
def get(url, headers=None, data=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})}, data=data)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:3000]
    except Exception as e:
        return 0, str(e)
def text(page):
    page = re.sub(r"(?is)<(script|style|nav|footer|header)[^>]*>.*?</\1>", " ", page)
    page = re.sub(r"(?i)<(br|/p|/h\d|/li|/tr|/pre|/div)[^>]*>", "\n", page)
    page = html.unescape(re.sub(r"<[^>]+>", " ", page))
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", page)).strip()
for u in ["https://developers.cloudflare.com/workers-ai/models/clairic/schema-input.json", "https://developers.cloudflare.com/workers-ai/models/clairic/schema-output.json"]:
    c, b = get(u); print(f"\n######## {u} -> {c}\n{b[:20000]}")
c, b = get("https://blog.cloudflare.com/clairic-extraction-model/")
t = text(b); i = t.find("Clairic returns a distribution")
print(f"\n######## blog, from 'Clairic returns a distribution' -> {c}\n{t[i:i+16000]}")
acct, tok = os.environ["CLOUDFLARE_ACCOUNT_ID"], os.environ["CLOUDFLARE_API_TOKEN"]
c, b = get(f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/@cf/cloudflare/clairic", {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
           json.dumps({"model": "clairic", "state": "Report filed 2026-03-04. Amount $1,001 - $15,000.", "fields": {"filed": {"type": "date"}, "amount": {"type": "text"}}}).encode())
print(f"\n######## one tiny call with the Actions token -> {c}\n{b[:1500]}")
c, b = get("https://api.cloudflare.com/client/v4/user/tokens/verify", {"Authorization": f"Bearer {tok}"})
print(f"\n######## token verify -> {c}\n{b[:600]}")
class A: database = "pillory"
def q(label, sql):
    print(f"\n## {label}")
    try:
        for r in T.d1(A, command=sql): print(json.dumps(r, ensure_ascii=False)[:600])
    except Exception as e: print("ERROR", e)
q("trade_scans by status", "SELECT status, COUNT(*) n, SUM(reviewed_by IS NOT NULL) reviewed FROM trade_scans GROUP BY 1")
q("scanned reports published (checked by a person)", "SELECT r.id, r.official_id, r.filed_on, r.transcribed_by, (SELECT COUNT(*) FROM trades t WHERE t.report_id = r.id) n FROM trade_reports r WHERE r.transcribed_by IS NOT NULL")
q("trade_reports columns", "SELECT name FROM pragma_table_info('trade_reports')")
q("House PTRs parsed from text", "SELECT chamber, parsed, COUNT(*) n FROM trade_reports GROUP BY 1,2")
q("networth_reports by source/status/method", "SELECT source, status, method, COUNT(*) n FROM networth_reports GROUP BY 1,2,3")
q("net worth scans", "SELECT report_id, status, reviewed_by FROM networth_scans")
q("meetings columns", "SELECT name FROM pragma_table_info('meetings')")
q("Calaveras meetings with agenda PDFs", "SELECT COUNT(*) n FROM meetings WHERE agenda_url LIKE 'http%'")
