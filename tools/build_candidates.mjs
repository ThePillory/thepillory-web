#!/usr/bin/env node
// Candidate pages' data: data/candidates/<year>/<st>.json, from the FEC.
//
//   FEC_API_KEY=... node tools/build_candidates.mjs [--year 2026] [--states TX,CA] [--max-requests 600]
//
// Who's included: every candidate in data/elections/federal-<year>/<st>.json
// (tools/build_federal_races.py: the FEC's statutory candidates, active this
// cycle), one rule for everyone. A candidate who later drops off that list
// keeps their entry (listed: false, with the last date they were listed), so
// their page stays.
//
// For each candidate, refreshed oldest first within --max-requests (the FEC
// allows about 1,000 requests an hour):
//   - totals for the two-year period, read with parseTotals() from
//     workers/sync/src/funding/fec.js, the same as officials' Funding tab;
//   - contributions from PACs and other committees (Schedule A line 11C),
//     summed by giving committee with aggregatePacs(): organizations by name.
//     Individual donors are never requested, stored or shown;
//   - the campaign website listed in the principal committee's FEC filing
//     (Form 1). Nothing else from the committee record is kept: no email,
//     phone, address or treasurer.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API, parseTotals, aggregatePacs } from "../workers/sync/src/funding/fec.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_PAC_PAGES = 40; // as for officials (workers/sync/src/funding/sync.js)
const TOP_ORGS = 25;
const WEBSITE_DAYS = 30;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

/** "COLINALLRED.COM" → "https://colinallred.com/"; null for anything that isn't a web address. Pure. */
export function websiteUrl(raw) {
  let s = String(raw || "").trim();
  if (!s || /\s|@/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${u.pathname === "/" ? "/" : u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * Candidates for Congress on a state's certified candidate list (data/elections/<date>.json,
 * California) with an FEC ID: { id, name, office, district }. Pure.
 */
export function certifiedFederal(election) {
  const out = [];
  for (const c of (election && election.contests) || []) {
    const office = c.scope === "cd" ? "H" : c.scope === "statewide" && /united states senator/i.test(c.office) ? "S" : null;
    if (!office) continue;
    for (const x of c.candidates || []) {
      if (x.fec && /^[HS]\d[A-Z]{2}\d{5}$/.test(x.fec.id || "")) out.push({ id: x.fec.id, name: x.name, office, district: office === "H" ? String(c.district) : null, url: x.fec.url });
    }
  }
  return out;
}

/** Merge today's FEC list (and the certified list's candidates for Congress) into last run's entries. Pure. */
export function mergeList(prev, races, today, certified = []) {
  const out = {};
  for (const [id, c] of Object.entries(prev || {})) out[id] = { ...c, listed: false };
  const add = (c, office, district) => {
    const old = out[c.id] || {};
    out[c.id] = {
      ...old,
      id: c.id,
      name: c.name,
      party: c.party || "",
      office,
      district,
      incumbent: !!c.incumbent,
      committee: c.committee || old.committee || null,
      fec_url: c.url,
      listed: true,
      first_listed: old.first_listed || today,
      last_listed: today,
    };
  };
  for (const c of races.senate || []) add(c, "S", null);
  for (const [d, list] of Object.entries(races.house || {})) for (const c of list) add(c, "H", d);
  // On the certified ballot but not (or not yet) on the FEC's statutory list: included too.
  for (const c of certified) {
    if (out[c.id] && out[c.id].listed) continue;
    const old = out[c.id] || {};
    out[c.id] = { ...old, id: c.id, name: old.name || c.name, party: old.party || "", office: c.office, district: c.district, incumbent: !!old.incumbent, committee: old.committee || null, fec_url: c.url, listed: true, certified_only: true, first_listed: old.first_listed || today, last_listed: today };
  }
  return out;
}

/** Which candidates to refresh first: never read, then the oldest. Pure. */
export function refreshOrder(all) {
  return [...all].sort((a, b) => String(a.c.funding_checked || "").localeCompare(String(b.c.funding_checked || "")) || a.c.id.localeCompare(b.c.id));
}

class OutOfRequests extends Error {}

function client(key, max) {
  let used = 0;
  return {
    get used() {
      return used;
    },
    async get(path) {
      if (used >= max) throw new OutOfRequests();
      used++;
      const url = `${API}${path}${path.includes("?") ? "&" : "?"}api_key=${key}`;
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(url, { headers: { "User-Agent": "ThePillory/1.0 (+https://thepillory.co; public records)" } });
        if (r.ok) return r.json();
        if (r.status === 429) throw new OutOfRequests();
        if (attempt >= 2) throw new Error(`FEC ${r.status} for ${path}`);
        await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
      }
    },
  };
}

async function pacs(fec, committee, cycle) {
  const rows = [];
  let last = null;
  for (let page = 0; page < MAX_PAC_PAGES; page++) {
    const q = last ? `&last_index=${encodeURIComponent(last.last_index)}&last_contribution_receipt_amount=${encodeURIComponent(last.last_contribution_receipt_amount)}` : "";
    const d = await fec.get(`/schedules/schedule_a/?committee_id=${committee}&two_year_transaction_period=${cycle}&line_number=F3-11C&per_page=100&sort=-contribution_receipt_amount${q}`);
    rows.push(...(d.results || []));
    last = d.pagination && d.pagination.last_indexes;
    if (!last || (d.results || []).length < 100) return { rows, complete: true };
  }
  return { rows, complete: false };
}

async function readOne(fec, c, cycle, today) {
  const t = await fec.get(`/candidate/${c.id}/totals/?cycle=${cycle}&election_full=false`);
  const totals = parseTotals((t.results || [])[0], c.id, cycle);
  let organizations = null;
  if (c.committee && totals) {
    const a = await pacs(fec, c.committee, cycle);
    const all = aggregatePacs(a.rows, c.committee, cycle);
    organizations = {
      items: all.slice(0, TOP_ORGS).map(({ committee_id, name, total, count, industry }) => ({ committee_id, name, total, count, industry })),
      count: all.length,
      total: Math.round(all.reduce((s, p) => s + p.total, 0) * 100) / 100,
      complete: a.complete,
      source_url: all[0] ? all[0].source_url : `https://www.fec.gov/data/receipts/?committee_id=${c.committee}&two_year_transaction_period=${cycle}&line_number=F3-11C`,
    };
  }
  let website = c.website || null;
  if (c.committee && (!website || (website.checked || "") < new Date(Date.parse(today) - WEBSITE_DAYS * 864e5).toISOString().slice(0, 10))) {
    const d = await fec.get(`/committee/${c.committee}/`);
    const raw = ((d.results || [])[0] || {}).website || "";
    website = { url: websiteUrl(raw), as_filed: raw || null, source_url: `https://www.fec.gov/data/committee/${c.committee}/`, checked: today };
  }
  return { ...c, totals: totals ? { ...totals, candidate_id: undefined } : null, organizations, website, funding_checked: today, cycle };
}

async function main() {
  const year = Number(arg("year", "2026"));
  const key = process.env.FEC_API_KEY || "DEMO_KEY";
  const max = Number(arg("max-requests", "600"));
  const racesDir = join(ROOT, "data", "elections", `federal-${year}`);
  const outDir = join(ROOT, "data", "candidates", String(year));
  mkdirSync(outDir, { recursive: true });
  const only = String(arg("states", "")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const files = readdirSync(racesDir).filter((f) => /^[a-z]{2}\.json$/.test(f) && (!only.length || only.includes(f.slice(0, 2))));
  const today = new Date().toISOString().slice(0, 10);
  const cycle = year % 2 ? year + 1 : year;

  const states = {};
  for (const f of files) {
    const st = f.slice(0, 2);
    const races = JSON.parse(readFileSync(join(racesDir, f), "utf8"));
    const path = join(outDir, f);
    const prev = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    const certified = readdirSync(join(ROOT, "data", "elections"))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.startsWith(String(year)))
      .map((f) => JSON.parse(readFileSync(join(ROOT, "data", "elections", f), "utf8")))
      .filter((e) => e.election && e.election.state === races.state)
      .flatMap(certifiedFederal);
    states[st] = {
      state: races.state,
      year,
      source: "Federal Election Commission: candidate filings, financial summaries, Schedule A receipts from committees, and Form 1 (campaign website)",
      source_url: races.source_url,
      list_built_on: races.built_on,
      built_on: today,
      senate_up: races.senate_up,
      candidates: mergeList(prev && prev.candidates, races, today, certified),
    };
  }

  const fec = client(key, max);
  const queue = refreshOrder(Object.entries(states).flatMap(([st, s]) => Object.values(s.candidates).filter((c) => c.listed).map((c) => ({ st, c }))));
  let done = 0;
  let failed = 0;
  for (const { st, c } of queue) {
    try {
      states[st].candidates[c.id] = await readOne(fec, c, cycle, today);
      done++;
    } catch (err) {
      if (err instanceof OutOfRequests) break;
      failed++;
      console.error(`${c.id}: ${err.message}`);
    }
  }
  for (const [st, s] of Object.entries(states)) writeFileSync(join(outDir, `${st}.json`), JSON.stringify(s, null, 1) + "\n");
  const listed = queue.length;
  const fresh = Object.values(states).flatMap((s) => Object.values(s.candidates)).filter((c) => c.listed && c.funding_checked).length;
  console.log(`Candidates: ${listed} listed; refreshed ${done} this run (${fec.used} requests, ${failed} failed); ${fresh} of ${listed} have FEC money data.`);
  if (failed > Math.max(5, done)) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
