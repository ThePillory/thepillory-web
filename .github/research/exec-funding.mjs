// TEMPORARY research script (round 2): executive-branch funding sources. Remove before merging.
const KEY = process.env.FEC_KEY || 'DEMO_KEY';
const UA = { 'User-Agent': 'ThePillory research (thepillory.co)' };
const show = (label, x) => console.log(`\n### ${label}\n` + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 2500));
async function get(url, opts = {}) {
  try { const r = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) }, redirect: 'follow', signal: AbortSignal.timeout(25000), ...opts }); const t = await r.text(); return { status: r.status, ct: r.headers.get('content-type'), url: r.url, t }; }
  catch (e) { return { status: 'ERR ' + e.message, t: '' }; }
}
const fec = async (path) => { const r = await get(`https://api.open.fec.gov/v1${path}${path.includes('?') ? '&' : '?'}api_key=${KEY}`); try { return JSON.parse(r.t); } catch { return { status: r.status, body: r.t.slice(0, 300) }; } };
const text = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const links = (html, re) => [...new Set([...html.matchAll(/href="([^"]+)"[^>]*>([^<]{0,100})</g)].filter(m => re.test(m[1] + ' ' + m[2])).map(m => m[1] + ' | ' + m[2].trim()))].slice(0, 30);

// A. FEC compact
const ex = JSON.parse((await get('https://unitedstates.github.io/congress-legislators/executive.json')).t);
const cur = ex.filter(p => p.terms.some(t => t.end >= '2026-10-05' && t.start <= '2026-10-05'));
show('A1 current', cur.map(p => ({ fec: p.id.fec, bioguide: p.id.bioguide, types: p.terms.filter(t => t.end >= '2026-10-05').map(t => t.type) })));
const inaug = await fec('/committees/?q=inaugural&sort=-last_file_date&per_page=6');
show('A3 inaugural committees', (inaug.results || []).map(c => [c.committee_id, c.name, c.committee_type, c.committee_type_full, c.first_file_date, c.last_file_date]));
for (const ic of (inaug.results || []).slice(0, 2)) {
  const f = await fec(`/filings/?committee_id=${ic.committee_id}&per_page=6&sort=-receipt_date`);
  show('A4 filings ' + ic.committee_id, (f.results || []).map(x => [x.form_type, x.receipt_date, x.coverage_start_date, x.coverage_end_date, x.total_receipts, x.fec_url, x.pdf_url, x.amendment_indicator, x.document_description, x.file_number]));
  const sa = await fec(`/schedules/schedule_a/?committee_id=${ic.committee_id}&per_page=6&sort=-contribution_receipt_amount`);
  show('A5 sched A ' + ic.committee_id, { count: sa.pagination && sa.pagination.count, rows: (sa.results || []).map(r => [r.entity_type, r.contributor_name, r.contribution_receipt_amount, r.contribution_receipt_date, r.line_number, r.filing_form, r.two_year_transaction_period, r.memo_code]), err: sa.body });
  const sao = await fec(`/schedules/schedule_a/?committee_id=${ic.committee_id}&per_page=6&sort=-contribution_receipt_amount&contributor_type=individual`);
  show('A5b individual filter ' + ic.committee_id, { count: sao.pagination && sao.pagination.count });
  const sac = await fec(`/schedules/schedule_a/by_size/?committee_id=${ic.committee_id}`);
  show('A5c by size', sac.results || sac);
}
// Earlier presidential inaugural committee (to see history): search names
const old = await fec('/committees/?q=inaugural&sort=first_file_date&per_page=10');
show('A6 oldest inaugural committees', (old.results || []).map(c => [c.committee_id, c.name, c.first_file_date]));

// B. OGE API
const base = 'https://extapps2.oge.gov/201/Presiden.nsf/API.xsp/v3/rest';
for (const q of ['?draw=1&start=0&length=5', '?draw=1&start=0&length=5&search%5Bvalue%5D=Secretary', '?draw=1&start=0&length=5&search%5Bvalue%5D=Ethics%20Agreement', '?start=0&length=3&search%5Bvalue%5D=Vice%20President']) {
  const r = await get(base + q, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
  show('B ' + q, { status: r.status, ct: r.ct, body: r.t.slice(0, 2200) });
}
const page = await get('https://www.oge.gov/web/OGE.nsf/Officials%20Individual%20Disclosures%20Search%20Collection?OpenForm');
const m = page.t.match(/"ajax"[\s\S]{0,1500}/) || page.t.match(/&quot;ajax&quot;[\s\S]{0,1800}/);
show('B2 ajax config', m ? m[0].replace(/&quot;/g, '"') : 'none');
show('B3 table headers', [...page.t.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(x => x[1]));

// C. California
for (const u of ['https://www.sos.ca.gov/campaign-lobbying', 'https://www.sos.ca.gov/campaign-lobbying/cal-access-resources', 'https://powersearch.sos.ca.gov/quick-search.php', 'https://powersearch.sos.ca.gov/advanced.php', 'https://powersearch.sos.ca.gov/help/']) {
  const r = await get(u); show('C ' + u, { status: r.status, final: r.url, text: text(r.t).slice(0, 900), links: links(r.t, /cars|CARS|export|csv|api|download|search|filer|committee|candidate|new system|replace/i) });
}
const ps = await get('https://powersearch.sos.ca.gov/quick-search.php?type=candidate&name=Newsom');
show('C2 powersearch candidate', { status: ps.status, final: ps.url, text: text(ps.t).slice(0, 1500), links: links(ps.t, /csv|export|download|result|php\?/i) });
const ca = await get('https://cal-access.sos.ca.gov/Campaign/Committees/');
show('C3 cal-access committees index', { status: ca.status, text: text(ca.t).slice(0, 300) });

// D. FPPC
for (const u of ['https://www.fppc.ca.gov/link/f968c492e8e642d0b9c08bdf8beb9609.aspx', 'https://www.fppc.ca.gov/transparency/form-700-filed-by-public-officials.html', 'https://www.fppc.ca.gov/transparency.html']) {
  const r = await get(u); show('D ' + u, { status: r.status, final: r.url, title: (r.t.match(/<title>([^<]*)/i) || [])[1], text: text(r.t).slice(0, 800), links: links(r.t, /700|statewide|governor|search|official|filed/i) });
}
