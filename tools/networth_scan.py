"""
"Net worth, as reported" from scanned OGE Form 278e reports (docs/funding.md,
"Net worth"; migration 0037). The text loader (tools/load_networth.py) leaves
a scanned report as a link; this reads one with AI, the way scanned stock
trade reports are read:

  1. The report's own OCR text layer finds the pages with assets and
     liabilities (Parts 2, 5, 6 and 8, and the schedules attached to them);
     the rest (transactions, gifts, exhibits) isn't sent.
  2. Two different models (SCAN_MODEL_A, SCAN_MODEL_B) each read those pages,
     a few at a time, and copy every line's value exactly. Each chunk's
     reading is kept in D1 (networth_scan_chunks), so a run that stops
     resumes where it left off.
  3. Code compares the readings line by line (networth.compare_readings),
     applies the same rules as the text reader (networth.report_from_lines)
     and checks every value against the page's OCR text.
  4. All lines agree: the report publishes into networth_reports (method
     'ai'), labeled "Transcribed by AI from a scanned report, auto-checked",
     and goes on /admin/review/networth/ for a person to check. Any line
     that doesn't: nothing publishes; a person settles each line there, and
     the next run (--mode publish) publishes with "Checked by [name]".

Spending is capped: --max-dollars stops the run before a call that could go
past it. --mode estimate counts the input tokens (free) and prints the
expected cost without reading anything.

  python3 tools/networth_scan.py --mode estimate
  python3 tools/networth_scan.py --mode read --max-dollars 15
  python3 tools/networth_scan.py --mode publish

These records may not be used for commercial purposes (Ethics in Government
Act): never sell, export or put them behind a paid plan.
"""
import argparse
import base64
import datetime
import json
import os
import random
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_trades as T  # noqa: E402  (fetching, D1)
import load_networth as L  # noqa: E402
import networth as N  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "workers" / "sync" / "migrations"
# $ per million tokens (input, output), for the cap and the estimate.
PRICES = {"claude-sonnet-5-5": (2.0, 10.0), "claude-opus-5-5": (4.0, 20.0)}
WANTED = {"2", "5", "6", "8"}  # Parts with assets (2, 5, 6) and liabilities (8)
OUT_TOKENS_PER_LINE = 22       # one compact line ("848|L|12|$1,001 - $15,000|I|"), for the estimate

INSTRUCTIONS = """You transcribe the asset and liability tables of a scanned U.S. Office of Government Ethics Form 278e (financial disclosure report) for a public record. Accuracy matters more than completeness: a wrong value would be published as fact.

You get a few pages of the report. For each page, top to bottom, give one entry per table line, in order, as a single string:
  "<page>|L|<line number>|<value>|<flags>|<creditor>"
and, where an unnumbered heading groups the lines under it (for example "INVESTMENT ACCOUNT #1"), one entry before them:
  "<page>|H|<heading as printed>"

- <page>: the page number you are told, not the number printed on the page.
- A table line is a numbered line, or a line with its own value even without a number. A description that runs onto more lines is one line. Leave out column headings, page headers and footers, instructions, signatures and stamps.
- <line number>: exactly as printed ("2", "2.1", "13.4.2"); empty if none.
- <value>: the Value column (in Part 8, Liabilities: the Amount column), character for character as printed: "$1,001 - $15,000", "Over $50,000,000", "None (or less than $1,001)". A value printed over two lines is one value ("$1,000,001 - $5,000,000"). Empty if the cell is empty. Never put an income amount here.
- <flags>: any of these letters, no spaces: I if the line's income type or income amount cell has anything in it; E if the line says its value is reported elsewhere ("See attached Schedule 1", "value reported at Line 13"); N if it says its value is not readily ascertainable; U if any cell you transcribed is hard to read (blurred, cut off, overwritten), and then say which in "notes".
- <creditor>: only in Part 8: the creditor's name and the type of liability, as printed; empty otherwise.
- Do not correct, complete, round or reformat anything. Never guess silently: mark U.
- A page with no such table gives no entries."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["lines", "notes"],
    "properties": {"lines": {"type": "array", "items": {"type": "string"}}, "notes": {"type": "string"}},
}


def models():
    return [os.environ.get("SCAN_MODEL_A") or "claude-sonnet-5-5", os.environ.get("SCAN_MODEL_B") or "claude-opus-5-5"]


def cost(model, inp, out):
    pin, pout = PRICES.get(model, (5.0, 25.0))  # an unknown model: priced high, so the cap holds
    return (inp * pin + out * pout) / 1e6


# ---------------------------------------------------------------------------
# Pages


PART = re.compile(r"Part\s+(\d)\s*:", re.I)
SCHEDULE = re.compile(r"Schedule\s+(\w+)\s+for\s+Part\s+(\d)", re.I)


def page_sections(page_texts):
    """{pdf page: section} for the pages to read: 'Part 6', 'Schedule 1 for Part 2'. A page without a heading continues the one before."""
    out, cur = {}, None
    for i, t in enumerate(page_texts, 1):
        head = "\n".join(t.split("\n")[:25])
        s = SCHEDULE.search(head)
        m = PART.search(head)
        if s:
            cur = (f"Schedule {s.group(1)} for Part {s.group(2)}", s.group(2))
        elif m:
            cur = (f"Part {m.group(1)}", m.group(1))
        elif re.search(r"\bExhibit\b|\bEndnotes?\b", head, re.I):
            cur = None
        if cur and cur[1] in WANTED:
            out[i] = cur[0]
    return out


def chunks(pages, size):
    """Runs of consecutive pages, at most `size` each: [(first, last)]."""
    out, run = [], []
    for p in sorted(pages):
        if run and (p != run[-1] + 1 or len(run) >= size):
            out.append((run[0], run[-1]))
            run = []
        run.append(p)
    if run:
        out.append((run[0], run[-1]))
    return out


def chunk_pdf(path, first, last, workdir):
    out = Path(workdir) / f"pages-{first}-{last}.pdf"
    if not out.exists():
        parts = []
        for p in range(first, last + 1):
            one = Path(workdir) / f"p{p}.pdf"
            subprocess.run(["pdfseparate", "-f", str(p), "-l", str(p), str(path), str(one)], check=True)
            parts.append(str(one))
        subprocess.run(["pdfunite", *parts, str(out)], check=True) if len(parts) > 1 else os.replace(parts[0], out)
    return base64.standard_b64encode(out.read_bytes()).decode()


def message(pdf_b64, first, last, sections):
    where = "; ".join(f"page {p}: {sections[p]}" for p in range(first, last + 1))
    return [
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
        {"type": "text", "text": f"These are pages {first} to {last} of the report, in order ({where}). Transcribe their asset and liability lines, following the rules."},
    ]


def parse_lines(entries, sections, first, last, grp=None):
    """
    The model's entries -> lines {page, sec, grp, n, v, inc, elsewhere, nra,
    unsure, cred}. Entries outside the chunk are dropped. `grp` ({page:
    heading}) carries headings from one chunk into the next.
    """
    out = []
    grp = {} if grp is None else grp
    for e in entries:
        f = str(e).split("|")
        try:
            page = int(f[0].strip())
        except (ValueError, IndexError):
            continue
        if not (first <= page <= last) or page not in sections:
            continue
        kind = f[1].strip().upper() if len(f) > 1 else ""
        if kind == "H":
            grp[page] = "|".join(f[2:]).strip()
            continue
        if kind != "L":
            continue
        f += [""] * (6 - len(f))
        flags = f[4].strip().upper()
        sec = sections[page]
        m = re.search(r"Part (\d)$", sec)
        out.append({
            "page": page, "sec": m.group(1) if sec.startswith("Part") else sec, "grp": grp.get(page, next((grp[q] for q in sorted(grp, reverse=True) if q < page), "")),
            "n": f[2].strip(), "v": f[3].strip(), "inc": "I" in flags, "elsewhere": "E" in flags, "nra": "N" in flags, "unsure": "U" in flags,
            "cred": "|".join(f[5:]).strip(),
        })
    return out


# ---------------------------------------------------------------------------
# The report


def find_report(args):
    """The President's newest annual 278e that is a scan (or --report-id): the load_networth record."""
    reps = L.oge_reports(args)
    if args.report_id:
        hit = [f for f in reps if f["id"] == args.report_id]
    else:
        pres = {o["id"] for o in T.d1(args, command="SELECT id FROM officials WHERE chamber = 'us-executive' AND office LIKE 'President of the United States%'")}
        hit = sorted((f for f in reps if f["official_id"] in pres and f["kind"] == "annual" and f["url"]), key=lambda f: (f["year"], f["filed_on"] or ""))[-1:]
    if not hit:
        raise SystemExit("no such report")
    return hit[0]


def stored_chunks(args, report_id):
    try:
        rows = T.d1(args, command=f"SELECT model, first_page, last_page, reading, cost_cents FROM networth_scan_chunks WHERE report_id = {L.lit(report_id)}")
    except SystemExit:
        return {}
    return {(r["model"], r["first_page"]): r for r in rows}


def apply_migrations(args):
    for name in ("0036_networth.sql", "0037_networth_scans.sql"):
        T.d1(args, file=MIGRATIONS / name)
        T.d1(args, command=f"INSERT OR IGNORE INTO d1_migrations (name) VALUES ('{name}')")


def read_chunk(client, model, pdf_b64, first, last, sections):
    with client.messages.stream(
        model=model,
        max_tokens=64000,
        system=INSTRUCTIONS,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": message(pdf_b64, first, last, sections)}],
    ) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        raise RuntimeError(f"{model} declined to read pages {first}-{last}")
    if msg.stop_reason == "max_tokens":
        raise RuntimeError(f"{model}'s answer for pages {first}-{last} was cut off")
    data = json.loads("".join(b.text for b in msg.content if b.type == "text"))
    return data, msg.usage.input_tokens, msg.usage.output_tokens


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("estimate", "read", "publish"), default="estimate")
    ap.add_argument("--report-id", default="", help="a networth_reports id; default: the President's newest annual report")
    ap.add_argument("--max-dollars", type=float, default=15.0)
    ap.add_argument("--chunk-pages", type=int, default=6)
    ap.add_argument("--database", default="pillory")
    args = ap.parse_args()
    log = []
    say = lambda s: (print(s, flush=True), log.append(s))

    f = find_report(args)
    say(f"Report: {f['id']} ({f['official_id']}, {f['kind']} {f['year']}, filed {f['filed_on']}) {f['url']}")
    work = tempfile.mkdtemp()
    pdf = Path(work) / "report.pdf"
    pdf.write_bytes(T.get(f["url"], timeout=600))
    texts = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout.split("\f")
    sections = page_sections(texts)
    plan = chunks(sections, args.chunk_pages)
    by_sec = {}
    for p, s in sections.items():
        by_sec.setdefault(s, []).append(p)
    say(f"{len(texts)} pages; reading {len(sections)}: " + "; ".join(f"{s} (pages {min(v)}-{max(v)})" for s, v in by_sec.items()))
    est_lines = sum(len(re.findall(r"(?m)^\s*\d+(?:\.\d+)*\.?\s{2,}\S", texts[p - 1])) for p in sections)

    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ANTHROPIC_API_KEY isn't set: add it under the repository's Settings -> Secrets and variables -> Actions")
    import anthropic  # only this tool needs it (pip install anthropic in the workflow)
    client = anthropic.Anthropic()
    ms = models()

    if args.mode == "estimate":
        total = 0.0
        for model in ms:
            inp = 0
            for first, last in plan:
                inp += client.messages.count_tokens(model=model, system=INSTRUCTIONS, messages=[{"role": "user", "content": message(chunk_pdf(pdf, first, last, work), first, last, sections)}]).input_tokens
            out = int(est_lines * OUT_TOKENS_PER_LINE * 1.3)
            c = cost(model, inp, out)
            total += c
            say(f"{model}: {inp:,} input tokens (counted), about {out:,} output tokens ({est_lines:,} lines in the OCR text): about ${c:.2f}")
        say(f"Estimated total: ${total:.2f} for both readings, in {len(plan)} chunks of up to {args.chunk_pages} pages")
        return summary(log)

    apply_migrations(args)
    prior = T.d1(args, command=f"SELECT status FROM networth_scans WHERE report_id = {L.lit(f['id'])}")
    if prior and prior[0]["status"] in ("approved", "rejected"):
        say(f"A person already {'confirmed' if prior[0]['status'] == 'approved' else 'took down'} this report on /admin/review/networth/: nothing to do.")
        return summary(log)
    have = stored_chunks(args, f["id"])
    spent = sum((r.get("cost_cents") or 0) for r in have.values()) / 100
    say(f"Already read: {len(have)} of {len(plan) * len(ms)} chunks (${spent:.2f})")
    if args.mode == "read":
        for model in ms:
            for first, last in plan:
                if (model, first) in have:
                    continue
                # Stop before a call that could go past the cap (input counted, output at its likely size).
                pdf_b64 = chunk_pdf(pdf, first, last, work)
                inp = client.messages.count_tokens(model=model, system=INSTRUCTIONS, messages=[{"role": "user", "content": message(pdf_b64, first, last, sections)}]).input_tokens
                likely = cost(model, inp, 6000 * (last - first + 1))
                if spent + likely > args.max_dollars:
                    say(f"Stopped before pages {first}-{last} ({model}): ${spent:.2f} spent, the cap is ${args.max_dollars:.2f}. Run again to resume.")
                    return summary(log)
                data, i_tok, o_tok = read_chunk(client, model, pdf_b64, first, last, sections)
                c = cost(model, i_tok, o_tok)
                spent += c
                T.run_sql(args, [
                    "INSERT OR REPLACE INTO networth_scan_chunks (report_id, model, first_page, last_page, reading, input_tokens, output_tokens, cost_cents) VALUES ("
                    + ", ".join(L.lit(v) for v in (f["id"], model, first, last, json.dumps(data), i_tok, o_tok, round(c * 100))) + ");"])
                have[(model, first)] = {"model": model, "first_page": first, "last_page": last, "reading": json.dumps(data)}
                say(f"  {model} pages {first}-{last}: {len(data.get('lines', []))} entries, ${c:.2f} (total ${spent:.2f})")
    if any((m, first) not in have for m in ms for first, _ in plan):
        say("Not every chunk is read yet: nothing to compare.")
        return summary(log)

    readings = []
    for model in ms:
        lines, grp = [], {}
        for first, last in plan:
            lines += parse_lines(json.loads(have[(model, first)]["reading"]).get("lines", []), sections, first, last, grp)
        readings.append(lines)
    cmp = N.compare_readings(*readings)
    settled = {}
    try:
        row = T.d1(args, command=f"SELECT settled, reviewed_by, status FROM networth_scans WHERE report_id = {L.lit(f['id'])}")
        if row and row[0]["settled"]:
            settled = json.loads(row[0]["settled"])
    except SystemExit:
        pass
    lines, open_dis = list(cmp["lines"]), []
    for d in cmp["disagreements"]:
        choice = settled.get(d["key"])
        if choice in ("a", "b") and isinstance(d.get(choice), dict):
            lines.append({**d[choice], "idx": d["idx"], "unsure": False})
        elif choice == "a" and "lines_a" in d:
            lines += [{**x, "idx": i, "unsure": False} for i, x in enumerate(d["lines_a"])]
        elif choice == "b" and "lines_b" in d:
            lines += [{**x, "idx": i, "unsure": False} for i, x in enumerate(d["lines_b"])]
        else:
            open_dis.append(d)
    lines.sort(key=lambda x: (x["page"], x["idx"]))
    problems = []
    misses = N.ocr_misses(lines, {p: texts[p - 1] for p in sections})
    if misses:
        problems.append({"kind": "look", "text": f"{len(misses)} agreed values aren't in the page's OCR text, for example page {misses[0][0]}: {misses[0][1]}"})
    if len(misses) > max(3, 0.02 * len(lines)):
        problems.append({"kind": "block", "text": f"{len(misses)} of {len(lines)} values aren't in the pages' OCR text: the readings may have shifted."})
    total_lines = len(lines) + sum(1 for d in open_dis if "idx" in d) + sum(max(len(d.get("lines_a", [])), len(d.get("lines_b", []))) for d in open_dis if "idx" not in d)
    say(f"Compared: {len(cmp['lines'])} lines agreed, {len(cmp['disagreements'])} not ({len(open_dis)} still open after a person's choices)")
    summ, read_err = None, None
    if not open_dis:
        try:
            summ = N.summarize(N.report_from_lines(lines))
        except N.Unreadable as e:
            read_err = str(e)
            problems.append({"kind": "block", "text": read_err})
    publish = summ is not None and not any(p["kind"] == "block" for p in problems)
    checked = bool(settled) and publish
    status = "approved" if checked else "agreed" if publish else "disagree"
    if args.mode == "publish" and not settled and status != "agreed":
        say("Nothing to publish.")
    pages_json = json.dumps({s: [min(v), max(v)] for s, v in by_sec.items()})
    stmts = [
        "INSERT INTO networth_scans (report_id, official_id, report_url, year, status, pages, lines_total, disagreements, reading, problems, models, cost_cents, spot_check, read_at) VALUES ("
        + ", ".join(L.lit(v) for v in (f["id"], f["official_id"], f["url"], f["year"], status, pages_json, total_lines, json.dumps(open_dis), json.dumps(lines), json.dumps(problems), ", ".join(ms), round(spent * 100), 1))
        + ", datetime('now')) ON CONFLICT(report_id) DO UPDATE SET status = excluded.status, pages = excluded.pages, lines_total = excluded.lines_total, disagreements = excluded.disagreements, reading = excluded.reading, problems = excluded.problems, models = excluded.models, cost_cents = excluded.cost_cents, read_at = excluded.read_at;"
    ]
    if publish:
        rec = {**f, "kind": f["kind"]}
        sql = L.row_sql(rec, "read", None, "ai", summ, L.before_office(rec, {}, {}))
        stmts.append(sql)
        say(f"Published: {summ['assets']} assets, {summ['liabilities']} liabilities; {N.fmt_money(summ['low'])} to {N.fmt_money(summ['high'])}{' or more' if summ['high_open'] else ''}"
            f"{' (checked by a person)' if checked else ' (transcribed by AI, auto-checked; queued for a person)'}")
    else:
        reason = read_err or (f"Read by AI: {len(open_dis)} lines read differently; waiting for a person" if open_dis else "Read by AI: held for a person")
        stmts.append(L.row_sql(f, "scan", reason[:300], None, None, 0))
        say(f"Held: {reason}")
    for p in problems:
        say(f"  {p['kind']}: {p['text']}")
    T.run_sql(args, stmts)
    return summary(log)


def summary(log):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as fh:
            fh.write("## Scanned net worth report\n\n```\n" + "\n".join(log) + "\n```\n")


if __name__ == "__main__":
    main()
