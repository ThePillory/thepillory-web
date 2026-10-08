// TEMPORARY research round 2: Federal Register executive order text.
const UA = { "User-Agent": "ThePillory research (thepillory.co)" };
const out = (...a) => console.log(...a);
const list = await (await fetch("https://www.federalregister.gov/api/v1/documents.json?per_page=4&order=newest&conditions[type][]=PRESDOCU&conditions[presidential_document_type][]=executive_order&fields[]=document_number&fields[]=executive_order_number", { headers: UA })).json();
const nums = (list.results || []).map((r) => r.document_number);
nums.push("2025-02007", "2017-02281", "2009-1885");
for (const n of nums) {
  const r = await fetch(`https://www.federalregister.gov/api/v1/documents/${n}.json?fields[]=raw_text_url&fields[]=body_html_url&fields[]=full_text_xml_url&fields[]=abstract&fields[]=executive_order_notes&fields[]=disposition_notes&fields[]=title&fields[]=executive_order_number&fields[]=signing_date&fields[]=president`, { headers: UA });
  const d = await r.json();
  out("\n===", n, r.status, d.executive_order_number, d.title, d.signing_date, d.president && d.president.name);
  out("abstract:", d.abstract, "| eo notes:", d.executive_order_notes, "| disposition:", d.disposition_notes);
  if (d.raw_text_url) {
    const t = await (await fetch(d.raw_text_url, { headers: UA })).text();
    const i = t.search(/By the authority vested in me/i);
    out("len", t.length, "authority at", i, JSON.stringify(t.slice(Math.max(0, i), i + 500)));
    out("head", JSON.stringify(t.slice(0, 700)));
    out("tail", JSON.stringify(t.slice(-400)));
  }
}
