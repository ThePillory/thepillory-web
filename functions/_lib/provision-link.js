// Where a provision's chip or label links: the U.S. Constitution page for U.S. provisions, and the
// California Legislature's own page for a California Constitution provision ("ca-art-13a-sec-1" ->
// leginfo's Article XIII A). Pure, no data loaded.

const ROMAN = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
const roman = (n) => ROMAN.reduce((out, [v, s]) => {
  while (n >= v) {
    out += s;
    n -= v;
  }
  return out;
}, "");

/** True for a California Constitution provision ID (data/ca-constitution.json). */
export const isCaProvision = (id) => /^ca-art-/.test(String(id || ""));

/** The page a provision links to. */
export function provisionHref(id) {
  const m = String(id || "").match(/^ca-art-(\d+)([a-z]?)(?:-|$)/);
  if (m) {
    const article = `${roman(parseInt(m[1], 10))}${m[2] ? `%20${m[2].toUpperCase()}` : ""}`;
    return `https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CONS&article=${article}`;
  }
  return `/laws/constitution/#${encodeURIComponent(id)}`;
}
