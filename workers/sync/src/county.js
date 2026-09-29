// County Board of Supervisors: entered by hand in data/county-officials.json,
// published with the site, and loaded here on every sync.
import { upsertOfficial, deactivateOthers } from "./db.js";
import { isHttp, slugify } from "./util.js";

const REQUIRED = ["name", "source_url", "last_verified"];

export async function syncCounty(env, db, budget) {
  const url = `${(env.SITE_URL || "").replace(/\/$/, "")}/data/county-officials.json`;
  const data = await budget.json(url, {}, "county-officials.json");
  const entries = Array.isArray(data.officials) ? data.officials : [];
  const loaded = [];
  const skipped = [];
  for (const entry of entries) {
    const district = String(entry.district || "").trim();
    const missing = REQUIRED.filter((k) => !String(entry[k] || "").trim());
    if (!district) {
      skipped.push("an entry with no district");
      continue;
    }
    if (missing.length) {
      skipped.push(`District ${district} (missing ${missing.join(", ")})`);
      continue;
    }
    if (!isHttp(entry.source_url)) {
      skipped.push(`District ${district} (source_url must start with http)`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.last_verified)) {
      skipped.push(`District ${district} (last_verified must be YYYY-MM-DD)`);
      continue;
    }
    const id = `county:d${slugify(district)}`;
    const name = entry.name.trim();
    await upsertOfficial(db, {
      id,
      slug: slugify(name),
      name,
      last_name: name.split(/\s+/).pop(),
      office: entry.office || `Supervisor, District ${district}`,
      level: "county",
      chamber: "county-board",
      body: "board-of-supervisors",
      district: `District ${district}`,
      party: (entry.party || "").trim() || null,
      term_start: entry.term_start || null,
      term_end: entry.term_end || null,
      website: isHttp(entry.website) ? entry.website : null,
      photo_url: isHttp(entry.photo_url) ? entry.photo_url : null,
      photo_credit: entry.photo_credit || null,
      source_url: entry.source_url,
      last_verified: entry.last_verified,
    });
    loaded.push(id);
  }
  // Entries that were emptied or removed stop showing.
  await deactivateOthers(db, "county-board", loaded);
  const parts = [`loaded ${loaded.length} of ${entries.length}`];
  if (skipped.length) parts.push(`skipped: ${skipped.join("; ")}`);
  return { status: loaded.length === entries.length ? "ok" : "partial", message: parts.join(". ") };
}
