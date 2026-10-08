// TEMPORARY research: executive order text, authority clauses, and court records.
import { getDocumentProxy } from "unpdf";
const UA = { "User-Agent": "ThePillory research (thepillory.co)" };
const out = (...a) => console.log(...a);
async function get(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } });
  return r;
}
const auth = process.env.CL ? { Authorization: `Token ${process.env.CL}` } : {};
out("CL token set:", !!process.env.CL);

// 1. Federal Register: a few EOs across presidents
for (const n of ["14160", "14248", "14110", "13769", "13563", "14303"]) {
  try {
    const r = await get(`https://www.federalregister.gov/api/v1/documents.json?conditions[executive_order_number]=${n}&fields[]=document_number&fields[]=raw_text_url&fields[]=body_html_url&fields[]=abstract&fields[]=title&fields[]=president&fields[]=signing_date&fields[]=disposition_notes&fields[]=executive_order_notes`);
    const j = await r.json();
    const d = (j.results || [])[0];
    out("\n=== EO", n, r.status, d && d.title, d && d.president && d.president.name, d && d.signing_date);
    out("abstract:", d && d.abstract);
    out("disposition_notes:", d && d.disposition_notes, "| eo notes:", d && d.executive_order_notes);
    if (d && d.raw_text_url) {
      const t = await (await get(d.raw_text_url)).text();
      out("raw text len", t.length);
      const i = t.search(/By the authority vested in me/i);
      out("authority at", i, JSON.stringify(t.slice(Math.max(0, i), i + 700)));
      out("head:", JSON.stringify(t.slice(0, 600)));
    }
  } catch (e) { out("EO", n, "ERR", e.message); }
}

// 2. Governor of California: feed, a post, its PDF
try {
  const feed = await (await get("https://www.gov.ca.gov/category/executive-orders/feed/")).text();
  const links = [...feed.matchAll(/<link>(https:\/\/www\.gov\.ca\.gov\/[^<]+)<\/link>/g)].map((m) => m[1]).slice(1, 6);
  out("\n=== gov feed links", links);
  for (const link of links.slice(0, 3)) {
    const html = await (await get(link)).text();
    const pdfs = [...html.matchAll(/href="(https:\/\/www\.gov\.ca\.gov\/wp-content\/uploads\/[^"]+\.pdf)"/gi)].map((m) => m[1]);
    const body = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const k = body.search(/NOW, THEREFORE/i);
    out("\npost", link, "pdfs", pdfs.slice(0, 3), "THEREFORE in post at", k, JSON.stringify(body.slice(Math.max(0, k), k + 500)));
    if (pdfs[0]) {
      const bytes = new Uint8Array(await (await get(pdfs[0])).arrayBuffer());
      const pdf = await getDocumentProxy(bytes);
      let text = "";
      for (let p = 1; p <= Math.min(pdf.numPages, 6); p++) text += (await (await pdf.getPage(p)).getTextContent()).items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("") + "\n";
      const j = text.search(/NOW,?\s+THEREFORE/i);
      out("pdf pages", pdf.numPages, "len", text.length, "THEREFORE at", j, JSON.stringify(text.slice(Math.max(0, j), j + 600)));
      out("pdf head", JSON.stringify(text.slice(0, 400)));
    }
  }
} catch (e) { out("gov ERR", e.message); }

// 3. CourtListener search
for (const q of ['"Executive Order 14160"', '"Exec. Order No. 14160"', '"Executive Order 14248"', '"Executive Order N-33-20"', '"Executive Order 14303"']) {
  for (const type of ["r", "o", "d"]) {
    try {
      const r = await get(`https://www.courtlistener.com/api/rest/v4/search/?type=${type}&q=${encodeURIComponent(q)}&order_by=dateFiled%20desc`, { headers: auth });
      const txt = await r.text();
      let j; try { j = JSON.parse(txt); } catch { out("CL", q, type, r.status, txt.slice(0, 200)); continue; }
      out(`\n=== CL ${q} type=${type} status ${r.status} count ${j.count}`);
      for (const x of (j.results || []).slice(0, 4)) {
        const docs = (x.recap_documents || []).slice(0, 3).map((d) => ({ desc: (d.description || "").slice(0, 120), short: d.short_description, date: d.entry_date_filed, n: d.entry_number, url: d.absolute_url }));
        out(JSON.stringify({ caseName: x.caseName, court: x.court, court_id: x.court_id, dateFiled: x.dateFiled, docketNumber: x.docketNumber, docket_url: x.docket_absolute_url, url: x.absolute_url, cause: x.cause, nature: x.suitNature, status: x.status, more_docs: x.more_docs, docs, snippet: (x.snippet || (x.opinions && x.opinions[0] && x.opinions[0].snippet) || "").slice(0, 200) }));
      }
      if (j.results && j.results[0] && type === "r") out("keys:", Object.keys(j.results[0]).join(","));
      if (j.results && j.results[0] && type === "o") out("keys:", Object.keys(j.results[0]).join(","));
    } catch (e) { out("CL ERR", q, type, e.message); }
  }
}
