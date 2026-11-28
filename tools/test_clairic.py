#!/usr/bin/env python3
"""
Test Clairic: a read-only check of Cloudflare's Clairic extraction model
(@cf/cloudflare/clairic, Workers AI) on documents ThePillory has already read
and published, for one task at a time. Writes nothing to D1 or the site; the
report goes to the job summary and test-clairic.json.

  trades    random House Periodic Transaction Reports published from their text
            layer (known-good rows). Per transaction: asset, ticker, type,
            transaction date, notification date, amount range, owner, compared
            with the published rows (the notification date isn't stored, so it
            comes from the same text-layer lines the loader read).
  networth  annual financial disclosure reports read in full from their text
            layer (House and OGE): each asset and liability line with its value
            range, compared with the lines tools/networth.py reads from that text,
            the parser behind the published figures.
  agendas   Calaveras County agenda PDFs: the public comment instructions, which
            must come back as a span of the agenda's text, compared with what the
            sync stored from the same PDF (meetings.comment_text).

Each PDF is sent as its pages (as images, up to 4 a call, Clairic's limit) with
those pages' text layer as the state, so every text answer's span can be
checked against the text. This is the request shape the Clairic pilot
(tools/clairic_pilot.py) used against the live API.

Reported: exact-match rate per field, rows missed and invented, nulls, the
confidence of right and wrong answers, spans, tokens and dollars (input only:
$0.10 a million tokens until December 1, 2026, $0.24 after), and the same task's
current Claude cost from ai_usage (scanned net worth reports are read in
GitHub Actions and counted in networth_scans instead).

  python3 tools/test_clairic.py --task trades --sample 50

Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (D1 and Workers AI: Read).
Needs pdftoppm and pdftotext (poppler-utils). The token is never printed.
"""
import argparse
import base64
import datetime
import json
import os
import random
import re
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clairic_pilot as P  # noqa: E402
import load_trades as T  # noqa: E402

MODEL = P.MODEL
PRICE_CHANGE = datetime.date(2026, 12, 1)
PRICE_BEFORE, PRICE_AFTER = 0.10, 0.24  # dollars per million input tokens; no output charge
IMAGES_PER_CALL = 4
MAX_PAGES = 24
NO_PERMISSION = 'The Cloudflare token can\'t use Workers AI: add "Workers AI: Read" to CLOUDFLARE_API_TOKEN (Cloudflare dashboard → My Profile → API Tokens).'
DEFAULT_SAMPLE = {"trades": 50, "networth": 20, "agendas": 20}

TRADE_FIELDS = {
    "asset": ("text", "the asset's description exactly as written"),
    "ticker": ("text", "the ticker symbol, if the row gives one (often in parentheses after the asset)"),
    "type": ("text", "the transaction type exactly as written (P, S, S (partial), E)"),
    "date": ("date", "the transaction date"),
    "notified": ("date", "the notification date"),
    "amount": ("text", "the amount range exactly as written (for example $1,001 - $15,000)"),
    "owner": ("text", "the owner code exactly as written (SP, JT, DC), or nothing if the row gives none"),
}
LINE_FIELDS = {
    "name": ("text", "the asset's or liability's description exactly as written"),
    "value": ("text", "its value or amount range exactly as written (for example $1,001 - $15,000, None (or less than $1,001), Over $50,000,000)"),
}
COMMENT_FIELD = {"comment": {"type": "text", "instructions": "The agenda's instructions to the public on how to comment or submit public comment, copied exactly as written (a passage of the text)."}}
FIELDS = {"trades": TRADE_FIELDS, "networth": LINE_FIELDS}
TABLE = {"trades": "transactions", "networth": "assets or liabilities"}
KEY = {"trades": "asset", "networth": "name"}


def price_per_m(day=None):
    return PRICE_AFTER if (day or datetime.date.today()) >= PRICE_CHANGE else PRICE_BEFORE


# ---------------------------------------------------------------------------
# The request (pure)

def row_fields(task, slots):
    """A row count, then each row's typed fields, numbered: r01.asset, r01.ticker, ..."""
    out = {"rows": {"type": "number", "integer": True, "instructions": f"How many {TABLE[task]} rows these pages list (0 if none)"}}
    for i in range(1, slots + 1):
        for name, (typ, what) in FIELDS[task].items():
            out[f"r{i:02}.{name}"] = {"type": typ, "instructions": f"Row {i} of the {TABLE[task]} on these pages, counting from the top and skipping headings: {what}"}
    return out


def body(fields, pngs, text):
    return {"model": "clairic", "state": text or "", "fields": fields, "options": {"return_state_text": True},
            "images": [{"content_type": "image/png", "base64": base64.b64encode(p).decode()} for p in pngs]}


def answer(a, state_text):
    """One answer: value, confidence, and whether its span is exactly that text (None when there's no span)."""
    a = a or {}
    span, value = a.get("span"), a.get("value")
    grounded = None
    if span and state_text is not None and value is not None:
        grounded = state_text[span[0]:span[1]] == str(value)
    return {"value": value, "confidence": a.get("confidence"), "span": span, "grounded": grounded}


def rows_from(task, answers, slots, state_text):
    rows = []
    for i in range(1, slots + 1):
        row = {name: answer(answers.get(f"r{i:02}.{name}"), state_text) for name in FIELDS[task]}
        if row[KEY[task]]["value"] not in (None, ""):
            rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# Comparing (pure)

def same(task, name, got, want):
    """'exact' or 'wrong' ('null' when Clairic gave nothing for a value the record states)."""
    if name == "owner":
        return "exact" if T.owner_label(got or "") == want else ("null" if got in (None, "") and want != "Self" else "wrong")
    if got in (None, ""):
        return "null"
    if name == "ticker":
        return "exact" if str(got).strip().strip("()").upper() == str(want).upper() else "wrong"
    if name == "notified":
        return "exact" if str(got)[:10] == str(want) else "wrong"
    mapped = {"date": "date", "type": "type", "amount": "amount", "value": "value"}.get(name)
    if mapped:
        return "exact" if P.same_field("house" if task == "trades" else "annual", mapped, got, want) == "exact" else "wrong"
    return "exact" if T.norm(got) == T.norm(want) else "wrong"


def align(task, got, want):
    kind = "house" if task == "trades" else "annual"
    g = [{("asset" if task == "trades" else "name"): r[KEY[task]]} for r in got]
    w = [{("asset" if task == "trades" else "name"): x[KEY[task]]} for x in want]
    return P.align(kind, g, w)


def compare_rows(task, got, want):
    pairs, missed, invented = align(task, got, want)
    fields = []
    for gi, wi in pairs:
        for name in FIELDS[task]:
            want_v = want[wi].get(name)
            if want_v in (None, "") and name != "ticker":
                continue
            if name == "ticker" and want_v in (None, ""):
                # No ticker on record: right only if Clairic gives none either.
                g = got[gi][name]
                fields.append({"field": name, "result": "exact" if g["value"] in (None, "") else "wrong", "confidence": g["confidence"], "grounded": g["grounded"], "got": g["value"], "want": None})
                continue
            g = got[gi][name]
            fields.append({"field": name, "result": same(task, name, g["value"], want_v), "confidence": g["confidence"], "grounded": g["grounded"], "got": g["value"], "want": want_v})
    return {"truth": len(want), "found": len(pairs), "missed": len(missed), "invented": len(invented), "fields": fields,
            "invented_rows": [{k: v["value"] for k, v in got[i].items()} for i in invented][:5]}


def squash(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def compare_comment(got, want):
    """The comment instructions: exact (same words), part (one holds the other), wrong, or null. A value that isn't a span of the text is wrong."""
    g, w = squash(got["value"]), squash(want)
    if not g:
        result = "null" if w else "exact"
    elif got["grounded"] is False or not got["span"]:
        result = "not a span"
    elif g == w:
        result = "exact"
    elif w and (g in w or w in g):
        result = "part"
    else:
        result = "wrong"
    return {"truth": 1 if w else 0, "found": int(bool(g) and bool(w)), "missed": int(bool(w) and not g), "invented": int(bool(g) and not w),
            "fields": [{"field": "comment", "result": result, "confidence": got["confidence"], "grounded": got["grounded"], "got": got["value"], "want": want}]}


def notification_dates(text):
    """Each transaction's notification date, in order, from the text-layer lines tools/load_trades.py reads."""
    return [T.iso(m.group("ndate")) for m in (T.ROW.match(ln.rstrip()) for ln in str(text or "").splitlines()) if m]


def summarize(results):
    s = {"docs": 0, "pages": 0, "calls": 0, "failed": 0, "truth": 0, "found": 0, "missed": 0, "invented": 0, "tokens": 0, "seconds": 0.0,
         "fields": {}, "conf": {"right": [], "wrong": []}, "spans": [0, 0], "examples": []}
    for r in results:
        s["docs"] += 1
        for k in ("pages", "calls", "failed", "tokens"):
            s[k] += r.get(k, 0)
        s["seconds"] += r.get("seconds", 0.0)
        c = r.get("compare")
        if not c:
            continue
        for k in ("truth", "found", "missed", "invented"):
            s[k] += c[k]
        for f in c["fields"]:
            acc = s["fields"].setdefault(f["field"], {})
            acc[f["result"]] = acc.get(f["result"], 0) + 1
            if f["confidence"] is not None and f["result"] != "null":
                s["conf"]["right" if f["result"] == "exact" else "wrong"].append(f["confidence"])
            if f["grounded"] is not None:
                s["spans"][0] += 1
                s["spans"][1] += bool(f["grounded"])
            if f["result"] not in ("exact", "null") and len(s["examples"]) < 10:
                s["examples"].append({k: f[k] for k in ("field", "got", "want", "confidence")})
    return s


def conf_line(xs):
    if not xs:
        return "none"
    return f"{len(xs)} answers · mean {statistics.mean(xs):.3f} · median {statistics.median(xs):.3f} · {sum(x >= 0.99 for x in xs)} at ≥ 0.99"


def report(task, s, claude, day=None):
    p = price_per_m(day)
    dollars_now = s["tokens"] * p / 1e6
    lines = [f"## Test Clairic · {task}", "",
             f"{s['docs']} documents, {s['pages']} pages, {s['calls']} calls" + (f" ({s['failed']} failed)" if s["failed"] else "") + f", {s['seconds']:.0f} s.",
             f"Rows: {s['truth']} on record, {s['found']} found, **{s['missed']} missed**, **{s['invented']} invented** (not on record).", "",
             "| Field | Exact | Not exact | Null | Exact % |", "|---|---|---|---|---|"]
    for f, acc in s["fields"].items():
        n = sum(acc.values())
        not_exact = n - acc.get("exact", 0) - acc.get("null", 0)
        detail = ", ".join(f"{k} {v}" for k, v in acc.items() if k not in ("exact", "null", "wrong"))
        lines.append(f"| {f} | {acc.get('exact', 0)} | {not_exact}{f' ({detail})' if detail else ''} | {acc.get('null', 0)} | {100 * acc.get('exact', 0) / n:.1f}% |")
    lines += ["", f"Confidence of right answers: {conf_line(s['conf']['right'])}.", f"Confidence of wrong answers: {conf_line(s['conf']['wrong'])}."]
    if s["spans"][0]:
        lines.append(f"Spans: {s['spans'][1]} of {s['spans'][0]} answers point at exactly that text.")
    lines += ["", f"Tokens: {s['tokens']:,} input. Dollars: ${s['tokens'] * PRICE_BEFORE / 1e6:.4f} at $0.10 a million (until Dec 1, 2026), "
              f"${s['tokens'] * PRICE_AFTER / 1e6:.4f} at $0.24 a million (from Dec 1); this run at ${p:.2f}: ${dollars_now:.4f}, "
              f"${dollars_now / max(s['docs'], 1):.5f} a document."]
    if claude:
        lines += ["", f"Current Claude cost for this task: {claude}"]
    if s["examples"]:
        lines += ["", "Some answers that didn't match: " + "; ".join(f"{e['field']}: {e['got']!r} for {e['want']!r} ({e['confidence']})" for e in s["examples"])]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# D1 and documents

def q(args, sql):
    return T.d1(args, command=sql)


def documents(args, rng):
    if args.task == "trades":
        rows = q(args, "SELECT id, report_url FROM trade_reports WHERE chamber = 'us-house' AND parsed = 1 AND paper = 0 AND trade_count BETWEEN 1 AND 20")
        out = []
        for r in P.pick(rows, args.sample, rng):
            want = q(args, f"SELECT n, asset_name AS asset, ticker, type, transaction_date AS date, amount, owner FROM trades WHERE report_id = '{r['id']}' ORDER BY n")
            out.append({"id": r["id"], "url": r["report_url"], "want": want})
        return out
    if args.task == "networth":
        rows = q(args, "SELECT id, source, report_url FROM networth_reports WHERE status = 'read' AND method = 'text' AND source IN ('house', 'oge') AND assets + COALESCE(liabilities, 0) BETWEEN 1 AND 40")
        return [{"id": r["id"], "url": r["report_url"], "source": r["source"], "want": None} for r in P.pick(rows, args.sample, rng)]
    rows = q(args, "SELECT id, agenda_url, comment_text FROM meetings WHERE level = 'county' AND agenda_url LIKE 'http%'")
    return [{"id": r["id"], "url": r["agenda_url"], "want": r["comment_text"]} for r in P.pick(rows, args.sample, rng)]


def claude_cost(args):
    """The same task's current Claude cost, last 30 days."""
    if args.task == "networth":
        r = q(args, "SELECT COUNT(*) AS n, ROUND(SUM(cost_cents) / 100.0, 2) AS usd FROM networth_scans WHERE read_at >= date('now', '-30 days')")
        r = r[0] if r else {}
        return (f"scanned reports read by the two-model method in GitHub Actions (networth_scans, not ai_usage), last 30 days: {r.get('n') or 0} reports, ${r.get('usd') or 0}"
                + (f", ${(r.get('usd') or 0) / r['n']:.2f} a report." if r.get("n") else "."))
    step, what = {"trades": ("scanned-trades", "scanned trade reports read by two models"),
                  "agendas": ("agenda-watch", "agenda item summaries; the comment instructions themselves are read by code, with no AI")}[args.task]
    r = q(args, f"SELECT SUM(calls) AS calls, SUM(input_tokens) AS input_tokens, ROUND(SUM(cost_usd), 2) AS usd FROM ai_usage WHERE step = '{step}' AND day >= date('now', '-30 days')")
    r = r[0] if r else {}
    calls = r.get("calls") or 0
    return (f"ai_usage step `{step}` ({what}), last 30 days: {calls} calls, {r.get('input_tokens') or 0:,} input tokens, ${r.get('usd') or 0}"
            + (f", ${(r.get('usd') or 0) / calls:.4f} a call." if calls else "."))


def pdf_pages(pdf, workdir):
    """Each page (up to MAX_PAGES) as (png, text layer)."""
    subprocess.run(["pdftoppm", "-r", str(P.DPI), "-png", "-l", str(MAX_PAGES), str(pdf), str(Path(workdir) / "p")], check=True, capture_output=True)
    out = []
    for png in sorted(Path(workdir).glob("p-*.png"), key=lambda x: int(re.search(r"-(\d+)\.png$", x.name).group(1))):
        n = int(re.search(r"-(\d+)\.png$", png.name).group(1))
        text = subprocess.run(["pdftotext", "-layout", "-f", str(n), "-l", str(n), str(pdf), "-"], capture_output=True, text=True).stdout
        out.append((png.read_bytes(), text))
    return out


def call(account, token, payload):
    """One Clairic call → (result, seconds). A refused token stops the run with one line; the token is never printed."""
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{MODEL}", data=json.dumps(payload).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": P.UA})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise SystemExit(NO_PERMISSION) from None
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from None
    return data.get("result", data), time.time() - t0


def read_doc(args, account, token, d, pgs):
    """Send the document's pages, IMAGES_PER_CALL at a time; returns rows (or the comment answer) and the counts."""
    out = {"pages": len(pgs), "calls": 0, "failed": 0, "tokens": 0, "seconds": 0.0}
    got, comment = [], None
    chunks = [pgs[i:i + IMAGES_PER_CALL] for i in range(0, len(pgs), IMAGES_PER_CALL)]
    if args.task == "agendas":
        chunks = chunks[:2]  # the instructions are near the front of an agenda: its first 8 pages
    for chunk in chunks:
        text = "\n\f".join(t for _, t in chunk)
        fields = COMMENT_FIELD if args.task == "agendas" else row_fields(args.task, args.slots)
        try:
            res, secs = call(account, token, body(fields, [p for p, _ in chunk], text))
        except RuntimeError as e:
            out["failed"] += 1
            print(f"  {d['id']}: call failed ({e})", flush=True)
            continue
        out["calls"] += 1
        out["seconds"] += secs
        out["tokens"] += (res.get("usage") or {}).get("input_tokens", 0)
        answers, state_text = res.get("answers") or {}, res.get("state_text", text)
        if args.task == "agendas":
            a = answer(answers.get("comment"), state_text)
            if a["value"] not in (None, "") and (comment is None or comment["value"] in (None, "")):
                comment = a
        else:
            got += rows_from(args.task, answers, args.slots, state_text)
    if args.task == "agendas":
        out["compare"] = compare_comment(comment or {"value": None, "confidence": None, "span": None, "grounded": None}, d["want"])
    else:
        out["compare"] = compare_rows(args.task, got, d["want"])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--task", required=True, choices=["trades", "networth", "agendas"])
    ap.add_argument("--sample", type=int, default=0, help="documents (default: 50 trades, 20 networth, 20 agendas)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="test-clairic.json")
    ap.add_argument("--database", default="pillory")
    args = ap.parse_args()
    args.sample = args.sample or DEFAULT_SAMPLE[args.task]
    args.slots = {"trades": 20, "networth": 25, "agendas": 0}[args.task]
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    rng = random.Random(args.seed)
    docs = documents(args, rng)
    print(f"{len(docs)} {args.task} documents (seed {args.seed})", flush=True)
    results = []
    for d in docs:
        with tempfile.TemporaryDirectory() as tmp:
            try:
                pdf = Path(tmp) / "doc.pdf"
                pdf.write_bytes(T.get(d["url"]))
                pgs = pdf_pages(pdf, tmp)
                text = T.pdf_text(pdf.read_bytes())
            except Exception as e:  # noqa: BLE001
                print(f"- {d['id']}: not read ({str(e)[:200]})", flush=True)
                continue
        if args.task == "trades":
            nd = notification_dates(text)
            if len(nd) == len(d["want"]):
                for row, n in zip(d["want"], nd):
                    row["notified"] = n
        if args.task == "networth":
            d["want"] = P.annual_truth(d["source"], text)
        r = read_doc(args, account, token, d, pgs)
        r["id"] = d["id"]
        results.append(r)
        c = r["compare"]
        print(f"- {d['id']}: {r['pages']} pages · {c['truth']} on record, {c['found']} found, {c['missed']} missed, {c['invented']} invented", flush=True)
    s = summarize(results)
    md = report(args.task, s, claude_cost(args))
    print(md)
    Path(args.out).write_text(json.dumps({"task": args.task, "results": results, "summary": s}, indent=1, default=str))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
