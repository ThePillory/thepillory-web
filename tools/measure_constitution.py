#!/usr/bin/env python3
"""Drafts the "Constitution" section of every November 3, 2026 statewide ballot
measure ThePillory has loaded (data/elections/2026-11-03*.json: California,
Washington, Colorado, Arizona, Florida, Michigan) and holds each one on
/admin/review/measures/ until a person approves it (migration 0041,
measure_constitution). No "aligns / may be in tension" panels before the
election: only facts.

    python3 tools/measure_constitution.py draft [--only 2026-11-03-co/amendment-87] [--redo] [--max-dollars 15]
    python3 tools/measure_constitution.py cases     # search court records again (daily)
    python3 tools/measure_constitution.py list      # what's in D1, by status

Each section has three parts, the same for every measure:
  1. What it changes: the state constitution, a statute, or both (or a
     constitutional convention question), with the words of the official text
     that say so, quoted word for word, and the document they come from.
  2. Constitutional provisions it touches: U.S. Constitution provisions
     (data/constitution.json) and state constitution sections (California's
     from data/ca-constitution.json, quoted word for word; other states' linked
     to their official text) that the measure amends, adds to or directly
     involves, each with one neutral line on how.
  3. Legal challenges: court records on CourtListener that mention the measure,
     with case name, court, date filed and link. Never summarized or predicted.

AI suggests (claude-opus-5-5, one call per measure); code decides what stays:
  - every quote from the measure's text must appear word for word in the
    official text (the record's own official fields, and the text of the
    measure where the state publishes it);
  - the kind of change must agree with the words quoted ("constitution",
    "statute") and with the official label where there is one;
  - a state provision stays only if the official text cites it ("Article X,
    Section 20"); a U.S. provision only if the official text refers to the U.S.
    Constitution; California sections must exist in data/ca-constitution.json
    and are quoted from it, U.S. provisions from data/constitution.json;
  - each "how it's involved" line is one short neutral sentence, or a fixed one.
Whatever the checks remove is listed for the reviewer (notes). Nothing is
published here: every row starts as pending.

Also queues each measure for the full three-panel analysis after the election
(measure_analysis_queue, not before 2026-11-04). Needs ANTHROPIC_API_KEY,
COURTLISTENER_API_TOKEN, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
(the "Draft measure Constitution sections" workflow). pdftotext for PDFs.
"""
import argparse
import datetime
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
ELECTIONS = ["2026-11-03", "2026-11-03-wa", "2026-11-03-co", "2026-11-03-az", "2026-11-03-fl", "2026-11-03-mi"]
MIGRATION = "0041_measure_constitution.sql"
MODEL = "claude-opus-5-5"
PRICE = (4.0, 20.0)  # dollars per million tokens, input and output
PROMPT_VERSION = "measure-constitution-1"
ANALYSIS_NOT_BEFORE = "2026-11-04"
CASES_SINCE = "2026-01-01"
MAX_PROVISIONS = 8
MAX_CORPUS = 90000  # characters of official text sent to the model

STATE_NAME = {"CA": "California", "WA": "Washington", "CO": "Colorado", "AZ": "Arizona", "FL": "Florida", "MI": "Michigan"}
# Each state's constitution, on the state's own official site, until its text is loaded.
STATE_CONSTITUTION = {
    "WA": "https://leg.wa.gov/state-laws-and-rules/washington-state-constitution/",
    "CO": "https://leg.colorado.gov/colorado-constitution",
    "AZ": "https://www.azleg.gov/constitution/",
    "FL": "https://www.flsenate.gov/Laws/Constitution",
    "MI": "https://www.legislature.mi.gov/Laws/Constitution",
}
US_CONSTITUTION_PAGE = "https://thepillory.co/laws/constitution/"
CA_CONSTITUTION_PAGE = "https://thepillory.co/laws/constitution/california/"

# The fixed line for each kind of involvement, used when the suggested line doesn't pass the wording check.
LINES = {
    "amends": "This measure amends this section.",
    "adds": "This measure adds a new section to this article.",
    "repeals": "This measure repeals this section.",
    "cites": "The measure's official text cites this provision.",
    "involves": "The measure's official text refers to this provision.",
}
LOADED = re.compile(
    r"\b(unconstitutional|violat\w*|conflict\w*|protect\w*|attack\w*|threat\w*|harm\w*|danger\w*|unfair\w*|radical|extreme\w*|"
    r"good|bad|best|worst|should|must not|clearly|obviously|undermin\w*|erode\w*|strip\w*|guarantee\w*|preserv\w*|restor\w*|"
    r"recommend\w*|vote (?:yes|no)|support\w*|oppos\w*)\b", re.I)
US_REF = re.compile(r"\b(?:United States Constitution|U\.\s?S\.\s?Constitution|Constitution of the United States|federal constitution|"
                    r"(?:First|Second|Fourth|Fifth|Sixth|Eighth|Tenth|Fourteenth|Fifteenth|Nineteenth|Twenty-sixth) Amendment)\b", re.I)


# ---------------------------------------------------------------------------
# Text: pure, tested (tools/test_measure_constitution.py)

def norm(s):
    """For word-for-word comparison: curly quotes and dashes made plain, spaces collapsed. Case and words unchanged."""
    s = html.unescape(str(s or "")).replace(" ", " ")
    for a, b in (("‘", "'"), ("’", "'"), ("“", '"'), ("”", '"'), ("–", "-"), ("—", "-"), ("­", "")):
        s = s.replace(a, b)
    s = re.sub(r"-\s*\n\s*", "-", s)
    return re.sub(r"\s+", " ", s).strip()


def found_in(quote, parts):
    """The first official part (name, url, text) that has the quote word for word, or None."""
    q = norm(quote)
    if len(q) < 12:
        return None
    for part in parts:
        if q in norm(part["text"]):
            return part
    return None


def strings(x):
    """Every string in a record value, in order (dicts and lists walked; table placeholders skipped)."""
    if isinstance(x, str):
        yield x
    elif isinstance(x, list):
        for v in x:
            yield from strings(v)
    elif isinstance(x, dict):
        for k, v in x.items():
            if k in ("table",):
                continue
            yield from strings(v)


# The record's own official fields. Never the campaigns' arguments, and never ThePillory's labels (kind, label, *_by).
OFFICIAL_FIELDS = ["title", "question", "summary", "ag_summary", "yes_means", "no_means", "fiscal_effect", "ballot_title",
                   "explanatory", "fiscal_summary"]


def record_parts(m):
    parts = []
    text = "\n".join(s for f in OFFICIAL_FIELDS for s in strings(m.get(f)))
    if text:
        parts.append({"name": m.get("source") or "The official voter guide", "url": m.get("source_url"), "text": text})
    for sec in m.get("sections") or []:
        body = "\n".join(s for s in strings(sec.get("paragraphs")) if s)
        if body:
            parts.append({"name": sec.get("by") or m.get("source"), "url": m.get("source_url"), "text": f"{sec.get('heading', '')}\n{body}"})
    return parts


def label_changes(m):
    """What the official label says the measure changes ('constitution', 'statute', 'both', 'convention'), or None."""
    label = norm(" ".join(s for s in [m.get("title") or "", m.get("kind") or ""] if s)).lower()
    if "convention" in label:
        return "convention"
    con = "constitutional amendment" in label or "amendment to the constitution" in label
    stat = "statute" in label
    return "both" if con and stat else "constitution" if con else "statute" if stat else None


def quote_supports(changes, quotes):
    """Do the quoted words say what the change is? (One quote for each side when it's both.)"""
    words = norm(" ".join(quotes)).lower()
    con = bool(re.search(r"\bconstitution", words))
    stat = bool(re.search(r"\b(statut|revised code|code\b|state law|laws? of|rcw\b|c\.r\.s|arizona revised|general laws|initiated law|act\b)", words))
    if changes == "constitution":
        return con
    if changes == "statute":
        return stat
    if changes == "both":
        return con and stat
    if changes == "convention":
        return "convention" in words
    return False


ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}


def roman(s):
    total = 0
    for i, ch in enumerate(s):
        v = ROMAN[ch]
        total += -v if i + 1 < len(s) and ROMAN[s[i + 1]] > v else v
    return total


def parse_citation(c):
    """'Article XIII A, Section 1' / 'Section 1 of Article XIII A' / 'Art. X, § 20' -> ('XIII A', '1') or (art, None)."""
    c = norm(c).replace("§", "Section ")
    art = re.search(r"\bArt(?:icle|\.)?\s+([IVXLC]+)(?:\s*([A-Z])\b)?", c, flags=re.I)
    sec = re.search(r"\bSec(?:tion|\.)?\s*([0-9]+(?:\.[0-9]+)?[a-z]?)", c, flags=re.I)
    if not art:
        return None
    a = art.group(1).upper() + (f" {art.group(2).upper()}" if art.group(2) else "")
    return a, (sec.group(1) if sec else None)


def cited_in(article, section, parts):
    """Does the official text cite this article (and section)? Any of the usual ways of writing it."""
    num, _, letter = article.partition(" ")
    art_re = rf"(?:article|art\.)\s+{num}(?:\s*{letter}\b|\b(?!\s*[A-Z]\b))" if letter else rf"(?:article|art\.)\s+{num}\b(?!\s*[A-Z]\b)"
    for part in parts:
        t = norm(part["text"])
        for m in re.finditer(art_re, t, flags=re.I):
            if not section:
                return True
            window = t[max(0, m.start() - 160): m.end() + 160]
            if re.search(rf"(?:section|sec\.|§)\s*{re.escape(section)}(?![0-9.])", window, flags=re.I):
                return True
    return False


def ca_section_id(article, section):
    num, _, letter = article.partition(" ")
    base = f"ca-art-{roman(num)}{letter.lower()}"
    return base if section is None else f"{base}-sec-{section.replace('.', '-')}"


def clean_line(line, relation):
    """One short neutral sentence about how the provision is involved; the fixed line otherwise."""
    s = norm(line)
    ok = s and len(s.split()) <= 30 and s.endswith(".") and s.count(".") <= 2 and not LOADED.search(s) and re.match(r"^(This measure|The measure)", s)
    return s if ok else LINES.get(relation, LINES["involves"])


def excerpt(text, limit=900):
    """A provision's text for the page: whole when short, else its first paragraphs up to about `limit` characters (word for word)."""
    if len(text) <= limit:
        return text, False
    out = ""
    for p in text.split("\n\n"):
        if out and len(out) + len(p) > limit:
            break
        out = f"{out}\n\n{p}" if out else p
    if len(out) > limit:
        cut = out[:limit].rsplit(" ", 1)[0]
        return cut, True
    return out, True


def check_draft(m, state, parts, draft, us, ca):
    """
    The suggested draft, checked. Returns (changes, quotes [(quote, part)], provisions, notes).
    us / ca: {id: provision row}. Nothing here touches the network.
    """
    notes = []
    official = label_changes(m)
    changes = draft.get("changes") or "unclear"
    quotes = []
    for q in (draft.get("changes_quotes") or [])[:2]:
        part = found_in(q, parts)
        if part:
            quotes.append((norm(q), part))
        else:
            notes.append(f"Removed a quote not found word for word in the official text: “{norm(q)[:200]}”")
    if quotes and not quote_supports(changes, [q for q, _ in quotes]):
        notes.append(f"The quoted words don't say “{changes}”; set aside.")
        quotes, changes = [], "unclear"
    if official and changes != official:
        notes.append(f"The suggestion said “{changes}”, the official label says “{official}”; the label wins.")
        changes = official
        quotes = [(q, p) for q, p in quotes if quote_supports(changes, [q])]
    if official and not quotes:
        # The label itself, where its words are in the official text (California's titles end with it).
        for phrase in re.findall(r"(?:LEGISLATIVE|INITIATIVE)\s+(?:CONSTITUTIONAL AMENDMENT(?:\s+AND\s+STATUTE)?|STATUTE)\.?", norm(m.get("title") or ""), flags=re.I):
            part = found_in(phrase, parts) if len(norm(phrase)) >= 12 else None
            if part:
                quotes = [(norm(phrase), part)]
    if not quotes:
        notes.append("No words in the official text say what the measure changes; a person must add or confirm them.")
    provisions, seen = [], set()
    us_ok = any(US_REF.search(p["text"]) for p in parts)
    for p in draft.get("provisions") or []:
        rel = p.get("relation") if p.get("relation") in LINES else "involves"
        if p.get("doc") == "us":
            row = us.get(p.get("us_id") or "")
            if not row or not row.get("leaf"):
                notes.append(f"Removed a U.S. Constitution provision that isn't in data/constitution.json: {p.get('us_id')}")
                continue
            if not us_ok:
                notes.append(f"Removed {row['label']}: the official text doesn't refer to the U.S. Constitution.")
                continue
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            text, cut = excerpt(row["text"])
            provisions.append({"doc": "us", "id": row["id"], "label": f"U.S. Constitution, {row['label']}", "quote": text, "cut": cut,
                               "url": f"{US_CONSTITUTION_PAGE}#{row['id']}", "relation": rel, "line": clean_line(p.get("line"), rel)})
            continue
        cite = parse_citation(p.get("state_citation") or "")
        if not cite:
            notes.append(f"Removed a state provision with no article: “{p.get('state_citation')}”")
            continue
        art, sec = cite
        if not cited_in(art, sec, parts):
            notes.append(f"Removed Article {art}{f', Section {sec}' if sec else ''}: the official text doesn't cite it.")
            continue
        sname = STATE_NAME[state]
        if state == "CA":
            sid = ca_section_id(art, sec)
            row = ca.get(sid)
            if rel == "adds" and not row:
                row = ca.get(ca_section_id(art, None))
            if not row:
                notes.append(f"Removed Article {art}, Section {sec}: not in data/ca-constitution.json.")
                continue
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            text, cut = excerpt(row.get("text") or "")
            provisions.append({"doc": "ca", "id": row["id"], "label": f"California Constitution, {row['label']}", "quote": text, "cut": cut,
                               "url": row["source_url"], "relation": rel, "line": clean_line(p.get("line"), rel)})
        else:
            key = f"{state}:{art}:{sec}"
            if key in seen:
                continue
            seen.add(key)
            provisions.append({"doc": "state", "id": key, "label": f"{sname} Constitution, Article {art}" + (f", Section {sec}" if sec else ""),
                               "quote": "", "cut": False, "url": STATE_CONSTITUTION[state], "relation": rel, "line": clean_line(p.get("line"), rel)})
    if len(provisions) > MAX_PROVISIONS:
        notes.append(f"Kept the first {MAX_PROVISIONS} of {len(provisions)} provisions.")
        provisions = provisions[:MAX_PROVISIONS]
    return changes, quotes, provisions, notes


# ---------------------------------------------------------------------------
# Measures and their official text

def load_measures():
    out = []
    for eid in ELECTIONS:
        path = ROOT / "data" / "elections" / f"{eid}.json"
        if not path.exists():
            continue
        e = json.loads(path.read_text())
        st = e["election"]["state"]
        for m in e["measures"]:
            if m.get("scope") != "statewide":
                continue
            label = m.get("label") or (f"Proposition {m['number']}" if st == "CA" else m.get("number"))
            out.append({"key": f"{eid}/{m['id']}", "election_id": eid, "state": st, "label": label, "m": m})
    return out


def fetch_text(url):
    import load_trades as T  # noqa: E402  (fetching, pdftotext)
    data = T.get(url, timeout=180)
    if url.lower().endswith(".pdf") or data[:5] == b"%PDF-":
        return T.pdf_text(data)
    t = data.decode("utf-8", "replace")
    t = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", t)
    return html.unescape(re.sub(r"<[^>]+>", " ", t))


def full_text_parts(item):
    """The measure's own full text, where the state publishes it on its own: California's and Washington's."""
    m = item["m"]
    links = m.get("links") if isinstance(m.get("links"), dict) else {}
    out = []
    for key, name in (("text", "Text of the proposed law"), ("statement", "Ballot title and explanatory statement")):
        url = links.get(key)
        if url:
            try:
                out.append({"name": f"{name} ({'Secretary of State' if item['state'] in ('CA', 'WA') else 'official'})", "url": url, "text": fetch_text(url)})
            except Exception as err:  # noqa: BLE001
                print(f"  couldn't read {url}: {err}", flush=True)
    return out


# ---------------------------------------------------------------------------
# The suggestion (Claude)

INSTRUCTIONS = """You help a nonpartisan civic site show, for one statewide ballot measure, which parts of the U.S. Constitution and the state's constitution the measure amends, adds to or directly involves. Facts only: no interpretation, no opinion on whether anything is constitutional, nothing about how to vote.

Use only the official text you are given. Return:
- changes: "constitution" if the measure amends the state constitution only, "statute" if it changes statutes only, "both" if both, "convention" if it asks whether to hold a constitutional convention, "unclear" if the text doesn't say.
- changes_quotes: one or two passages copied EXACTLY, character for character, from the official text, that state what the measure changes (for "both", one passage can say both, or give one for each). Copy; never paraphrase or fix spelling.
- provisions: the constitutional provisions the official text says the measure amends, adds, repeals, or cites. For the state constitution, give the citation as the official text writes it ("Article X, Section 20"). For the U.S. Constitution, give the id from the list, and only when the official text itself refers to the U.S. Constitution. relation: amends, adds, repeals, cites, or involves. line: one short neutral sentence starting "This measure" (for example "This measure amends this section." or "This measure creates a tax under this section."). No adjectives about effects, no predictions. Leave out anything the text doesn't state. An empty list is a fine answer."""

SCHEMA = {
    "type": "object",
    "properties": {
        "changes": {"type": "string", "enum": ["constitution", "statute", "both", "convention", "unclear"]},
        "changes_quotes": {"type": "array", "items": {"type": "string"}},
        "provisions": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "doc": {"type": "string", "enum": ["us", "state"]},
                "us_id": {"type": ["string", "null"]},
                "state_citation": {"type": ["string", "null"]},
                "relation": {"type": "string", "enum": ["amends", "adds", "repeals", "cites", "involves"]},
                "line": {"type": "string"},
            },
            "required": ["doc", "us_id", "state_citation", "relation", "line"],
            "additionalProperties": False,
        }},
    },
    "required": ["changes", "changes_quotes", "provisions"],
    "additionalProperties": False,
}


def suggest(client, item, parts, us_list, note=""):
    corpus = "\n\n".join(f"=== {p['name']} ===\n{norm(p['text'])}" for p in parts)[:MAX_CORPUS]
    user = (f"Measure: {item['label']}, {STATE_NAME[item['state']]}, November 3, 2026.\n"
            + (f"A reviewer sent an earlier draft back with this note: {note}\n" if note else "")
            + f"\nU.S. Constitution provision ids you may use:\n{us_list}\n\nOfficial text:\n{corpus}")
    with client.messages.stream(model=MODEL, max_tokens=16000, system=INSTRUCTIONS,
                                output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
                                messages=[{"role": "user", "content": user}]) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason in ("refusal", "max_tokens"):
        raise RuntimeError(f"no usable answer ({msg.stop_reason})")
    data = json.loads("".join(b.text for b in msg.content if b.type == "text"))
    dollars = (msg.usage.input_tokens * PRICE[0] + msg.usage.output_tokens * PRICE[1]) / 1e6
    return data, dollars


# ---------------------------------------------------------------------------
# Court records (CourtListener)

def case_query(item):
    m = item["m"]
    label = item["label"]
    words = [f'"{label}"']
    if item["state"] == "WA":
        words = [f'"{m["number"]}"']
    if re.fullmatch(r"(?:Amendment|Proposal|Proposition) [0-9A-Z-]+", label) and item["state"] in ("FL", "MI"):
        words.append(f'"{norm(m.get("title") or "")[:60]}"')
    return " AND ".join(words + [f'"{STATE_NAME[item["state"]]}"']) + f" AND dateFiled:[{CASES_SINCE} TO *]"


def parse_cases(results):
    out, seen = [], set()
    for r in results:
        url = r.get("docket_absolute_url") or r.get("absolute_url")
        if not url or not r.get("caseName"):
            continue
        url = urllib.parse.urljoin("https://www.courtlistener.com", url)
        if url in seen:
            continue
        seen.add(url)
        out.append({"name": norm(r["caseName"])[:300], "court": r.get("court") or "", "filed": (r.get("dateFiled") or "")[:10],
                    "docket": r.get("docketNumber") or "", "url": url})
    return out[:10]


def search_cases(item):
    token = os.environ.get("COURTLISTENER_API_TOKEN")
    if not token:
        raise SystemExit("COURTLISTENER_API_TOKEN is not set")
    q = case_query(item)
    rows = []
    for kind in ("r", "o"):
        url = "https://www.courtlistener.com/api/rest/v4/search/?" + urllib.parse.urlencode({"type": kind, "q": q, "order_by": "dateFiled desc"})
        req = urllib.request.Request(url, headers={"Authorization": f"Token {token}", "User-Agent": "ThePillory/1.0 (+https://thepillory.co)"})
        with urllib.request.urlopen(req, timeout=60) as r:
            rows += json.loads(r.read()).get("results", [])
    return parse_cases(rows), q


# ---------------------------------------------------------------------------
# D1

def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(int(v))
    return "'" + str(v).replace("'", "''") + "'"


def d1(args, **kw):
    import load_trades as T  # noqa: E402
    return T.d1(args, **kw)


def ensure_tables(args):
    d1(args, command="CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    d1(args, file=ROOT / "workers" / "sync" / "migrations" / MIGRATION)  # CREATE … IF NOT EXISTS
    d1(args, command=f"INSERT OR IGNORE INTO d1_migrations (name) VALUES ('{MIGRATION}')")


def existing(args):
    return {r["measure_key"]: r for r in d1(args, command="SELECT measure_key, status, version, review_note, cases, cases_new FROM measure_constitution")}


def save(args, item, changes, quotes, provisions, cases, notes, prev, by):
    key = item["key"]
    version = (prev["version"] + 1) if prev else 1
    quote_text = "\n\n".join(q for q, _ in quotes)
    src = quotes[0][1] if quotes else {"name": item["m"].get("source") or "Official source", "url": item["m"].get("source_url")}
    row = {
        "measure_key": key, "election_id": item["election_id"], "measure_id": item["m"]["id"], "state": item["state"], "label": item["label"],
        "changes": changes, "changes_quote": quote_text, "changes_source": src["name"], "changes_source_url": src["url"],
        "provisions": json.dumps(provisions, ensure_ascii=False), "cases": json.dumps(cases, ensure_ascii=False),
        "notes": json.dumps(notes, ensure_ascii=False), "model": MODEL, "prompt_version": PROMPT_VERSION, "version": version,
    }
    cols = list(row)
    upsert = (f"INSERT INTO measure_constitution ({', '.join(cols)}, status, cases_checked_at, updated_at) VALUES ({', '.join(lit(row[c]) for c in cols)}, 'pending', datetime('now'), datetime('now')) "
              f"ON CONFLICT (measure_key) DO UPDATE SET {', '.join(f'{c} = excluded.{c}' for c in cols if c != 'measure_key')}, status = 'pending', "
              "reviewed_by = NULL, reviewed_at = NULL, cases_checked_at = excluded.cases_checked_at, updated_at = excluded.updated_at;")
    hist = f"INSERT INTO measure_constitution_history (measure_key, version, snapshot, action, by_whom) VALUES ({lit(key)}, {version}, {lit(json.dumps(row, ensure_ascii=False))}, 'drafted', {lit(by)});"
    import load_trades as T  # noqa: E402
    T.run_sql(args, [upsert, hist])


MAX_ANALYSIS_TEXT = 150000


def queue_analysis(args, items, texts):
    """Every measure, for the full analysis after the election; `texts`: {key: official text} read in this run."""
    stmts = []
    for it in items:
        m = it["m"]
        links = m.get("links") if isinstance(m.get("links"), dict) else {}
        url = links.get("text") or m.get("source_url")
        title = norm(m.get("title") or it["label"])
        text = texts.get(it["key"])
        stmts.append("INSERT INTO measure_analysis_queue (measure_key, election_id, measure_id, state, label, title, text_url, text, not_before) VALUES "
                     f"({lit(it['key'])}, {lit(it['election_id'])}, {lit(m['id'])}, {lit(it['state'])}, {lit(it['label'])}, {lit(title)}, {lit(url)}, {lit(text[:MAX_ANALYSIS_TEXT] if text else None)}, {lit(ANALYSIS_NOT_BEFORE)}) "
                     "ON CONFLICT (measure_key) DO UPDATE SET text = COALESCE(excluded.text, measure_analysis_queue.text), title = excluded.title, text_url = excluded.text_url;")
    stmts.append(f"INSERT OR REPLACE INTO sync_state (key, value) VALUES ('measure_constitution_total', {lit(str(len(items)))});")
    import load_trades as T  # noqa: E402
    T.run_sql(args, stmts)


# ---------------------------------------------------------------------------

def provisions_for_prompt(us):
    return "\n".join(f"{r['id']}: {r['label']}" for r in us.values() if r.get("leaf"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=("draft", "cases", "list"))
    ap.add_argument("--only", default="", help="one measure key, e.g. 2026-11-03-co/amendment-87")
    ap.add_argument("--redo", action="store_true", help="draft again even when already drafted (never an approved one without --redo-approved)")
    ap.add_argument("--redo-approved", action="store_true")
    ap.add_argument("--max-dollars", type=float, default=15.0)
    ap.add_argument("--database", default="pillory")
    args = ap.parse_args()

    items = [i for i in load_measures() if not args.only or i["key"] == args.only]
    print(f"{len(items)} statewide measures: " + ", ".join(f"{i['state']} {i['label']}" for i in items), flush=True)
    ensure_tables(args)
    prev = existing(args)
    if args.mode == "list":
        for i in items:
            p = prev.get(i["key"])
            print(f"  {i['key']}: {p['status'] if p else 'not drafted'}")
        return

    if args.mode == "cases":
        import load_trades as T  # noqa: E402
        for i in items:
            p = prev.get(i["key"])
            if not p:
                continue
            cases, q = search_cases(i)
            if p["status"] != "approved":
                # Not reviewed yet: the draft's list is simply brought up to date.
                T.run_sql(args, [f"UPDATE measure_constitution SET cases = {lit(json.dumps(cases, ensure_ascii=False))}, cases_checked_at = datetime('now') WHERE measure_key = {lit(i['key'])};"])
                print(f"  {i['key']}: {len(cases)} court records (not reviewed yet)", flush=True)
                continue
            known = {c["url"] for c in json.loads(p["cases"] or "[]") + json.loads(p["cases_new"] or "[]")}
            new = [c for c in cases if c["url"] not in known]
            print(f"  {i['key']}: {len(cases)} court records ({len(new)} new) for {q}", flush=True)
            if new:
                # New records never go live by themselves: they wait on /admin/review/measures/ for a person.
                T.run_sql(args, [f"UPDATE measure_constitution SET cases_new = {lit(json.dumps(json.loads(p['cases_new'] or '[]') + new, ensure_ascii=False))}, "
                                 f"cases_checked_at = datetime('now') WHERE measure_key = {lit(i['key'])};",
                                 f"INSERT INTO measure_constitution_history (measure_key, version, snapshot, action, by_whom) VALUES ({lit(i['key'])}, {p['version']}, {lit(json.dumps({'new_cases': new}))}, 'cases', 'courtlistener');"])
            else:
                T.run_sql(args, [f"UPDATE measure_constitution SET cases_checked_at = datetime('now') WHERE measure_key = {lit(i['key'])};"])
        return

    import anthropic  # noqa: E402
    client = anthropic.Anthropic()
    us = {r["id"]: r for r in json.loads((ROOT / "data" / "constitution.json").read_text())["provisions"]}
    ca_path = ROOT / "data" / "ca-constitution.json"
    if not ca_path.exists():
        raise SystemExit("data/ca-constitution.json isn't built yet: run the California Constitution workflow first")
    ca = {r["id"]: r for r in json.loads(ca_path.read_text())["provisions"]}
    us_list = provisions_for_prompt(us)
    spent, drafted, failed, texts = 0.0, 0, [], {}
    for i in items:
        p = prev.get(i["key"])
        if p and p["status"] == "approved" and not args.redo_approved:
            print(f"  {i['key']}: approved, left as is", flush=True)
            continue
        if p and p["status"] == "pending" and not args.redo:
            print(f"  {i['key']}: already drafted, waiting for review", flush=True)
            continue
        if spent >= args.max_dollars:
            print(f"Stopping before ${args.max_dollars:.2f}: ${spent:.2f} spent", flush=True)
            break
        parts = record_parts(i["m"]) + full_text_parts(i)
        texts[i["key"]] = "\n\n".join(f"=== {p['name']} ===\n{norm(p['text'])}" for p in parts)
        try:
            draft, dollars = suggest(client, i, parts, us_list, note=(p or {}).get("review_note") or "")
        except Exception as err:  # noqa: BLE001  (one measure failing leaves the others)
            failed.append(i["key"])
            print(f"  {i['key']}: no draft ({err})", flush=True)
            continue
        spent += dollars
        changes, quotes, provisions, notes = check_draft(i["m"], i["state"], parts, draft, us, ca)
        try:
            cases, q = search_cases(i)
        except Exception as err:  # noqa: BLE001
            cases, q = [], ""
            notes.append(f"Court records couldn't be searched this time ({err}); searched again daily.")
        save(args, i, changes, quotes, provisions, cases, notes, p, f"{MODEL} + code checks")
        drafted += 1
        print(f"  {i['key']}: {changes}; {len(quotes)} quote(s); {len(provisions)} provision(s); {len(cases)} court record(s); "
              f"{len(notes)} note(s); ${dollars:.3f}", flush=True)
        for n in notes:
            print(f"      note: {n}", flush=True)
    queue_analysis(args, load_measures(), texts)
    print(f"Drafted {drafted}; ${spent:.2f} spent" + (f"; no draft for {', '.join(failed)}" if failed else ""), flush=True)
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
