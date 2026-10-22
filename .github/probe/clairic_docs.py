#!/usr/bin/env python3
"""Temporary, read-only: the Clairic announcement, the Workers AI docs, and whether the model is in the account's catalog."""
import html, json, os, re, urllib.request
UA = "ThePillory research (+https://thepillory.co)"
def get(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:2000]
    except Exception as e:
        return 0, str(e)
def text(page):
    page = re.sub(r"(?is)<(script|style|nav|footer|header)[^>]*>.*?</\1>", " ", page)
    page = re.sub(r"(?i)<(br|/p|/h\d|/li|/tr|/pre|/div)[^>]*>", "\n", page)
    page = re.sub(r"<[^>]+>", " ", page)
    page = html.unescape(page)
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", page)).strip()
for url in ["https://blog.cloudflare.com/clairic-extraction-model/",
            "https://developers.cloudflare.com/workers-ai/models/clairic/",
            "https://developers.cloudflare.com/workers-ai/models/clairic/index.md",
            "https://developers.cloudflare.com/workers-ai/platform/pricing/"]:
    code, body = get(url)
    print(f"\n######## {url} -> {code} ({len(body)} bytes)")
    t = text(body) if "<html" in body[:2000].lower() else body
    if "pricing" in url:
        i = t.lower().find("clairic"); print(t[max(0, i - 1500): i + 1500] if i >= 0 else "(no 'clairic' on the pricing page)")
    else:
        print(t[:14000])
acct, tok = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("CLOUDFLARE_API_TOKEN")
for q in ["clairic", "extract"]:
    code, body = get(f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/models/search?search={q}&per_page=50", {"Authorization": f"Bearer {tok}"})
    print(f"\n######## model search '{q}' -> {code}")
    try:
        for m in json.loads(body).get("result", []):
            print(json.dumps({k: m.get(k) for k in ("name", "description", "task", "properties")}, ensure_ascii=False)[:1500])
    except Exception:
        print(body[:1500])
code, body = get(f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/models/schema?model=@cf/cloudflare/clairic", {"Authorization": f"Bearer {tok}"})
print(f"\n######## schema @cf/cloudflare/clairic -> {code}\n{body[:12000]}")
