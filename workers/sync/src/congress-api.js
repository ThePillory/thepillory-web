// Congress.gov API URLs. https://api.congress.gov/
export const API = "https://api.congress.gov/v3";

function key(env) {
  if (!env.CONGRESS_API_KEY) throw new Error("CONGRESS_API_KEY secret is not set");
  return env.CONGRESS_API_KEY;
}

export function api(env, path, params = {}) {
  const q = new URLSearchParams({ format: "json", ...params, api_key: key(env) });
  return `${env.CONGRESS_API_BASE || API}${path}?${q}`;
}

// Bill types as Congress.gov and senate.gov write them -> display prefix and congress.gov URL path.
export const BILL_TYPES = {
  HR: ["H.R.", "house-bill", "us-house"],
  S: ["S.", "senate-bill", "us-senate"],
  HRES: ["H.Res.", "house-resolution", "us-house"],
  SRES: ["S.Res.", "senate-resolution", "us-senate"],
  HJRES: ["H.J.Res.", "house-joint-resolution", "us-house"],
  SJRES: ["S.J.Res.", "senate-joint-resolution", "us-senate"],
  HCONRES: ["H.Con.Res.", "house-concurrent-resolution", "us-house"],
  SCONRES: ["S.Con.Res.", "senate-concurrent-resolution", "us-senate"],
};
