#!/usr/bin/env python3
"""
A pilot, not a switch: Cloudflare's Clairic extraction model
(@cf/cloudflare/clairic, Workers AI, preview) on documents ThePillory has
already read and checked, compared field by field with what's published.
Reads D1; writes nothing anywhere but its own report.

The documents (picked at random, fixed by --seed):
  278t     OGE Form 278-T reports read from their text layer (the President's
           first). No scanned 278-T has been confirmed by a person yet, so these
           e-filed ones, sent as page images, stand in for scans.
  house    electronic House Periodic Transaction Reports parsed from text
  annual   annual financial disclosures (House and OGE) read from text: the
           asset and liability lines, re-read with tools/networth.py, the
           parser behind the published figures
  agenda   Calaveras County agenda PDFs: item numbers and titles, against the
           items saved from the county's web agenda (meeting_items)

Each page goes to Clairic as one image (its limit is 4 a call) with typed
fields for each row: "r03.date", "r03.asset", ... (Clairic has no row type,
so rows are numbered fields, answered in one parallel pass). With
--modes image,text the same page is also sent as its text layer alone, where
answers are spans of that text with character offsets.

Measured per kind and mode: rows found, missed and invented; accuracy per
field; how well confidence predicts a wrong value; whether spans point at the
same text; dollars and seconds per document. --claude-dollars N also reads the
same page images with the two models of the current method (claude-sonnet-5-5
and claude-opus-5-5) for the same measures, stopping before N dollars.

  python3 tools/clairic_pilot.py --kinds 278t,house,annual,agenda --seed 1
  python3 tools/clairic_pilot.py --kinds house --limit 2 --modes image --claude-dollars 3

Needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (D1) and a token with
Workers AI permission in CLOUDFLARE_AI_TOKEN (or CLOUDFLARE_API_TOKEN, if it
has it); ANTHROPIC_API_KEY for --claude-dollars. Needs pdftoppm and pdftotext
(poppler-utils).
"""
import argparse
import base64
import difflib
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_trades as T  # noqa: E402
import networth as N  # noqa: E402

MODEL = "@cf/cloudflare/clairic"
PRICE_PER_M = 0.10            # dollars per million input tokens; no output charge
CLAUDE = {"claude-sonnet-5-5": (2.0, 10.0), "claude-opus-5-5": (4.0, 20.0)}
ROWS = {"278t": 20, "house": 20, "annual": 25, "agenda": 25}  # row slots asked for on each page
MAX_PAGES = 30   # every page of these documents; rows past it would count as missed
DPI = 130
UA = "ThePillory research (+https://thepillory.co)"

# The typed fields for one row, per kind: name -> (type, what it holds).
ROW_FIELDS = {
    "278t": {
        "date": ("date", "the transaction date"),
        "type": ("text", "the transaction type exactly as written (for example Purchase, Sale, P, S, S (partial))"),
        "amount": ("text", "the amount range exactly as written (for example $1,001 - $15,000)"),
        "asset": ("text", "the asset's description exactly as written"),
        "owner": ("text", "the owner exactly as written (for example SP, JT, DC, Self), if the row gives one"),
    },
    "annual": {
        "name": ("text", "the asset's or liability's description exactly as written"),
        "value": ("text", "its value or amount range exactly as written (for example $1,001 - $15,000, None (or less than $1,001), Over $50,000,000)"),
    },
    "agenda": {
        "number": ("text", "the item number exactly as written"),
        "title": ("text", "the item's title exactly as written"),
    },
}
ROW_FIELDS["house"] = ROW_FIELDS["278t"]
TABLE = {"278t": "transactions", "house": "transactions", "annual": "assets or liabilities", "agenda": "agenda items"}


# ---------------------------------------------------------------------------
# The request (pure)

def fields_for(kind, rows=None):
    """Clairic's fields for one page: a row count, then each row's typed fields."""
    rows = rows or ROWS[kind]
    out = {"rows": {"type": "number", "integer": True, "instructions": f"How many {TABLE[kind]} rows this page lists (0 if none)"}}
    for i in range(1, rows + 1):
        for name, (typ, what) in ROW_FIELDS[kind].items():
            out[f"r{i:02}.{name}"] = {"type": typ, "instructions": f"Row {i} of the {TABLE[kind]} on this page, counting from the top and skipping headings: {what}"}
    return out


def rows_from_answers(kind, answers, state_text=None):
    """Clairic's answers -> rows in page order: {field: {value, confidence, p_null, span, grounded}}. Pure."""
    rows = []
    for i in range(1, ROWS[kind] + 1):
        row = {}
        for name in ROW_FIELDS[kind]:
            a = answers.get(f"r{i:02}.{name}") or {}
            span = a.get("span")
            grounded = None
            if span and state_text is not None and a.get("value") is not None:
                grounded = state_text[span[0]:span[1]] == str(a["value"])
            row[name] = {"value": a.get("value"), "confidence": a.get("confidence"), "p_null": a.get("p_null"), "span": span, "grounded": grounded}
        key = {"278t": "asset", "house": "asset", "annual": "name", "agenda": "title"}[kind]
        if row[key]["value"] not in (None, ""):
            rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# Comparing (pure)

def _n(s):
    return T.norm(s)


def same_field(kind, name, got, want):
    """'exact', 'close' (a name or title off by a little) or 'wrong'. Code decides, by the same rules as the parsers."""
    if got in (None, ""):
        return "wrong"
    if name == "date":
        return "exact" if str(got)[:10] == str(want) else "wrong"
    if name == "type":
        return "exact" if T.type_label(got) == want else "wrong"
    if name == "owner":
        return "exact" if T.owner_label(got) == want else "wrong"
    if name == "amount":
        return "exact" if T.amount_bounds(got) == T.amount_bounds(want) and T.amount_bounds(want) != (None, None) else "wrong"
    if name == "value":
        return "exact" if N.value_bounds(got) is not None and N.value_bounds(got) == N.value_bounds(want) else "wrong"
    if name == "number":
        return "exact" if str(got).strip().rstrip(".") == str(want).strip().rstrip(".") else "wrong"
    a, b = _n(got), _n(want)
    if a == b:
        return "exact"
    return "close" if difflib.SequenceMatcher(None, a, b).ratio() >= 0.9 else "wrong"


def key_of(kind, row):
    k = {"278t": "asset", "house": "asset", "annual": "name", "agenda": "title"}[kind]
    v = row[k]["value"] if isinstance(row.get(k), dict) else row.get(k)
    return _n(v)


def align(kind, got, want):
    """Pairs (got index, want index), in order, by the row's name; then the rows missed and invented. Pure."""
    pairs, used, start = [], set(), 0
    for wi, w in enumerate(want):
        wk = key_of(kind, w)
        best, score = None, 0.6
        for gi in range(start, len(got)):
            if gi in used:
                continue
            s = difflib.SequenceMatcher(None, key_of(kind, got[gi]), wk).ratio()
            if s > score:
                best, score = gi, s
            if s == 1.0:
                break
        if best is not None:
            pairs.append((best, wi))
            used.add(best)
            start = best + 1
    matched_w = {w for _, w in pairs}
    return pairs, [w for w in range(len(want)) if w not in matched_w], [g for g in range(len(got)) if g not in used]


def compare(kind, got, want):
    """One document: rows found / missed / invented, and every compared field with its confidence. Pure."""
    pairs, missed, invented = align(kind, got, want)
    fields = []
    for gi, wi in pairs:
        for name in ROW_FIELDS[kind]:
            want_v = want[wi].get(name)
            if want_v in (None, ""):
                continue  # the record doesn't state it (an owner a 278-T leaves blank)
            g = got[gi][name]
            fields.append({"field": name, "result": same_field(kind, name, g["value"], want_v), "confidence": g.get("confidence"), "grounded": g.get("grounded"), "got": g["value"], "want": want_v})
    return {"truth_rows": len(want), "found": len(pairs), "missed": len(missed), "invented": len(invented), "fields": fields,
            "missed_rows": [want[w] for w in missed][:10], "invented_rows": [{k: v["value"] for k, v in got[g].items()} for g in invented][:10]}


BUCKETS = [(0.99, "≥ 0.99"), (0.95, "0.95–0.99"), (0.8, "0.80–0.95"), (0.0, "< 0.80")]


def summarize(results):
    """Per kind and mode: totals, field accuracy, confidence buckets, spans, cost, time. Pure."""
    out = {}
    for r in results:
        s = out.setdefault((r["kind"], r["mode"]), {"docs": 0, "pages": 0, "truth": 0, "found": 0, "missed": 0, "invented": 0, "fields": {}, "buckets": {b: [0, 0] for _, b in BUCKETS},
                                                    "high_conf_wrong": [], "grounded": [0, 0], "dollars": 0.0, "seconds": 0.0, "errors": 0})
        s["docs"] += 1
        s["pages"] += r.get("pages", 0)
        s["dollars"] += r.get("dollars", 0.0)
        s["seconds"] += r.get("seconds", 0.0)
        s["errors"] += r.get("call_errors", 0)
        c = r.get("compare")
        if not c:
            continue
        for k in ("truth", "found", "missed", "invented"):
            s[k] += c["truth_rows" if k == "truth" else k]
        for f in c["fields"]:
            acc = s["fields"].setdefault(f["field"], [0, 0, 0])
            acc[{"exact": 0, "close": 1, "wrong": 2}[f["result"]]] += 1
            if f["confidence"] is not None:
                for lo, b in BUCKETS:
                    if f["confidence"] >= lo:
                        s["buckets"][b][0] += 1
                        s["buckets"][b][1] += f["result"] != "exact"
                        break
                if f["confidence"] >= 0.99 and f["result"] != "exact":
                    s["high_conf_wrong"].append({k: f[k] for k in ("field", "got", "want", "confidence")})
            if f["grounded"] is not None:
                s["grounded"][0] += 1
                s["grounded"][1] += bool(f["grounded"])
    return out


def report(summary):
    """The summary as Markdown."""
    lines = []
    for (kind, mode), s in sorted(summary.items()):
        lines.append(f"\n### {kind} · {mode}\n")
        lines.append(f"{s['docs']} documents, {s['pages']} pages · rows: {s['truth']} on record, {s['found']} found, {s['missed']} missed, {s['invented']} not on record · "
                     f"${s['dollars']:.4f} (${s['dollars'] / max(s['docs'], 1):.4f} a document) · {s['seconds']:.1f} s ({s['seconds'] / max(s['docs'], 1):.1f} s a document)"
                     + (f" · {s['errors']} failed calls" if s["errors"] else ""))
        if s["fields"]:
            lines.append("\n| Field | Exact | Close | Wrong | Exact % |\n|---|---|---|---|---|")
            for f, (e, c, w) in s["fields"].items():
                n = e + c + w
                lines.append(f"| {f} | {e} | {c} | {w} | {100 * e / n:.1f}% |")
        if any(n for n, _ in s["buckets"].values()):
            lines.append("\n| Confidence | Fields | Not exact | Error rate |\n|---|---|---|---|")
            for _, b in BUCKETS:
                n, w = s["buckets"][b]
                lines.append(f"| {b} | {n} | {w} | {(100 * w / n) if n else 0:.1f}% |")
        if s["grounded"][0]:
            lines.append(f"\nSpans: {s['grounded'][1]} of {s['grounded'][0]} text answers point at exactly that text.")
        if s["high_conf_wrong"]:
            lines.append(f"\nWrong at confidence ≥ 0.99 ({len(s['high_conf_wrong'])}): " + "; ".join(f"{x['field']}: {x['got']!r} for {x['want']!r}" for x in s["high_conf_wrong"][:8]))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Documents and their records

def pick(rows, n, rng):
    rows = list(rows)
    return rng.sample(rows, min(n, len(rows)))


def documents(args, rng):
    q = lambda sql: T.d1(args, command=sql)  # noqa: E731
    docs = []
    if "278t" in args.kinds:
        rows = q("SELECT r.id, r.report_url, r.official_id, o.office FROM trade_reports r LEFT JOIN officials o ON o.id = r.official_id WHERE r.chamber = 'us-executive' AND r.parsed = 1 AND r.paper = 0")
        pres = [r for r in rows if str(r.get("office") or "").startswith("President")]
        chosen = pick(pres, args.limit, rng)
        chosen += pick([r for r in rows if r not in pres], args.limit - len(chosen), rng)
        for r in chosen:
            want = q(f"SELECT n, transaction_date AS date, type, amount, asset_name AS asset, owner FROM trades WHERE report_id = '{r['id']}' ORDER BY n")
            docs.append({"kind": "278t", "id": r["id"], "url": r["report_url"], "want": want})
    if "house" in args.kinds:
        rows = q("SELECT id, report_url FROM trade_reports WHERE chamber = 'us-house' AND parsed = 1 AND paper = 0 AND trade_count BETWEEN 1 AND 15")
        for r in pick(rows, args.house, rng):
            want = q(f"SELECT n, transaction_date AS date, type, amount, asset_name AS asset, owner FROM trades WHERE report_id = '{r['id']}' ORDER BY n")
            docs.append({"kind": "house", "id": r["id"], "url": r["report_url"], "want": want})
    if "annual" in args.kinds:
        rows = q("SELECT id, source, report_url FROM networth_reports WHERE status = 'read' AND method = 'text' AND source IN ('house', 'oge') AND assets BETWEEN 3 AND 40")
        chosen = pick([r for r in rows if r["source"] == "house"], 3, rng) + pick([r for r in rows if r["source"] == "oge"], 2, rng)
        for r in chosen:
            docs.append({"kind": "annual", "id": r["id"], "url": r["report_url"], "source": r["source"], "want": None})  # read from the PDF's text below
    if "agenda" in args.kinds:
        rows = q("SELECT m.id, m.agenda_url FROM meetings m WHERE m.agenda_url LIKE 'http%' AND (SELECT COUNT(*) FROM meeting_items i WHERE i.meeting_id = m.id) BETWEEN 3 AND 40")
        for r in pick(rows, 5, rng):
            want = q(f"SELECT number, title FROM meeting_items WHERE meeting_id = '{r['id']}' ORDER BY sort")
            docs.append({"kind": "agenda", "id": r["id"], "url": r["agenda_url"], "want": want})
    return docs


def annual_truth(source, text):
    """The asset and liability lines tools/networth.py reads from the text layer: the published figures' source."""
    read = N.read_house(text) if source == "house" else N.read_oge(text)
    return [{"name": x["name"], "value": x["value"]} for x in read["assets"] + read["liabilities"]]


def pages(pdf, workdir):
    """Each page (up to MAX_PAGES) as (png bytes, its text layer)."""
    subprocess.run(["pdftoppm", "-r", str(DPI), "-png", "-l", str(MAX_PAGES), str(pdf), str(Path(workdir) / "p")], check=True, capture_output=True)
    out = []
    for png in sorted(Path(workdir).glob("p-*.png")):
        n = int(re.search(r"-(\d+)\.png$", png.name).group(1))
        text = subprocess.run(["pdftotext", "-layout", "-f", str(n), "-l", str(n), str(pdf), "-"], capture_output=True, text=True).stdout
        out.append((png.read_bytes(), text))
    return out


# ---------------------------------------------------------------------------
# The models

def clairic(account, token, kind, png=None, text=None):
    body = {"model": "clairic", "state": text or "", "fields": fields_for(kind), "options": {"return_state_text": True}}
    if png is not None:
        body["images"] = [{"content_type": "image/png", "base64": base64.b64encode(png).decode()}]
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{MODEL}", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": UA})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.loads(r.read().decode())
    res = data.get("result", data)
    return res, time.time() - t0


CLAUDE_PROMPT = """Transcribe the {table} table on this page image for a public record. Accuracy matters more than completeness: never guess a value you can't read; leave it out. One object per row, top to bottom, skipping headings, each value exactly as written. Return JSON: {{"rows": [{fields}]}}"""


def claude(client, model, kind, png):
    names = list(ROW_FIELDS[kind])
    prompt = CLAUDE_PROMPT.format(table=TABLE[kind], fields="{" + ", ".join(f'"{n}": "..."' for n in names) + "}")
    schema = {"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {n: {"type": ["string", "null"]} for n in names}, "required": names, "additionalProperties": False}}},
              "required": ["rows"], "additionalProperties": False}
    t0 = time.time()
    msg = client.messages.create(model=model, max_tokens=8000, output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
                                 messages=[{"role": "user", "content": [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(png).decode()}}, {"type": "text", "text": prompt}]}])
    rows = json.loads("".join(b.text for b in msg.content if b.type == "text")).get("rows", [])
    pin, pout = CLAUDE.get(model, (5.0, 25.0))
    dollars = (msg.usage.input_tokens * pin + msg.usage.output_tokens * pout) / 1e6
    return [{n: {"value": r.get(n), "confidence": None, "grounded": None} for n in names} for r in rows], dollars, time.time() - t0


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kinds", default="278t,house,annual,agenda")
    ap.add_argument("--modes", default="image,text", help="image (each page as a picture), text (its text layer as the state)")
    ap.add_argument("--limit", type=int, default=5, help="278-T reports")
    ap.add_argument("--house", type=int, default=10, help="House PTRs")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--claude-dollars", type=float, default=0.0)
    ap.add_argument("--out", default="clairic-pilot.json")
    ap.add_argument("--database", default="pillory")
    args = ap.parse_args()
    args.kinds = set(args.kinds.split(","))
    modes = [m for m in args.modes.split(",") if m]
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token = os.environ.get("CLOUDFLARE_AI_TOKEN") or os.environ["CLOUDFLARE_API_TOKEN"]
    client = None
    if args.claude_dollars > 0:
        import anthropic  # noqa: PLC0415
        client = anthropic.Anthropic()
    rng = random.Random(args.seed)
    docs = documents(args, rng)
    print(f"{len(docs)} documents: " + ", ".join(f"{k} {sum(d['kind'] == k for d in docs)}" for k in ("278t", "house", "annual", "agenda")), flush=True)
    results, claude_spent = [], 0.0
    for d in docs:
        with tempfile.TemporaryDirectory() as tmp:
            try:
                pdf = Path(tmp) / "doc.pdf"
                pdf.write_bytes(T.get(d["url"]))
                pgs = pages(pdf, tmp)
                if d["kind"] == "annual":
                    d["want"] = annual_truth(d["source"], T.pdf_text(pdf.read_bytes()))
            except Exception as e:  # noqa: BLE001
                print(f"  {d['kind']} {d['id']}: not read ({e})", flush=True)
                continue
        print(f"- {d['kind']} {d['id']}: {len(pgs)} pages, {len(d['want'])} rows on record", flush=True)
        for mode in modes:
            got, raw, dollars, secs, errs = [], [], 0.0, 0.0, 0
            for png, text in pgs:
                if mode == "text" and not text.strip():
                    continue
                try:
                    res, s = clairic(account, token, d["kind"], png=png if mode == "image" else None, text=text if mode == "text" else None)
                except urllib.error.HTTPError as e:
                    errs += 1
                    raw.append({"error": f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}"})
                    if e.code in (401, 403):
                        raise SystemExit(f"Workers AI refused the token (HTTP {e.code}). Give CLOUDFLARE_AI_TOKEN the Workers AI permission.")
                    continue
                except Exception as e:  # noqa: BLE001
                    errs += 1
                    raw.append({"error": str(e)[:300]})
                    continue
                secs += s
                dollars += (res.get("usage") or {}).get("input_tokens", 0) * PRICE_PER_M / 1e6
                got += rows_from_answers(d["kind"], res.get("answers") or {}, res.get("state_text"))
                raw.append({"usage": res.get("usage"), "truncated": res.get("truncated"), "rows_said": (res.get("answers") or {}).get("rows", {}).get("value")})
            results.append({"kind": d["kind"], "mode": f"clairic-{mode}", "id": d["id"], "pages": len(pgs), "dollars": dollars, "seconds": secs, "call_errors": errs,
                            "compare": compare(d["kind"], got, d["want"]), "calls": raw})
        if client:
            for model in CLAUDE:
                if claude_spent >= args.claude_dollars:
                    break
                got, dollars, secs, partial = [], 0.0, 0.0, False
                for png, _ in pgs:
                    if claude_spent + dollars >= args.claude_dollars:
                        partial = True  # stopped inside the document: not scored, since its later rows would count as missed
                        break
                    rows, c, s = claude(client, model, d["kind"], png)
                    got += rows
                    dollars += c
                    secs += s
                claude_spent += dollars
                if partial:
                    print(f"  {model}: stopped at the ${args.claude_dollars} cap inside this document; not scored", flush=True)
                    continue
                results.append({"kind": d["kind"], "mode": model, "id": d["id"], "pages": len(pgs), "dollars": dollars, "seconds": secs, "compare": compare(d["kind"], got, d["want"])})
    summary = summarize(results)
    md = report(summary)
    print(md)
    Path(args.out).write_text(json.dumps({"results": results, "summary": {f"{k}|{m}": v for (k, m), v in summary.items()}}, indent=1, default=str))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write("## Clairic pilot\n" + md + "\n")


if __name__ == "__main__":
    main()
