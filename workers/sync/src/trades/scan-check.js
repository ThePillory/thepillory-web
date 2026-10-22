// Checks on the transcription of a scanned OGE Form 278-T (docs/trades.md).
// Pure: no I/O, so the admin page can use them too.
//
// A scanned report is read by one model; the rows its text layer backs up
// (textBacks() in scan-sync.js) count as their own second reading, and the
// rest are read again by a second model. Each row is judged on its own. A row
// passes only when:
//   - it's in both readings, under the same row number;
//   - they agree on it exactly: the date, the type, the amount range, and the
//     description letter for letter (spaces and punctuation aside);
//   - neither model marked a cell in it as hard to read;
//   - its date is a whole date, its amount a whole range, its type one of the form's;
//   - the report's own text layer (too garbled to be the record, but made from
//     the same scan independently) doesn't show a different type for it.
// Every other row is "unread": the page says it couldn't be read with
// confidence and links the scan. Rows are numbered 1 to the highest number
// either reading found; a number neither reading has is unread too.
// The whole report is held for a person (nothing published) only when the
// readings can't be trusted as a set: a reading found nothing, or the text
// layer suggests both readings shifted the rows (each description matching the
// neighboring row's line better than its own).
// Problems of kind "block" are those report-level holds; "look" is shown to
// the person who checks the rows against the scan.

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
 * and the text layer ({n: line}). Returns {rows, unread, total, problems}:
 * rows are the agreed rows ready to store, unread [{n, reason}] the rest,
 * total the report's row count as read, problems [{n, kind: 'block'|'look', text}].
 */
export function checkReadings(a, b, lines = {}) {
  const problems = [];
  const block = (n, text) => problems.push({ n, kind: "block", text });
  const look = (n, text) => problems.push({ n, kind: "look", text });
  const byN = (r) => new Map((r && Array.isArray(r.rows) ? r.rows : []).filter((x) => Number.isInteger(Number(x.n)) && Number(x.n) > 0).map((x) => [Number(x.n), x]));
  const A = byN(a);
  const B = byN(b);
  if (!A.size || !B.size) {
    block(null, `${!A.size ? "The first reading" : "The second reading"} found no transactions.`);
    return { rows: [], unread: [], total: 0, problems };
  }
  const total = Math.max(...A.keys(), ...B.keys());
  const rows = [];
  const unread = [];
  const skip = (n, reason) => unread.push({ n, reason });
  for (let n = 1; n <= total; n++) {
    const x = A.get(n);
    const y = B.get(n);
    if (!x && !y) {
      skip(n, "Not found in either reading.");
      continue;
    }
    if (!x || !y) {
      skip(n, `Only in ${x ? "the first" : "the second"} reading.`);
      continue;
    }
    if (x.uncertain || y.uncertain) {
      const notes = [x.note, y.note].filter(Boolean);
      skip(n, `Marked hard to read${notes.length ? ` (${notes.join("; ")})` : ""}.`);
      continue;
    }
    const dateKey = (v) => isoDate(v) || `as printed: ${String(v || "").trim()}`;
    const typeKey = (v) => typeLabel(v) || `as printed: ${String(v || "").trim().toLowerCase()}`;
    const fields = [
      ["date", dateKey(x.date), dateKey(y.date), x.date, y.date],
      ["type", typeKey(x.type), typeKey(y.type), x.type, y.type],
      ["amount", normAmount(x.amount), normAmount(y.amount), x.amount, y.amount],
      ["description", letters(x.description), letters(y.description), x.description, y.description],
    ];
    const differ = fields.filter(([, p, q]) => p !== q);
    if (differ.length) {
      skip(n, differ.map(([field, , , rawP, rawQ]) => `The readings differ on the ${field} ("${rawP ?? ""}" and "${rawQ ?? ""}").`).join(" "));
      continue;
    }
    if (!isoDate(x.date)) {
      skip(n, `"${x.date}" isn't a whole date.`);
      continue;
    }
    if (!typeLabel(x.type)) {
      skip(n, `"${x.type}" isn't one of the form's transaction types.`);
      continue;
    }
    if (!fullRange(x.amount)) {
      skip(n, `"${x.amount}" isn't a whole amount range.`);
      continue;
    }
    if (!letters(x.description)) {
      skip(n, "No description.");
      continue;
    }
    // The form's footnote marker ("See Endnote") isn't part of the asset, as in tools/load_trades.py.
    const description = String(x.description).replace(/\s+/g, " ").replace(/\s+(?:See\s+)?Endnotes?\b.*$/i, "").trim();
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
    look(null, "The report has no usable text layer, so only the two readings were compared: check the rows against the scan.");
  } else {
    // The text layer's row numbers are themselves read from the scan, so a
    // line it can't place is a note for the person, never a reason on its own.
    const at = new Map(rows.map((r) => [r.n, r]));
    const desc = (n) => (A.get(n) && B.get(n) ? A.get(n).description : null);
    let checked = 0;
    let shifted = 0;
    for (const n of textNs) {
      const line = lines[n];
      if (n > total) {
        if (/\$\s?[\d,]{3,}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(line)) look(n, `The text layer shows a row ${n}, past the last row either reading found (${total}): check that the readings reached the end of the table ("${line.slice(0, 120)}").`);
        continue;
      }
      const r = at.get(n);
      if (r) {
        const t = textLayerType(line);
        if (t && t !== (r.type === "Partial sale" ? "Sale" : r.type)) {
          rows.splice(rows.indexOf(r), 1);
          at.delete(n);
          skip(n, `The report's text layer reads "${line.slice(0, 120)}", which looks like a ${t.toLowerCase()}, not a ${r.type.toLowerCase()}.`);
          continue;
        }
      }
      const own = desc(n) ? contained(desc(n), line) : null;
      if (own == null) continue;
      checked += 1;
      const neighbor = Math.max(desc(n - 1) ? contained(desc(n - 1), line) : 0, desc(n + 1) ? contained(desc(n + 1), line) : 0);
      if (neighbor >= 0.5 && neighbor > own + 0.15) shifted += 1;
      if (r && own < 0.5) look(n, `Row ${n}: the text layer's version is too garbled to confirm the description ("${line.slice(0, 120)}"). Check it against the scan.`);
    }
    if (checked >= 5 && shifted > Math.max(3, checked * 0.3)) {
      block(null, `For ${shifted} of the ${checked} rows the text layer could place, the description matches the next or previous row's line better than its own: the readings may have shifted the rows.`);
    }
  }
  unread.sort((p, q) => p.n - q.n);
  return { rows, unread, total, problems };
}

/** "84 of 90 rows transcribed." Pure. */
export const rowsLine = (read, total) => (total ? `${read} of ${total} ${total === 1 ? "row" : "rows"} transcribed.` : "");

export const blocking = (problems) => (problems || []).some((p) => p.kind === "block");
