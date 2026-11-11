// Writing only what changed (docs/data-sync.md, "What Cloudflare costs"): D1 bills every row
// written and every index entry it touches, so a row read again unchanged must write nothing.
// Pure (no bindings, no .sql imports), so Pages Functions and the tests can import it.

/**
 * The WHERE clause that makes an upsert write only when a value changed: D1 bills every row
 * written (and each index entry), so a row read again unchanged must write nothing.
 * `differs("officials", ["name", "office"])` → "officials.name IS NOT excluded.name OR …". Pure.
 */
export function differs(table, cols) {
  return cols.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(" OR ");
}

/**
 * Write only what changed in one scope (an official's cycle, a committee's report…), instead of
 * deleting the scope and inserting it again: reads the scope's rows (a read costs a thousandth of
 * a write), then returns the statements that insert new or changed rows and delete rows that are
 * gone. `key` names the columns that identify a row within the table. Rows are plain objects with
 * every column in `cols`. `stamp` (e.g. "updated_at") is set to the time on each row written.
 * Returns { stmts, inserted, updated, deleted, same }.
 */
export async function syncScope(db, { table, scope, key, cols, rows, stamp = null }) {
  const where = Object.keys(scope);
  const { results: have } = await db
    .prepare(`SELECT ${[...new Set([...key, ...cols])].join(", ")} FROM ${table} WHERE ${where.map((c) => `${c} IS ?`).join(" AND ") || "1"}`)
    .bind(...where.map((c) => scope[c]))
    .all();
  const id = (r) => JSON.stringify(key.map((c) => (r[c] == null ? null : String(r[c]))));
  const norm = (v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);
  const old = new Map(have.map((r) => [id(r), r]));
  const out = { stmts: [], inserted: 0, updated: 0, deleted: 0, same: 0 };
  const seen = new Set();
  for (const r of rows) {
    const k = id(r);
    if (seen.has(k)) continue; // the same row twice: the first wins, as INSERT OR IGNORE would
    seen.add(k);
    const prev = old.get(k);
    if (prev && cols.every((c) => norm(prev[c]) === norm(r[c]) || (typeof prev[c] === "number" && Number(r[c]) === prev[c]))) {
      out.same += 1;
      continue;
    }
    const all = [...new Set([...where, ...key, ...cols])];
    const value = (c) => norm(c in scope ? scope[c] : r[c]);
    const set = all.filter((c) => !key.includes(c) && !where.includes(c));
    if (stamp) set.push(stamp);
    out.stmts.push(
      db
        .prepare(
          `INSERT INTO ${table} (${[...all, ...(stamp ? [stamp] : [])].join(", ")}) VALUES (${all.map(() => "?").join(", ")}${stamp ? ", datetime('now')" : ""})` +
            (set.length ? ` ON CONFLICT DO UPDATE SET ${set.map((c) => `${c} = excluded.${c}`).join(", ")}` : " ON CONFLICT DO NOTHING")
        )
        .bind(...all.map(value))
    );
    if (prev) out.updated += 1;
    else out.inserted += 1;
  }
  for (const [k, r] of old) {
    if (seen.has(k)) continue;
    out.stmts.push(
      db.prepare(`DELETE FROM ${table} WHERE ${[...where, ...key].map((c) => `${c} IS ?`).join(" AND ")}`).bind(...where.map((c) => scope[c]), ...key.map((c) => r[c]))
    );
    out.deleted += 1;
  }
  return out;
}
