// The California Constitution for the analysis of California bills: data/ca-constitution.json,
// word for word from the Legislature's own database (tools/build_ca_constitution.py). Loaded into
// constitution_provisions beside the U.S. Constitution (labels begin "California Constitution, "),
// so quotes are checked against it and pages can show it. The whole text (about 490,000
// characters) is too long for each prompt, so a California bill's prompt gets Article I (the
// Declaration of Rights) and the sections whose words best match the bill (caSelection()).
import data from "../../../data/ca-constitution.json" with { type: "json" };

export const CA_LABEL_PREFIX = "California Constitution, ";
export const CA_VERSION = `ca-${data.read}`;

/** Every provision, labeled as the California Constitution's, in the U.S. file's shape. */
export const CA_PROVISIONS = data.provisions.map((p) => ({
  id: p.id,
  parent: p.parent,
  kind: p.kind,
  label: `${CA_LABEL_PREFIX}${p.label}`,
  text: p.text || "",
  leaf: Boolean(p.leaf),
  source_url: p.source_url,
}));
const CA_LEAVES = CA_PROVISIONS.filter((p) => p.leaf && p.text);

/** A bill of the California Legislature (not an order, a measure, or another state's bill). */
export function isCaliforniaBill(bill) {
  if (!bill || bill.kind === "order" || bill.kind === "measure") return false;
  return bill.level === "state" && /^ca-/.test(String(bill.chamber || bill.id || ""));
}

// Words that say nothing about a section's subject.
const STOP = new Set(
  ("a an and any are as at be been by can do does each for from had has have he her his if in into is it its may more must no nor not of on or other " +
    "shall should so such than that the their them then there these they this those to under upon was were which while who will with would " +
    "section sections article articles subdivision paragraph chapter code act law laws state california bill person persons provided provide provides " +
    "including include includes made make makes within without year years one two three also amend amends amended add adds added existing").split(" ")
);
const terms = (text) => (String(text || "").toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ies|es|s)$/, ""));

// Each section's terms, and how many sections each term appears in (for weighting rare words).
const INDEX = CA_LEAVES.map((p) => ({ p, terms: new Set(terms(p.text)) }));
const DF = new Map();
for (const { terms: t } of INDEX) for (const w of t) DF.set(w, (DF.get(w) || 0) + 1);
const IDF = (w) => Math.log((INDEX.length + 1) / ((DF.get(w) || 0) + 1));

export const ALWAYS_ARTICLE = "ca-art-1"; // Declaration of Rights
export const MAX_SECTIONS = 15; // beyond Article I
export const MAX_CHARS = 40000; // the matched sections' text, beyond Article I

/**
 * The California provisions a bill's prompt carries: all of Article I, then the sections whose
 * words best match the bill's title, summary and text (rare words count most), up to MAX_SECTIONS
 * and MAX_CHARS. Pure. Returns provisions in the file's order.
 */
export function caSelection(bill, source) {
  const text = [bill && bill.title, bill && bill.summary, source && String(source.text || "").slice(0, 60000)].filter(Boolean).join(" ");
  const counts = new Map();
  for (const w of terms(text)) counts.set(w, (counts.get(w) || 0) + 1);
  const scored = INDEX.filter(({ p }) => p.parent !== ALWAYS_ARTICLE)
    .map(({ p, terms: t }) => {
      let score = 0;
      for (const [w, n] of counts) if (t.has(w)) score += IDF(w) * Math.log(1 + n);
      return { p, score: score / Math.sqrt(1 + t.size / 50) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
  const picked = new Set(CA_LEAVES.filter((p) => p.parent === ALWAYS_ARTICLE).map((p) => p.id));
  let chars = 0;
  let n = 0;
  for (const { p } of scored) {
    if (n >= MAX_SECTIONS) break;
    if (chars + p.text.length > MAX_CHARS) continue;
    picked.add(p.id);
    chars += p.text.length;
    n += 1;
  }
  return CA_LEAVES.filter((p) => picked.has(p.id));
}

/** The prompt block for a California bill: the selected provisions, as [id] label, then text. */
export function caBlock(provisions) {
  return `The California Constitution: Article I (the Declaration of Rights) and the other sections most related to this bill, one per entry, as [id] label, then text. You may quote these, word for word, as well as the U.S. Constitution above; use their IDs exactly as given. No other California provision may be quoted or cited by ID.

${provisions.map((p) => `[${p.id}] ${p.label}\n${p.text}`).join("\n\n")}`;
}
