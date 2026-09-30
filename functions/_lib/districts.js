// A visitor's districts: which officials represent them, and the cookie that
// remembers it in their own browser. Only district IDs are kept, never an
// address or ZIP. Pure module (no D1 or network), shared by the Functions.
//
// The cookie, set by assets/app.js after a lookup:
//   pillory_districts=st=CA&cd=5&su=4&sl=8&co=06009
//     st  state (USPS code)       cd  U.S. House district ("0" at large)
//     su  state senate district   sl  state assembly / lower house district
//     co  county FIPS code
// Any part may be missing (a ZIP lookup outside California has no su/sl).

export const COOKIE = "pillory_districts";
export const CALAVERAS_FIPS = "06009";

// State FIPS code -> USPS code (states, DC, and territories with a delegate).
export const STATE_BY_FIPS = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
  "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
  "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP",
  "72": "PR", "78": "VI",
};

export const STATE_NAME = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  AS: "American Samoa", GU: "Guam", MP: "Northern Mariana Islands", PR: "Puerto Rico", VI: "U.S. Virgin Islands",
};

const RULES = { st: /^[A-Z]{2}$/, cd: /^\d{1,2}$/, su: /^\d{1,3}$/, sl: /^\d{1,3}$/, co: /^\d{5}$/ };

/** Keep only well-formed district IDs. Returns null if there's no state. */
export function cleanDistricts(d) {
  const out = {};
  for (const [k, re] of Object.entries(RULES)) {
    const v = d && d[k] != null ? String(d[k]).trim() : "";
    if (re.test(v)) out[k] = k === "st" || k === "co" ? v : String(parseInt(v, 10));
  }
  if (!out.st || !STATE_NAME[out.st]) return null;
  if (out.co && STATE_BY_FIPS[out.co.slice(0, 2)] !== out.st) delete out.co;
  return out;
}

export function districtsFromCookie(request) {
  const header = request.headers.get("Cookie") || "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`).exec(header);
  if (!m) return null;
  let raw;
  try {
    raw = decodeURIComponent(m[1]);
  } catch (_) {
    return null;
  }
  return cleanDistricts(Object.fromEntries(new URLSearchParams(raw)));
}

export function isCalaveras(d) {
  return !!d && d.co === CALAVERAS_FIPS;
}

/** Plain description, e.g. "California · District 5 · Senate District 4 · Assembly District 8". */
export function describe(d) {
  if (!d) return "";
  const parts = [STATE_NAME[d.st]];
  if (d.cd) parts.push(d.cd === "0" ? "At-large House seat" : `Congressional District ${d.cd}`);
  if (d.st === "CA" && d.su) parts.push(`Senate District ${d.su}`);
  if (d.st === "CA" && d.sl) parts.push(`Assembly District ${d.sl}`);
  return parts.join(" · ");
}

/**
 * SQL (WHERE clause on officials o) and bindings for the officials who
 * represent these districts: the state's two senators, the House member for
 * the district (or the state's only member, for at-large seats), and, in
 * California, the state senator, assemblymember and (in Calaveras) the
 * county supervisors.
 */
export function repsWhere(d) {
  const clauses = ["(o.chamber = 'us-senate' AND o.state = ?)"];
  const binds = [d.st];
  if (d.cd) {
    clauses.push(
      `(o.chamber = 'us-house' AND o.state = ? AND (o.district_code = ? OR (SELECT COUNT(*) FROM officials x WHERE x.active = 1 AND x.chamber = 'us-house' AND x.state = ?) = 1))`
    );
    binds.push(d.st, d.cd, d.st);
  }
  if (d.st === "CA" && d.su) {
    clauses.push("(o.chamber = 'ca-senate' AND o.district_code = ?)");
    binds.push(d.su);
  }
  if (d.st === "CA" && d.sl) {
    clauses.push("(o.chamber = 'ca-assembly' AND o.district_code = ?)");
    binds.push(d.sl);
  }
  if (isCalaveras(d)) clauses.push("o.chamber = 'county-board'");
  return { sql: `o.active = 1 AND (${clauses.join(" OR ")})`, binds };
}
