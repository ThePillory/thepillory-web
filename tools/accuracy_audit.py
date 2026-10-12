"""
Accuracy audit: checks what ThePillory shows against its sources and writes a
report (markdown) to stdout and, in GitHub Actions, the run summary. It reads
D1 and the sources; it changes nothing.

  1. Hand-entered data: each county official, California statewide officer and
     Cabinet member, looked for on the official page it cites.
  2. Name matching: 50 matches per source (Cal-Access committees, stock trade
     reports, candidates' offices held, LD-203 honorees), compared with the
     name in the original record.
  3. Bill summaries: the summary each bill page shows (billSummary() in
     functions/_lib/bill-page.js), counted when it's empty, a short title or a
     section heading.
  4. AI content: 20 constitutional analyses (quotes against
     data/constitution.json), 20 promises and 20 Platform excerpts (quotes
     against their source pages, as stored and as live today).
  5. Freshness: the newest vote and bill per state, and Congress against
     senate.gov and the House Clerk.

  python3 tools/accuracy_audit.py > audit.md
"""
import argparse
import html as htmlmod
import json
import os
import random
import re
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_trades as T  # noqa: E402  (D1)

ROOT = Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (compatible; ThePillory accuracy audit; +https://thepillory.co)"
random.seed(20261012)
OUT = []


def say(s=""):
    OUT.append(s)
    print(s, flush=True)


def q(args, sql):
    try:
        return T.d1(args, command=sql)
    except SystemExit as e:
        say(f"> Query failed: {str(e)[:300]}")
        return []


def fetch(url, timeout=30):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml,*/*"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(4_000_000)
        return raw.decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001  (reported, not hidden)
        return f"__FETCH_FAILED__ {type(e).__name__}: {str(e)[:120]}"


def text_of(page):
    page = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", page)
    return htmlmod.unescape(re.sub(r"<[^>]+>", " ", page))


def norm(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9$%'\" ]+", " ", s.lower())).strip()


NICK = {"bill": "william", "bob": "robert", "jim": "james", "mike": "michael", "tom": "thomas", "joe": "joseph", "dan": "daniel", "dave": "david",
        "chris": "christopher", "pat": "patrick", "rick": "richard", "dick": "richard", "ted": "edward", "ed": "edward", "tim": "timothy", "steve": "steven",
        "matt": "matthew", "nick": "nicholas", "ben": "benjamin", "andy": "andrew", "tony": "anthony", "ron": "ronald", "don": "donald", "ken": "kenneth",
        "greg": "gregory", "jeff": "jeffrey", "sam": "samuel", "liz": "elizabeth", "beth": "elizabeth", "kate": "katherine", "kathy": "katherine",
        "chuck": "charles", "charlie": "charles", "jerry": "gerald", "larry": "lawrence", "jack": "john", "jon": "jonathan", "rob": "robert"}


def parts(name):
    n = norm(re.sub(r"\([^)]*\)", " ", str(name or "")))
    n = re.sub(r"\b(congressman|congresswoman|congressmember|assemblymember|assembly member|delegate|senator|sen|rep)\b", " ", n)
    n = re.sub(r"\b(jr|sr|ii|iii|iv|hon|honorable|rep|sen|senator|representative|mr|mrs|ms|dr)\b", " ", n)
    w = [x for x in n.replace(",", " ").split() if len(x) > 1 or x.isalpha()]
    return w


def first_last(name):
    """(first, last) from "First M. Last" or "Last, First M."."""
    raw = str(name or "")
    if "," in raw:
        last_part, first_part = raw.split(",", 1)
        f, l = parts(first_part), parts(last_part)
        if f and l:
            return f[0], l[-1]
    p = parts(raw)
    return (p[0], p[-1]) if len(p) >= 2 else (None, None)


def same_person(a, b):
    """First and last name agree (allowing "Last, First", a middle name and common nicknames)."""
    fa, la = first_last(a)
    fb, lb = first_last(b)
    if not (fa and fb and la and lb):
        return False
    return la == lb and (fa == fb or NICK.get(fa, fa) == NICK.get(fb, fb) or fa[0] == fb[0] and (fa.startswith(fb) or fb.startswith(fa)))


def rate(bad, total):
    return f"{bad} of {total}" + (f" ({100 * bad / total:.0f}%)" if total else "")


# ---------------------------------------------------------------------------
# 1. Hand-entered data


def name_on_page(name, page):
    t = norm(text_of(page))
    p = parts(name)
    if not p:
        return False
    last = p[-1]
    return last in t.split() and any((f in t.split()) for f in {p[0], NICK.get(p[0], p[0])})


def hand_entered(args):
    say("## 1. Hand-entered data")
    say()
    say("Each person looked for, by first and last name, on the official page their entry cites (fetched today).")
    say()
    rows = []
    for fname, label in (("data/county-officials.json", "County officials"), ("data/state-executive-officials.json", "California statewide officers")):
        data = json.loads((ROOT / fname).read_text())
        people = data.get("officials") if isinstance(data, dict) else data
        if isinstance(people, dict):
            people = list(people.values())
        for o in people or []:
            if isinstance(o, dict) and o.get("name"):
                rows.append((label, o.get("name"), o.get("office") or o.get("title") or "", o.get("source_url") or o.get("source") or ""))
    for o in q(args, "SELECT name, office, source_url FROM officials WHERE chamber = 'us-executive' AND active = 1 ORDER BY office"):
        rows.append(("Executive branch (synced from whitehouse.gov and congress-legislators)", o["name"], o["office"], o["source_url"]))
    cache, problems = {}, []
    for label, name, office, url in rows:
        if not re.match(r"https?://", url or ""):
            problems.append((label, name, office, url, "no source link"))
            continue
        if url not in cache:
            cache[url] = fetch(url)
            time.sleep(0.5)
        page = cache[url]
        if page.startswith("__FETCH_FAILED__"):
            problems.append((label, name, office, url, f"source didn't load ({page[17:]})"))
        elif not name_on_page(name, page):
            problems.append((label, name, office, url, "name not found on the page"))
    say(f"Checked {len(rows)} entries against {len(cache)} pages: {rate(len(problems), len(rows))} need a look.")
    say()
    if problems:
        say("| Group | Name | Office | Problem | Source |")
        say("|---|---|---|---|---|")
        for label, name, office, url, why in problems:
            say(f"| {label} | {name} | {office} | {why} | {url} |")
        say()
    say("A name not found can mean the person left office, or that the page spells or lays out the name differently: each needs a person to open the page.")
    say()


# ---------------------------------------------------------------------------
# 2. Name matching


def matching(args):
    say("## 2. Name matching")
    say()
    say("50 matches per source where there are that many, chosen at random; each compared with the name in the original record (first and last name, allowing a middle name, \"Last, First\" and common nicknames). A mismatch here is a match a person should check, not proof it's wrong.")
    say()
    summary = []

    # Cal-Access: each committee attached to an official should carry that official's name.
    data = json.loads((ROOT / "data" / "ca-campaign.json").read_text())
    pairs = []
    for key, o in (data.get("officials") or {}).items():
        for c in o.get("committees") or []:
            pairs.append((o.get("name"), c.get("name"), c.get("source_url")))
    for seat, people in (data.get("seats") or {}).items():
        for o in people if isinstance(people, list) else [people]:
            for c in (o or {}).get("committees") or []:
                pairs.append((o.get("name"), c.get("name"), c.get("source_url")))
    sample = random.sample(pairs, min(50, len(pairs)))
    bad = [p for p in sample if not (parts(p[0]) and set(parts(p[0])[1:]) & set(parts(p[1])))]
    summary.append(("Cal-Access committees → California officials", len(sample), len(bad), len(pairs)))
    say(f"### Cal-Access committees ({len(pairs)} matched; {len(sample)} checked)")
    say(f"Committee name doesn't contain the official's last name: {rate(len(bad), len(sample))}.")
    for o, c, u in bad[:15]:
        say(f"- {o} ← \"{c}\" ({u})")
    say()

    # Stock trade reports: the filer's name on the report vs the official it's attached to.
    tr = q(args, "SELECT r.id, r.filer_name, r.report_url, o.name FROM trade_reports r JOIN officials o ON o.id = r.official_id WHERE r.official_id IS NOT NULL ORDER BY random() LIMIT 50")
    bad = [r for r in tr if not same_person(r["filer_name"], r["name"])]
    total = (q(args, "SELECT COUNT(*) AS n FROM trade_reports WHERE official_id IS NOT NULL") or [{"n": 0}])[0]["n"]
    summary.append(("Stock trade reports → members of Congress", len(tr), len(bad), total))
    say(f"### Stock trade reports ({total} matched; {len(tr)} checked)")
    say(f"Filer's name and member's name disagree: {rate(len(bad), len(tr))}.")
    for r in bad[:15]:
        say(f"- \"{r['filer_name']}\" → {r['name']} ({r['report_url']})")
    say()

    # LD-203: the honoree as written on the report vs the official it's attached to.
    ld = q(args, "SELECT l.honoree_name, l.contributor_name, l.filing_uuid, o.name FROM lobby_contributions l JOIN officials o ON o.id = l.official_id ORDER BY random() LIMIT 50")
    bad = [r for r in ld if not same_person(r["honoree_name"], r["name"])]
    total = (q(args, "SELECT COUNT(*) AS n FROM lobby_contributions") or [{"n": 0}])[0]["n"]
    summary.append(("LD-203 honorees → officials", len(ld), len(bad), total))
    say(f"### LD-203 contributions honoring an official ({total} matched; {len(ld)} checked)")
    say(f"Honoree as written and the official disagree: {rate(len(bad), len(ld))}.")
    for r in bad[:15]:
        say(f"- \"{r['honoree_name']}\" → {r['name']} (filing {r['filing_uuid']})")
    say()

    # Candidates' offices held, matched by name among the state's officials (officesHeld() in candidates.js).
    officials = q(args, "SELECT name, last_name, office, state, chamber FROM officials WHERE active = 1 AND state IS NOT NULL")
    by_state = {}
    for o in officials:
        by_state.setdefault(o["state"], []).append(o)
    cands = []
    for f in sorted((ROOT / "data" / "candidates" / "2026").glob("*.json")):
        if f.name in ("names.json", "websites.json"):
            continue
        try:
            d = json.loads(f.read_text())
        except ValueError:
            continue
        cs = d.get("candidates") or {}
        for c in (cs.values() if isinstance(cs, dict) else cs):
            cands.append((d.get("state") or f.stem.upper(), c))
    hits = []
    for st, c in cands:
        name = c.get("name") or ""
        p = parts(name.split(",")[1] + " " + name.split(",")[0]) if "," in name else parts(name)
        if len(p) < 2:
            continue
        first, last = p[0], p[-1]
        found = [o for o in by_state.get(st, []) if parts(o["name"]) and parts(o["name"])[-1] == last and parts(o["name"])[0] in (first, NICK.get(first, first))]
        if len(found) == 1 and not c.get("incumbent"):
            hits.append((name, c.get("id"), found[0]))
    sample = random.sample(hits, min(50, len(hits)))
    # The FEC record doesn't say what other office someone holds, so these can't be confirmed automatically.
    summary.append(("Candidates' offices held (by name)", len(sample), None, len(hits)))
    say(f"### Candidates' offices held, matched by name ({len(hits)} matches; {len(sample)} listed)")
    say("The FEC record doesn't say what other office a candidate holds, so these can't be checked in code: each needs a person to confirm it's the same person (for example from the campaign website).")
    for name, cid, o in sample[:50]:
        say(f"- {name} ({cid}) → {o['name']}, {o['office']}")
    say()
    return summary


# ---------------------------------------------------------------------------
# 3. Bill summaries


THIS_BILL = re.compile(r"\bThis (bill|measure|joint resolution|concurrent resolution|resolution) (would |)[a-z]")
SHORT_TITLE = re.compile(r"may be cited as|\bshort title\b", re.I)
HEADING = re.compile(r"^\s*(SECTION|SEC\.)\s*\d|^\s*(TITLE|DIVISION)\s+[IVX\d]+\b", re.I)


def first_sentences(t, n=2):
    s = re.split(r"(?<=[.!?])\s+(?=[A-Z])", re.sub(r"\s+", " ", t or "").strip())
    return " ".join(s[:n])


def shown_summary(b):
    """What billSummary() in functions/_lib/bill-page.js shows: (text, source)."""
    if (b.get("summary") or "").strip():
        return first_sentences(b["summary"]), "written"
    off, label = b.get("official_summary") or "", b.get("official_summary_label") or ""
    crs, digest = bool(re.match(r"CRS summary", label, re.I)), bool(re.search(r"Legislative Counsel", label, re.I))
    if off and (crs or digest):
        m = THIS_BILL.search(off)
        if m or crs:
            return first_sentences(off[m.start():] if m else off), "crs" if crs else "digest"
    if (b.get("plain_summary") or "").strip():
        return first_sentences(b["plain_summary"]), "analysis"
    return "", "none"


def kind_of(text, b):
    if not text:
        return "empty"
    if SHORT_TITLE.search(text):
        return "short title"
    if HEADING.search(text):
        return "section heading"
    title = norm(b.get("title"))
    if title and norm(text).rstrip(".") == title.rstrip("."):
        return "the title again"
    if len(text.split()) <= 6:
        return "too short to be a summary"
    return "ok"


def summaries(args):
    say("## 3. Bill summaries")
    say()
    total = q(args, "SELECT level, COUNT(*) AS n FROM bills GROUP BY level")
    say("Bills in D1: " + ", ".join(f"{r['level']} {r['n']:,}" for r in total))
    say()
    # Every bill page anyone can reach from a list: the bills with a recorded vote (bill_list), all of them.
    counts, examples = {}, {}
    offset, step = 0, 2000
    while True:
        rows = q(args, f"""SELECT b.id, b.level, b.title, substr(b.summary, 1, 600) AS summary, CASE WHEN instr(b.official_summary, 'This bill') > 0 THEN substr(b.official_summary, instr(b.official_summary, 'This bill'), 800) ELSE substr(b.official_summary, 1, 800) END AS official_summary,
                 b.official_summary_label, substr(a.plain_summary, 1, 600) AS plain_summary, l.st
          FROM bill_list l JOIN bills b ON b.id = l.bill_id
          LEFT JOIN bill_analyses a ON a.bill_id = b.id AND a.current = 1 AND (a.status = 'reviewed' OR (a.status = 'ai_draft' AND a.ai_review = 'pass'))
          ORDER BY l.bill_id LIMIT {step} OFFSET {offset}""")
        for b in rows:
            text, src = shown_summary(b)
            k = kind_of(text, b)
            key = (b.get("st") or b["level"], src, k)
            counts[key] = counts.get(key, 0) + 1
            if k != "ok" and k != "empty" and len(examples.setdefault(k, [])) < 8:
                examples[k].append((b["id"], src, text[:160]))
            if k == "ok" and b["level"] == "federal" and random.random() < 0.02 and len(examples.setdefault("federal, shown", [])) < 12:
                examples["federal, shown"].append((b["id"], src, text[:200]))
        if len(rows) < step:
            break
        offset += step
    by_kind, by_where = {}, {}
    for (where, src, k), n in counts.items():
        by_kind[k] = by_kind.get(k, 0) + n
        if k != "ok":
            by_where.setdefault(where, {}).setdefault(k, 0)
            by_where[where][k] += n
    n_all = sum(by_kind.values())
    say(f"Bill pages with a recorded vote (every bill reachable from a list): {n_all:,}.")
    say()
    say("| What the summary at the top is | Bills |")
    say("|---|---|")
    for k in ("ok", "empty", "short title", "section heading", "the title again", "too short to be a summary"):
        if by_kind.get(k):
            say(f"| {k} | {by_kind[k]:,} ({100 * by_kind[k] / n_all:.1f}%) |")
    say()
    src_tot = {}
    for (where, src, k), n in counts.items():
        if k != "ok":
            src_tot[(src, k)] = src_tot.get((src, k), 0) + n
    say("Problems by where the summary came from: " + "; ".join(f"{k} from {src}: {n:,}" for (src, k), n in sorted(src_tot.items(), key=lambda x: -x[1])) + ".")
    say()
    say("By state (or federal): " + "; ".join(f"{w}: " + ", ".join(f"{k} {n:,}" for k, n in sorted(v.items())) for w, v in sorted(by_where.items(), key=lambda x: -sum(x[1].values()))[:20]) + ".")
    say()
    for k, ex in examples.items():
        say(f"Examples, {k}:")
        for bid, src, t in ex:
            say(f"- {bid} ({src}): \"{t}\"")
        say()
    return by_kind, n_all


# ---------------------------------------------------------------------------
# 4. AI content


def constitution_text():
    data = json.loads((ROOT / "data" / "constitution.json").read_text())
    return {p["id"]: p.get("text", "") for p in data["provisions"]}


def contained(quote, text):
    strip = lambda t: re.sub(r"[\"']", "", norm(t))
    nq, nt = strip(quote), strip(text)
    return bool(nq) and nq in nt


def ai_content(args):
    say("## 4. AI content")
    say()
    out = {}
    con = constitution_text()
    rows = q(args, "SELECT a.id, a.bill_id, a.status, a.clauses FROM bill_analyses a WHERE a.current = 1 AND (a.status = 'reviewed' OR (a.status = 'ai_draft' AND a.ai_review = 'pass')) ORDER BY random() LIMIT 20")
    quotes = bad = 0
    bad_list = []
    for r in rows:
        try:
            clauses = json.loads(r["clauses"] or "[]")
        except ValueError:
            clauses = []
        for c in clauses:
            quotes += 1
            if not contained(c.get("quote"), con.get(c.get("id"), "")):
                bad += 1
                bad_list.append((r["bill_id"], c.get("id"), c.get("quote")))
    out["analyses"] = (len(rows), quotes, bad)
    say(f"### Constitutional analyses: {len(rows)} published, {quotes} quotes")
    say(f"Quotes not found word for word in their provision in data/constitution.json: {rate(bad, quotes)}.")
    for bid, pid, qt in bad_list[:10]:
        say(f"- {bid}, {pid}: \"{qt}\"")
    say()

    rows = q(args, "SELECT p.id, p.quote, p.source_url, p.review, o.name FROM promises p JOIN officials o ON o.id = p.official_id WHERE p.review IN ('auto', 'approved') ORDER BY random() LIMIT 20")
    bad_list = []
    for r in rows:
        url = r["source_url"] or ""
        m = re.match(r"https?://www\.govinfo\.gov/app/details/([A-Z]+-\d+)", url)
        if m:  # the detail page is built in the browser; the document's text is here
            url = f"https://www.govinfo.gov/content/pkg/{m.group(1)}/html/{m.group(1)}.htm"
        page = fetch(url)
        time.sleep(0.5)
        if page.startswith("__FETCH_FAILED__"):
            bad_list.append((r, "source didn't load"))
        elif not contained(r["quote"], text_of(page)):
            bad_list.append((r, "quote not on the page today"))
    out["promises"] = (len(rows), len(bad_list))
    say(f"### Promises: {len(rows)} published")
    say(f"Quote not found word for word on its source page today: {rate(len(bad_list), len(rows))}.")
    for r, why in bad_list:
        say(f"- #{r['id']} {r['name']} ({why}): \"{(r['quote'] or '')[:140]}\" {r['source_url']}")
    say()

    rows = q(args, "SELECT url, excerpt, page_text, o.name FROM promise_pages p JOIN officials o ON o.id = p.official_id WHERE excerpt IS NOT NULL AND excerpt != '' ORDER BY random() LIMIT 20")
    stored_bad, live_bad = [], []
    for r in rows:
        if not contained(r["excerpt"], r.get("page_text") or ""):
            stored_bad.append(r)
        page = fetch(r["url"])
        time.sleep(0.5)
        if page.startswith("__FETCH_FAILED__") or not contained(r["excerpt"], text_of(page)):
            live_bad.append((r, "page didn't load" if page.startswith("__FETCH_FAILED__") else "excerpt no longer on the page"))
    out["excerpts"] = (len(rows), len(stored_bad), len(live_bad))
    say(f"### Platform excerpts (\"In their own words\"): {len(rows)} shown")
    say(f"Not word for word in the page as it was read: {rate(len(stored_bad), len(rows))}. Not on the live page today: {rate(len(live_bad), len(rows))} (pages change; the excerpt is refreshed monthly).")
    for r in stored_bad:
        say(f"- As read: {r['name']}: \"{(r['excerpt'] or '')[:160]}\" {r['url']}")
    for r, why in live_bad:
        say(f"- {r['name']} ({why}): \"{(r['excerpt'] or '')[:140]}\" {r['url']}")
    say()
    return out


# ---------------------------------------------------------------------------
# 5. Freshness


def freshness(args):
    say("## 5. Data freshness")
    say()
    fed = q(args, "SELECT chamber, MAX(vote_date) AS last FROM votes WHERE chamber IN ('us-house', 'us-senate') GROUP BY chamber")
    ours = {r["chamber"]: r["last"] for r in fed}
    senate = fetch("https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml")
    m = re.search(r"<vote_date>([^<]+)</vote_date>", senate)
    key = os.environ.get("CONGRESS_API_KEY", "")
    house = fetch(f"https://api.congress.gov/v3/house-vote/119/2?format=json&limit=250&api_key={key}") if key else "__FETCH_FAILED__ no key"
    try:
        hv = json.loads(house).get("houseRollCallVotes") or []
        hm = sorted((v.get("startDate") or "")[:10] for v in hv)[-1:]
    except ValueError:
        hm = []
    say("| | Newest on ThePillory | Newest at the source |")
    say("|---|---|---|")
    say(f"| U.S. Senate roll calls | {ours.get('us-senate', '—')} | {m.group(1) + ' (senate.gov, day-month)' if m else 'source didn’t load'} |")
    say(f"| U.S. House roll calls | {ours.get('us-house', '—')} | {hm[0] + ' (Congress.gov, first 250 roll calls of the session)' if hm else 'source didn’t load'} |")
    say()
    rows = q(args, "SELECT st, bills, votes, last_vote, updated_at FROM state_coverage ORDER BY st")
    say("Each state's newest recorded vote on ThePillory. Comparing with each legislature's own site isn't automated (50 different sites; Open States' API key isn't available to GitHub Actions); a state's legislature may simply be out of session.")
    say()
    say("| State | Bills | Votes | Newest vote | Updated |")
    say("|---|---|---|---|---|")
    for r in rows:
        say(f"| {r['st']} | {r['bills'] or 0:,} | {r['votes'] or 0:,} | {r['last_vote'] or '—'} | {(r['updated_at'] or '')[:10]} |")
    say()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--database", default="pillory")
    ap.add_argument("--only", default="1,2,3,4,5")
    args = ap.parse_args()
    only = set(args.only.split(","))
    say("# Accuracy audit")
    say()
    say(f"Run {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}. Reads D1 and the sources; changes nothing.")
    say()
    for k, fn in (("1", hand_entered), ("2", matching), ("3", summaries), ("4", ai_content), ("5", freshness)):
        if k in only:
            try:
                fn(args)
            except Exception as e:  # noqa: BLE001  (one section failing shouldn't hide the rest)
                say(f"> Section {k} failed: {type(e).__name__}: {str(e)[:300]}")
                say()
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as fh:
            fh.write("\n".join(OUT) + "\n")


if __name__ == "__main__":
    main()
