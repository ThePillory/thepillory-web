// Checks on the transcription of a scanned OGE Form 278-T (docs/trades.md).
// Pure: no I/O, so the admin page can use them too.
//
// A scanned report is read twice, by two different models, from the PDF. The
// rows count as read only when:
//   - both readings list the same numbered rows, 1 to N with none missing;
//   - they agree on every row: the date, the type, the amount range exactly,
//     and the description letter for letter (spaces and punctuation aside);
//   - neither model marked a cell as hard to read;
//   - every date is a whole date, every amount a whole range, every type one
//     of the form's;
//   - every row the report's own text layer shows is there, and no row's
//     type contradicts it (the text layer is too garbled to be the record, but
//     it was made from the same scan independently).
// A problem of kind "block" keeps the report a link; "look" is shown to the
// person who checks the rows against the scan.

const RANGE = /^(?:Spouse\/DC )?Over \$[\d,]{5,}$|^\$[\d,]{3,} - \$[\d,]{4,}$/;

export const normAmount = (a) => String(a || "").replace(/\s+/g, " ").replace(/\s*-\s*/g, " - ").trim();

/** [min, max] in dollars; max null for "Over $X". Pure. */
export function amountBounds(a) {
  const nums = (normAmount(a).match(/\$[\d,]+/g) || []).map((x) => parseInt(x.replace(/[$,]/g, ""), 10));
  if (/^(?:Spouse\/DC )?Over /.test(normAmount(a))) return [nums[0] != null ? nums[0] + 1 : null, null];
  return [nums[0] ?? null, nums[1] ?? null];
}

/** A whole range as the form prints them ("$1,001 - $15,000", "Over $50,000,000"). Pure. */
export function fullRange(a) {
  const s = normAmount(a);
  if (!RANGE.test(s)) return false;
  const [lo, hi] = amountBounds(s);
  return hi == null || (lo != null && lo < hi);
}

/** The form's transaction types, as the site labels them; null for anything else. Pure. */
export function typeLabel(raw) {
  const t = String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["p", "purchase"].includes(t)) return "Purchase";
  if (["sale (partial)", "partial sale", "s (partial)"].includes(t)) return "Partial sale";
  if (["s", "sale", "sale (full)", "s (full)"].includes(t)) return "Sale";
  if (["e", "exchange"].includes(t)) return "Exchange";
  return null;
}

/** "7/22/2026" -> "2026-07-22"; null unless a real date with a four-digit year. Pure. */
export function isoDate(raw) {
  const m = String(raw || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [mo, d, y] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1990) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Letters and digits only, upper case: how two readings of a description are compared. Pure. */
export const letters = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Owner only where the description states it; never a name. Pure. */
export function ownerOf(desc) {
  const d = String(desc || "");
  if (/\((?:SP|spouse)\)|\bspouse\b/i.test(d)) return "Spouse";
  if (/\((?:DC|dependent child)\)|\bdependent child\b/i.test(d)) return "Dependent child";
  if (/\((?:JT|joint)\)/i.test(d)) return "Joint";
  return null;
}

/** "Apple Inc. (AAPL)" -> "AAPL". Pure. */
export function tickerOf(desc) {
  const m = [...String(desc || "").matchAll(/\(([A-Z][A-Z0-9.\-]{0,9})\)/g)].filter((x) => !["SP", "DC", "JT"].includes(x[1]));
  return m.length ? m[m.length - 1][1] : null;
}

const bigrams = (s) => {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
};

/** How much of a reading's description the text-layer line contains (0–1), by letter pairs. Pure. */
export function contained(desc, line) {
  const a = bigrams(letters(desc).replace(/\d/g, ""));
  if (!a.size) return 0;
  const b = bigrams(letters(line).replace(/\d/g, ""));
  let hit = 0;
  for (const x of a) if (b.has(x)) hit += 1;
  return hit / a.size;
}

/** What a garbled text-layer line says the type is, when it says anything: "Purchase", "Sale" or null. Pure. */
export function textLayerType(line) {
  const s = String(line || "").toLowerCase();
  if (/urch|ourc|rchas|purc/.test(s)) return "Purchase";
  if (/\bsale\b|\bsaie\b|\bsa1e\b/.test(s)) return "Sale";
  return null;
}

/**
 * Compare two readings ({rows: [{n, description, type, date, amount, uncertain, note}]})
 * and the text layer ({n: line}). Returns {rows, problems}: rows are the agreed
 * rows ready to store, problems [{n, kind: 'block'|'look', text}].
 */
export function checkReadings(a, b, lines = {}) {
  const problems = [];
  const block = (n, text) => problems.push({ n, kind: "block", text });
  const look = (n, text) => problems.push({ n, kind: "look", text });
  const byN = (r) => new Map((r && Array.isArray(r.rows) ? r.rows : []).map((x) => [Number(x.n), x]));
  const A = byN(a);
  const B = byN(b);
  if (!A.size || !B.size) {
    block(null, `${!A.size ? "The first reading" : "The second reading"} found no transactions.`);
    return { rows: [], problems };
  }
  const ns = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y);
  ns.forEach((n, i) => {
    if (n !== i + 1) block(n, `Rows aren't numbered 1 to ${ns.length} without gaps (row ${i + 1} expected, ${n} found).`);
  });
  const rows = [];
  for (const n of ns) {
    const x = A.get(n);
    const y = B.get(n);
    if (!x || !y) {
      block(n, `Row ${n} is in only ${x ? "the first" : "the second"} reading.`);
      continue;
    }
    if (x.uncertain || y.uncertain) block(n, `Row ${n}: marked hard to read${[x.note, y.note].filter(Boolean).length ? ` (${[x.note, y.note].filter(Boolean).join("; ")})` : ""}.`);
    const dateKey = (v) => isoDate(v) || `as printed: ${String(v || "").trim()}`;
    const typeKey = (v) => typeLabel(v) || `as printed: ${String(v || "").trim().toLowerCase()}`;
    const fields = [
      ["date", dateKey(x.date), dateKey(y.date), x.date, y.date],
      ["type", typeKey(x.type), typeKey(y.type), x.type, y.type],
      ["amount", normAmount(x.amount), normAmount(y.amount), x.amount, y.amount],
      ["description", letters(x.description), letters(y.description), x.description, y.description],
    ];
    let same = true;
    for (const [field, p, q, rawP, rawQ] of fields) {
      if (p !== q) {
        same = false;
        block(n, `Row ${n}: the readings differ on the ${field} ("${rawP ?? ""}" and "${rawQ ?? ""}").`);
      }
    }
    if (!same) continue;
    let valid = true;
    const invalid = (text) => ((valid = false), block(n, text));
    if (!isoDate(x.date)) invalid(`Row ${n}: "${x.date}" isn't a whole date.`);
    if (!typeLabel(x.type)) invalid(`Row ${n}: "${x.type}" isn't one of the form's transaction types.`);
    if (!fullRange(x.amount)) invalid(`Row ${n}: "${x.amount}" isn't a whole amount range.`);
    if (!letters(x.description)) invalid(`Row ${n}: no description.`);
    if (!valid) continue;
    const description = String(x.description).replace(/\s+/g, " ").trim();
    const [lo, hi] = amountBounds(x.amount);
    rows.push({
      n,
      description,
      type: typeLabel(x.type),
      date: isoDate(x.date),
      amount: normAmount(x.amount),
      amount_min: lo,
      amount_max: hi,
      owner: ownerOf(description),
      ticker: tickerOf(description),
    });
  }
  const textNs = Object.keys(lines).map(Number).sort((p, q) => p - q);
  if (!textNs.length) {
    look(null, "The report has no usable text layer, so only the two readings were compared: check every row against the scan.");
  } else {
    let weak = 0;
    for (const n of textNs) {
      const r = rows.find((z) => z.n === n);
      if (!A.has(n) || !B.has(n)) {
        block(n, `Row ${n} is in the report's text layer but not in both readings.`);
        continue;
      }
      if (!r) continue;
      const t = textLayerType(lines[n]);
      if (t && t !== (r.type === "Partial sale" ? "Sale" : r.type)) block(n, `Row ${n}: the text layer reads "${lines[n].slice(0, 120)}", which looks like a ${t.toLowerCase()}, not a ${r.type.toLowerCase()}.`);
      if (contained(r.description, lines[n]) < 0.5) {
        weak += 1;
        look(n, `Row ${n}: the text layer's version is too garbled to confirm the description ("${lines[n].slice(0, 120)}"). Check it against the scan.`);
      }
    }
    if (weak > textNs.length * 0.2) block(null, `For ${weak} of the ${textNs.length} rows in the text layer, the descriptions couldn't be matched; too many to trust.`);
  }
  return { rows, problems };
}

export const blocking = (problems) => (problems || []).some((p) => p.kind === "block");
