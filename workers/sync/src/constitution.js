// The Constitution's text, from data/constitution.json (public domain; checked
// against the National Archives transcription by tools/check_constitution.py).
// Loaded into D1 so pages can quote it; the analysis pipeline quotes only this.
import data from "../../../data/constitution.json" with { type: "json" };
import { getState, setState } from "./util.js";

export const CONSTITUTION_VERSION = data.version;
export const PROVISIONS = data.provisions;
export const BY_ID = new Map(PROVISIONS.map((p) => [p.id, p]));
export const LEAVES = PROVISIONS.filter((p) => p.leaf);

/** Write the text to D1 when the stored version differs. Returns rows written. */
export async function loadConstitution(db) {
  const key = "constitution_version";
  const stored = await getState(db, key);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM constitution_provisions").first();
  if (stored === CONSTITUTION_VERSION && count && count.n === PROVISIONS.length) return 0;
  const stmts = [db.prepare("DELETE FROM constitution_provisions")];
  PROVISIONS.forEach((p, i) =>
    stmts.push(
      db
        .prepare(
          "INSERT INTO constitution_provisions (id, parent_id, kind, label, text, leaf, sort, source_url, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(p.id, p.parent, p.kind, p.label, p.text, p.leaf ? 1 : 0, i, p.source_url, CONSTITUTION_VERSION)
    )
  );
  await db.batch(stmts);
  await setState(db, key, CONSTITUTION_VERSION);
  return PROVISIONS.length;
}
