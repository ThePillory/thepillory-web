#!/usr/bin/env node
// Build the map data for /explore/, /place/ and /district/ from Census Bureau
// files. Runs in GitHub Actions (.github/workflows/map-data.yml), which
// downloads the files, installs the npm packages below and commits the output:
//
//   node tools/build_geo.mjs <work-dir>
//
// Writes, under data/geo/:
//   us.json                   every state's outline, projected for a U.S. map
//                             (Albers USA: Alaska and Hawaii inset), as SVG paths
//   index.json                states: name, counties, which district layers exist
//   places/<st>.json          a state's counties (name, URL slug, neighbors) and
//                             districts, and which districts cover which counties,
//                             fully or partly. No geometry: the pages read this.
//   shapes/<st>-<layer>.json  one layer's outlines for the state map (county, cd,
//                             sldu, sldl), simplified for phones, as SVG paths
//
// Sources (U.S. Census Bureau, public domain):
//   Cartographic boundary files, 2024 (simplified for display):
//     https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_{state_20m,county_500k,cd119_500k,sldu_500k,sldl_500k}.zip
//   Block equivalency files (which district each 2020 census block is in), the
//   same ones the ZIP lookup uses (tools/build_zip_districts.py):
//     .../mapping-files/2025/119-congressional-district-befs/cd119.zip
//     .../mapping-files/2025/2024-state-legislative-bef/sldu24.zip and sldl24.zip
// A district "covers part" of a county when some of the county's blocks are in
// another district.
//
// npm packages (installed by the workflow only; the site has no npm):
//   shapefile, topojson-server, topojson-simplify, topojson-client, d3-geo
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as shapefile from "shapefile";
import { topology } from "topojson-server";
import { presimplify, simplify, quantile } from "topojson-simplify";
import { feature, neighbors } from "topojson-client";
import { geoPath, geoAlbersUsa, geoTransverseMercator, geoCentroid } from "d3-geo";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "geo");
const work = process.argv[2] || "/tmp/geobuild";

const STATE_BY_FIPS = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
  "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
  "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY",
};
// The lower chamber's name where it isn't "State House"; Nebraska has one chamber.
const LOWER = { CA: "Assembly", NV: "Assembly", NY: "Assembly", WI: "Assembly", NJ: "General Assembly", MD: "House of Delegates", VA: "House of Delegates", WV: "House of Delegates" };
const chambers = (st) => (st === "NE" ? { sldu: "Legislature" } : st === "DC" ? {} : { sldu: "State Senate", sldl: LOWER[st] || "State House" });

/** "05" → "5"; at-large ("00") and delegate ("98") → "0"; letters kept (lowercased); "ZZZ" (no district) → null. */
export function districtId(code) {
  const c = String(code || "").trim();
  if (!c || /^Z+$/i.test(c)) return null;
  if (/^\d+$/.test(c)) {
    const n = parseInt(c, 10);
    return n === 0 || n === 98 ? "0" : String(n);
  }
  return c.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** URL slug for a county: "Calaveras County" → "calaveras"; "Baltimore city" → "baltimore-city". */
export function countySlug(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+(County|Parish|Borough|Census Area|City and Borough|Municipality|Municipio)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function readShp(name) {
  const base = path.join(work, name);
  const src = await shapefile.open(`${base}.shp`, `${base}.dbf`, { encoding: "utf-8" });
  const out = [];
  for (;;) {
    const r = await src.read();
    if (r.done) return out;
    out.push(r.value);
  }
}

function readBef(dir) {
  // The national file first; per-state files (newer, e.g. after a court-ordered map) replace it.
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).sort((a, b) => (a.startsWith("National") ? -1 : b.startsWith("National") ? 1 : a.localeCompare(b)));
  const out = new Map();
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").replace(/^﻿/, "").split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const [geoid, code] = line.split(/[,|]/);
      if (geoid && code !== undefined) out.set(geoid.trim(), code.trim());
    }
  }
  console.log(`${dir}: ${out.size} blocks`);
  return out;
}

/** {district: {county: blocks}} and {county: blocks} for one layer. */
function overlaps(bef) {
  const byCounty = new Map();
  const pairs = new Map();
  for (const [block, code] of bef) {
    const id = districtId(code);
    if (!id) continue;
    const st = STATE_BY_FIPS[block.slice(0, 2)];
    if (!st) continue;
    const county = block.slice(0, 5);
    byCounty.set(county, (byCounty.get(county) || 0) + 1);
    const k = `${st}|${id}|${county}`;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  return { byCounty, pairs };
}

const write = (rel, data) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data) + "\n");
  return fs.statSync(file).size;
};

/** Simplified SVG paths for one layer of one state. */
function layerPaths(features, projection, keep) {
  if (!features.length) return [];
  let topo = topology({ f: { type: "FeatureCollection", features } }, 1e5);
  topo = presimplify(topo);
  topo = simplify(topo, quantile(topo, keep));
  const fc = feature(topo, topo.objects.f);
  const p = geoPath(projection).digits(1);
  return fc.features.map((f) => ({ id: f.properties.id, d: p(f) })).filter((x) => x.d);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const states = (await readShp("cb_2024_us_state_20m")).filter((f) => STATE_BY_FIPS[f.properties.STATEFP]);
  const counties = (await readShp("cb_2024_us_county_500k")).filter((f) => STATE_BY_FIPS[f.properties.STATEFP]);
  const cds = (await readShp("cb_2024_us_cd119_500k")).filter((f) => STATE_BY_FIPS[f.properties.STATEFP]);
  const sldus = (await readShp("cb_2024_us_sldu_500k")).filter((f) => STATE_BY_FIPS[f.properties.STATEFP]);
  const sldls = (await readShp("cb_2024_us_sldl_500k")).filter((f) => STATE_BY_FIPS[f.properties.STATEFP]);
  console.log(`shapes: ${states.length} states, ${counties.length} counties, ${cds.length} cd, ${sldus.length} sldu, ${sldls.length} sldl`);

  const ov = { cd: overlaps(readBef(path.join(work, "cd119"))), sldu: overlaps(readBef(path.join(work, "sldu24"))), sldl: overlaps(readBef(path.join(work, "sldl24"))) };

  // 1. The U.S. map (Albers USA, 975 × 610, as the us-atlas package draws it).
  const us = geoAlbersUsa().scale(1300).translate([487.5, 305]);
  const usStates = states.map((f) => ({ ...f, properties: { id: f.properties.STUSPS } }));
  const usPaths = layerPaths(usStates, us, 0.12);
  const names = Object.fromEntries(states.map((f) => [f.properties.STUSPS, f.properties.NAME]));
  console.log("us.json", write("us.json", { viewBox: "0 0 975 610", states: usPaths.map((s) => ({ st: s.id, name: names[s.id], d: s.d })) }), "bytes");

  // 2. Each state.
  const index = [];
  for (const [fips, st] of Object.entries(STATE_BY_FIPS).sort((a, b) => a[1].localeCompare(b[1]))) {
    const outline = states.find((f) => f.properties.STATEFP === fips);
    if (!outline) continue;
    const [cx, cy] = geoCentroid(outline);
    const proj = geoTransverseMercator().rotate([-cx, -cy]).fitExtent([[4, 4], [796, 796]], outline);
    const width = 800;
    const b = geoPath(proj).bounds(outline);
    const viewBox = `0 0 ${width} ${Math.ceil(b[1][1] + 4)}`;

    const cf = counties.filter((f) => f.properties.STATEFP === fips);
    const countyFeatures = cf.map((f) => ({ ...f, properties: { id: f.properties.GEOID } }));
    // Neighbors share a border in the county topology.
    const ctopo = topology({ c: { type: "FeatureCollection", features: countyFeatures } }, 1e5);
    const nb = neighbors(ctopo.objects.c.geometries);
    const ids = ctopo.objects.c.geometries.map((g) => g.properties.id);
    const ch = chambers(st);
    const layers = { county: countyFeatures, cd: [], sldu: [], sldl: [] };
    layers.cd = cds.filter((f) => f.properties.STATEFP === fips).map((f) => ({ ...f, properties: { id: districtId(f.properties.CD119FP) } })).filter((f) => f.properties.id);
    if (ch.sldu) layers.sldu = sldus.filter((f) => f.properties.STATEFP === fips).map((f) => ({ ...f, properties: { id: districtId(f.properties.SLDUST) } })).filter((f) => f.properties.id);
    if (ch.sldl) layers.sldl = sldls.filter((f) => f.properties.STATEFP === fips).map((f) => ({ ...f, properties: { id: districtId(f.properties.SLDLST) } })).filter((f) => f.properties.id);

    // Which districts cover which counties (from blocks).
    const place = { st, name: names[st], chambers: ch, layers: [], counties: [], districts: {} };
    const countyRows = cf
      .map((f) => ({ fips: f.properties.GEOID, name: f.properties.NAMELSAD || f.properties.NAME, slug: countySlug(f.properties.NAMELSAD || f.properties.NAME) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // A slug used twice in a state (rare) gets the FIPS code.
    const seen = {};
    for (const c of countyRows) seen[c.slug] = (seen[c.slug] || 0) + 1;
    for (const c of countyRows) if (seen[c.slug] > 1) c.slug = `${c.slug}-${c.fips}`;
    const byFips = new Map(countyRows.map((c) => [c.fips, { ...c, neighbors: [], cd: [], sldu: [], sldl: [] }]));
    ids.forEach((id, i) => {
      const c = byFips.get(id);
      if (c) c.neighbors = nb[i].map((j) => ids[j]).filter((x) => byFips.has(x)).sort();
    });
    for (const layer of ["cd", "sldu", "sldl"]) {
      if (layer !== "cd" && !ch[layer]) continue;
      const { byCounty, pairs } = ov[layer];
      const dist = {};
      for (const [k, blocks] of pairs) {
        const [s, id, county] = k.split("|");
        if (s !== st || !byFips.has(county)) continue;
        const full = blocks === byCounty.get(county);
        byFips.get(county)[layer].push([id, full ? 1 : 0]);
        (dist[id] ||= []).push([county, full ? 1 : 0]);
      }
      if (Object.keys(dist).length) {
        place.districts[layer] = Object.fromEntries(Object.entries(dist).sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })).map(([id, cs]) => [id, cs.sort()]));
      }
    }
    for (const c of byFips.values()) for (const l of ["cd", "sldu", "sldl"]) c[l].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }));
    place.counties = [...byFips.values()];

    // Shapes, one file per layer. Fewer points for bigger layers.
    const sizes = {};
    for (const [layer, feats] of Object.entries(layers)) {
      if (!feats.length) continue;
      const keep = feats.length > 150 ? 0.06 : feats.length > 60 ? 0.1 : 0.16;
      const paths = layerPaths(feats, proj, keep);
      sizes[layer] = write(`shapes/${st.toLowerCase()}-${layer}.json`, { viewBox, paths });
      place.layers.push(layer);
    }
    write(`places/${st.toLowerCase()}.json`, place);
    index.push({ st, fips, name: names[st], counties: place.counties.length, layers: place.layers, chambers: ch });
    console.log(st, place.counties.length, "counties", JSON.stringify(sizes));
  }
  write("index.json", index);
  console.log(`${index.length} states`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
