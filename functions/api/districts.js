// POST /api/districts   {"q": "<street address or ZIP code>"}  (JSON from assets/app.js, or a plain form post)
//   ->  {"found": true, "districts": {st, cd, su, sl, co}, "county": "…"}
//   or  {"found": false, "choices": [{districts, label}]}  when a ZIP spans more than one set of districts
//   or  {"found": false, "error": "…"}
//
// A street address is looked up with the U.S. Census Geocoder (free, no key).
// The Census service doesn't allow calls straight from a browser, so this
// Function passes the address on and returns only the district IDs. A ZIP
// code is looked up in data/zip/ (built from Census files by
// tools/build_zip_districts.py). The address or ZIP is never stored, logged
// or returned: not in D1, not in a cookie, not in the response. The
// visitor's browser keeps the district IDs (the pillory_districts cookie).
// A plain form post (no JavaScript) gets the cookie set and goes to Home.
//
// Districts are those of the Congress now in session (currentCongress), so
// they match the members loaded from Congress.gov. The Census "Current"
// vintage already shows the next Congress's districts, so the vintage is
// chosen by name. When the 120th Congress starts (January 2027), set
// CENSUS_VINTAGE to the vintage whose layer is "120th Congressional Districts".
import { STATE_BY_FIPS, CALAVERAS_FIPS, cleanDistricts, describe, COOKIE } from "../_lib/districts.js";
import { page, esc } from "../_lib/render.js";

const GEOCODER = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
// Layers: 54 congressional districts, 56 state senate, 58 state lower house, 82 counties.
const LAYERS = "54,56,58,82";
const DEFAULT_VINTAGE = "ACS2025_Current"; // "119th Congressional Districts", "2024 State Legislative Districts"

function congressNow(date = new Date()) {
  const y = date.getUTCFullYear();
  const year = date.getUTCMonth() === 0 && date.getUTCDate() < 3 ? y - 1 : y;
  return Math.floor((year - 1789) / 2) + 1;
}

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** District IDs from one geocoder match. Pure; tested. */
export function districtsFromMatch(match, congress = congressNow()) {
  const g = (match && match.geographies) || {};
  const first = (re) => {
    const key = Object.keys(g).find((k) => re.test(k));
    return key && g[key] && g[key][0] ? [key, g[key][0]] : [null, null];
  };
  const [cdKey, cd] = first(/Congressional Districts$/);
  const [, su] = first(/State Legislative Districts - Upper$/);
  const [, sl] = first(/State Legislative Districts - Lower$/);
  const [, county] = first(/^Counties$/);
  const fips = (county && county.STATE) || (cd && cd.STATE) || (su && su.STATE);
  const st = STATE_BY_FIPS[fips];
  if (!st) return null;
  const cdMatches = cdKey && new RegExp(`^${congress}(st|nd|rd|th) `).test(cdKey);
  const raw = {
    st,
    // BASENAME is the district number; at-large seats and delegates have none ("00", "98").
    cd: cdMatches && cd ? (/^\d+$/.test(cd.BASENAME || "") ? cd.BASENAME : "0") : null,
    su: su && /^\d+$/.test(su.BASENAME || "") ? su.BASENAME : null,
    sl: sl && /^\d+$/.test(sl.BASENAME || "") ? sl.BASENAME : null,
    co: county && /^\d{5}$/.test(county.GEOID || "") ? county.GEOID : null,
  };
  return { districts: cleanDistricts(raw), county: county ? county.NAME : null, cdChecked: !!cdMatches };
}

async function lookupAddress(env, address) {
  const q = new URLSearchParams({
    address,
    benchmark: "Public_AR_Current",
    vintage: env.CENSUS_VINTAGE || DEFAULT_VINTAGE,
    layers: LAYERS,
    format: "json",
  });
  let data;
  try {
    const res = await fetch(`${env.CENSUS_GEOCODER_URL || GEOCODER}?${q}`, {
      headers: { "User-Agent": "ThePillory/1.0 (+https://thepillory.co)" },
    });
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch (_) {
    return { found: false, error: "The Census address lookup didn't answer. Try again in a minute, or use your ZIP code." };
  }
  const matches = (data && data.result && data.result.addressMatches) || [];
  if (!matches.length) return { found: false, error: "The Census Bureau couldn't find that address. Check the street, city and state, or use your ZIP code." };
  const out = districtsFromMatch(matches[0]);
  if (!out || !out.districts) return { found: false, error: "That address isn't in a state or territory the lookup covers." };
  return { found: true, districts: out.districts, county: out.county };
}

async function asset(env, request, path) {
  if (!env.ASSETS) return null;
  const res = await env.ASSETS.fetch(new URL(path, request.url));
  return res.ok ? res.json() : null;
}

const MIN_CHOICE_SHARE = 0.02; // parts of a ZIP smaller than this aren't offered as a choice

/**
 * ZIP -> one set of districts, or choices. Options are [st, cd, su, sl, county, share]
 * (data/zip/). The county only matters for Calaveras (the county briefing),
 * so choices that differ only by another county count as one. Pure; tested.
 */
export function zipResult(options, counties = {}) {
  if (!options || !options.length) return { found: false, error: "That ZIP code isn't one of the Census Bureau's ZIP code areas. Try your street address." };
  const merged = new Map();
  for (const [st, cd, su, sl, co, share] of options) {
    const districts = cleanDistricts({ st, cd, su, sl, co: co === CALAVERAS_FIPS ? co : "" });
    if (!districts) continue;
    const key = JSON.stringify(districts);
    const m = merged.get(key) || { districts, share: 0, county: counties[co] ? counties[co][0] : null };
    m.share += Number(share) || 0;
    merged.set(key, m);
  }
  const all = [...merged.values()].sort((x, y) => y.share - x.share);
  if (!all.length) return { found: false, error: "That ZIP code isn't in a state or territory the lookup covers." };
  const kept = all.filter((c) => c.share >= MIN_CHOICE_SHARE);
  const choices = kept.length ? kept : all.slice(0, 1);
  if (choices.length === 1) return { found: true, districts: choices[0].districts, county: choices[0].county };
  return {
    found: false,
    choices: choices.map((c) => ({ districts: c.districts, label: [describe(c.districts), c.districts.co ? "Calaveras County" : null].filter(Boolean).join(" · ") })),
  };
}

// Name the reps for each choice, so a visitor can recognize their district.
async function withNames(env, result) {
  if (!result.choices || !env.DB) return result;
  try {
    for (const c of result.choices) {
      const d = c.districts;
      const { results } = await env.DB
        .prepare(
          `SELECT name, chamber FROM officials WHERE active = 1 AND state = ? AND (
             (chamber = 'us-house' AND district_code = ?) OR (chamber = 'ca-senate' AND district_code = ?) OR (chamber = 'ca-assembly' AND district_code = ?))
           ORDER BY chamber DESC`
        )
        .bind(d.st, d.cd || "", d.st === "CA" ? d.su || "" : "", d.st === "CA" ? d.sl || "" : "")
        .all();
      if (results.length) c.label += ` (${results.map((r) => r.name).join(", ")})`;
    }
  } catch (_) {
    // Without names the district numbers still identify each choice.
  }
  return result;
}

async function lookup(env, request, q) {
  const text = String(q || "").replace(/\s+/g, " ").trim();
  const zip = /^(\d{5})(?:-\d{4})?$/.exec(text);
  if (zip) {
    const file = await asset(env, request, `/data/zip/${zip[1].slice(0, 3)}.json`);
    return withNames(env, zipResult(file ? file[zip[1]] : null));
  }
  if (text.length < 5 || text.length > 200) return { found: false, error: "Enter a street address with city and state, or a 5-digit ZIP code." };
  return lookupAddress(env, text);
}

export function cookieHeader(d) {
  const value = encodeURIComponent(new URLSearchParams(d).toString());
  return `${COOKIE}=${value}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
}

// The no-JavaScript path: a page to pick among a ZIP's districts.
// Where a plain form post goes after the lookup: the briefing, or a ballot page that sent it.
const NEXT_OK = /^\/(briefing|elections\/\d{4}-\d{2}-\d{2}\/ballot)\/$/;
const nextPath = (v) => (NEXT_OK.test(String(v || "")) ? String(v) : "/briefing/");

function choicePage(result, next) {
  const options = result.choices
    .map(
      (c, i) => `
    <label class="choice"><input type="radio" name="pick" value="${esc(new URLSearchParams(c.districts).toString())}"${i === 0 ? " checked" : ""} /> <span>${esc(c.label)}</span></label>`
    )
    .join("");
  return page(
    "Choose your districts",
    `<header class="page-head"><h1>Choose your districts</h1><p class="subtitle">This ZIP code is split between districts. Choose yours, or go back and enter your street address.</p></header>
<form class="card stack-sm" method="post" action="/api/districts">${options}
  <input type="hidden" name="next" value="${esc(next)}" />
  <button class="btn btn--primary" type="submit">Use these districts</button>
</form>
<p class="small"><a class="inline-link" href="/#find">Enter a street address instead</a></p>`,
    { tab: "home", back: ["Home", "/"], personal: true }
  );
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const type = request.headers.get("Content-Type") || "";
  if (type.includes("application/json")) {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return reply({ found: false, error: "Send {\"q\": \"…\"}." }, 400);
    }
    return reply(await lookup(env, request, body && (body.q || body.address)));
  }
  // Plain form post.
  const form = await request.formData();
  const back = (q) => Response.redirect(`${url.origin}/?${q}#find`, 303);
  const pick = form.get("pick");
  const next = nextPath(form.get("next"));
  let result = pick ? { found: true, districts: cleanDistricts(Object.fromEntries(new URLSearchParams(String(pick)))) } : await lookup(env, request, form.get("q"));
  if (result.found && result.districts) {
    return new Response(null, { status: 303, headers: { Location: `${url.origin}${next}`, "Set-Cookie": cookieHeader(result.districts), "Cache-Control": "no-store" } });
  }
  if (result.choices) return choicePage(result, next);
  return back("lookup=notfound");
}

export function onRequestGet() {
  return reply({ error: "Use POST with {\"q\": \"<address or ZIP>\"}. Nothing you send is stored." }, 405);
}
