// CourtListener citation lookup: https://www.courtlistener.com/help/api/rest/citation-lookup/
// One request per draft: all its citations, one per line.
const BASE = "https://www.courtlistener.com";

export function makeLookup(env, budget, sameCase) {
  return async (citations, names) => {
    if (!env.COURTLISTENER_API_TOKEN) throw new Error("COURTLISTENER_API_TOKEN is not set");
    const base = env.COURTLISTENER_BASE || BASE;
    // Remember where each citation starts, to match the results back.
    let text = "";
    const spans = citations.map((c) => {
      const start = text.length;
      text += `${c}\n`;
      return [start, start + c.length];
    });
    const res = await budget.fetch(
      `${base}/api/rest/v4/citation-lookup/`,
      {
        method: "POST",
        headers: { Authorization: `Token ${env.COURTLISTENER_API_TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ text }).toString(),
      },
      "citation lookup"
    );
    const found = await res.json();
    return spans.map(([s, e], i) => {
      const hits = (found || []).filter((r) => r.start_index >= s && r.start_index < e);
      if (!hits.length) return { status: "not_found", message: "not recognized as a case citation" };
      const r = hits[0];
      if (r.status === 429) throw new Error("CourtListener rate limit reached");
      const clusters = r.clusters || [];
      if ((r.status === 200 || r.status === 300) && clusters.length) {
        const c = clusters.find((x) => sameCase(names[i], x.case_name)) || clusters[0];
        return {
          status: "found",
          case_name: c.case_name,
          citation: (r.normalized_citations || [])[0] || r.citation,
          url: `${BASE}${c.absolute_url}`,
        };
      }
      if (r.status === 400) return { status: "invalid", message: r.error_message || "invalid citation" };
      return { status: "not_found", message: r.error_message || "no matching case" };
    });
  };
}
