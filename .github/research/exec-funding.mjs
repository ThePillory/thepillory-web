// TEMPORARY research script: executive-branch funding sources. Remove before merging.
const KEY = process.env.FEC_KEY || 'DEMO_KEY';
const UA = { 'User-Agent': 'ThePillory research (thepillory.co)' };
const show = (label, x) => console.log(`\n### ${label}\n` + (typeof x === 'string' ? x : JSON.stringify(x, null, 1)).slice(0, 3500));
async function get(url, opts = {}) {
  try { const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(25000), ...opts }); const t = await r.text(); return { status: r.status, ct: r.headers.get('content-type'), url: r.url, t }; }
  catch (e) { return { status: 'ERR ' + e.message, t: '' }; }
}
const fec = async (path) => { const r = await get(`https://api.open.fec.gov/v1${path}${path.includes('?') ? '&' : '?'}api_key=${KEY}`); try { return JSON.parse(r.t); } catch { return { status: r.status, body: r.t.slice(0, 300) }; } };
const links = (html, re) => [...new Set([...html.matchAll(/href="([^"]+)"[^>]*>([^<]{0,120})</g)].filter(m => re.test(m[1] + ' ' + m[2])).map(m => m[1] + ' | ' + m[2].trim()))].slice(0, 40);

// ---------- A. FEC ----------
const ex = JSON.parse((await get('https://unitedstates.github.io/congress-legislators/executive.json')).t);
const cur = ex.filter(p => p.terms.some(t => t.end >= '2026-10-05' && t.start <= '2026-10-05'));
show('A1 current executive.json people (ids + current term types)', cur.map(p => ({ id: p.id, terms: p.terms.filter(t => t.end >= '2026-10-05').map(t => ({ type: t.type, start: t.start, how: t.how })) })));
const pres = cur.find(p => p.terms.some(t => t.type === 'prez' && t.end >= '2026-10-05'));
const pid = (pres.id.fec || []).filter(x => x.startsWith('P')).pop();
show('A2 president fec ids', pres.id.fec);
const inaug = await fec('/committees/?q=inaugural&sort=-last_file_date&per_page=8');
show('A3 inaugural committees', (inaug.results || []).map(c => ({ id: c.committee_id, name: c.name, type: c.committee_type, type_full: c.committee_type_full, desig: c.designation, first: c.first_file_date, last: c.last_file_date, cycles: c.cycles })));
const ic = (inaug.results || [])[0];
if (ic) {
  const f = await fec(`/filings/?committee_id=${ic.committee_id}&per_page=10&sort=-receipt_date`);
  show('A4 inaugural filings', (f.results || []).map(x => ({ form: x.form_type, receipt: x.receipt_date, cov: [x.coverage_start_date, x.coverage_end_date], total_receipts: x.total_receipts, pdf: x.pdf_url, fec_url: x.fec_url, amend: x.amendment_indicator, doc: x.document_description })));
  const sa = await fec(`/schedules/schedule_a/?committee_id=${ic.committee_id}&per_page=5&sort=-contribution_receipt_amount`);
  show('A5 inaugural schedule_a (top 5 by amount) fields', { pagination: sa.pagination, rows: (sa.results || []).map(r => ({ entity: r.entity_type, entity_desc: r.entity_type_desc, name: r.contributor_name, amt: r.contribution_receipt_amount, date: r.contribution_receipt_date, line: r.line_number, form: r.filing_form, cycle: r.two_year_transaction_period, memo: r.memo_code, receipt_type: r.receipt_type })) , status: sa.status, body: sa.body });
  const sa2 = await fec(`/schedules/schedule_a/?committee_id=${ic.committee_id}&per_page=5&contributor_type=committee&sort=-contribution_receipt_amount`);
  show('A5b inaugural schedule_a contributor_type=committee', { pagination: sa2.pagination, n: (sa2.results||[]).length });
  const tot = await fec(`/committee/${ic.committee_id}/totals/`);
  show('A6 inaugural committee totals', tot.results ? tot.results.slice(0, 2) : tot);
}
const se = await fec(`/schedules/schedule_e/by_candidate/?candidate_id=${pid}&per_page=10&sort=-total&cycle=2024`);
show('A7 schedule_e by_candidate for president 2024', (se.results || []).map(r => ({ cid: r.committee_id, name: r.committee_name, so: r.support_oppose_indicator, total: r.total, count: r.count })));
const ids = [...new Set((se.results || []).map(r => r.committee_id))].slice(0, 10);
const cm = await fec(`/committees/?${ids.map(i => 'committee_id=' + i).join('&')}&per_page=20`);
show('A8 spender committee types', (cm.results || []).map(c => ({ id: c.committee_id, name: c.name, type: c.committee_type, type_full: c.committee_type_full, desig: c.designation, org: c.organization_type_full })));
const f5 = await fec(`/schedules/schedule_e/?candidate_id=${pid}&filing_form=F5&per_page=5&sort=-expenditure_amount&cycle=2024`);
show('A9 schedule_e F5 (non-committee) filers for president 2024', { pagination: f5.pagination, rows: (f5.results || []).map(r => ({ cid: r.committee_id, name: r.committee && r.committee.name, type: r.committee && r.committee.committee_type, amt: r.expenditure_amount, so: r.support_oppose_indicator, form: r.filing_form })) });
const vt = await fec(`/committees/?committee_type=I&per_page=3&sort=-last_file_date`);
show('A10 committee_type=I sample', (vt.results || []).map(c => ({ id: c.committee_id, name: c.name, type_full: c.committee_type_full })));

// ---------- B. OGE ----------
for (const u of ['https://www.oge.gov/web/OGE.nsf/Officials%20Individual%20Disclosures%20Search%20Collection?OpenForm',
  'https://www.oge.gov/web/oge.nsf/Nominee%20Reports', 'https://www.oge.gov/Web/OGE.nsf/Agency%20Ethics%20Agreements?OpenView',
  'https://extapps2.oge.gov/web/OGE.nsf/Officials%20Individual%20Disclosures%20Search%20Collection?OpenForm']) {
  const r = await get(u); show('B ' + u, { status: r.status, ct: r.ct, final: r.url, title: (r.t.match(/<title>([^<]*)/i) || [])[1], scripts: [...r.t.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]).slice(0, 10), forms: [...r.t.matchAll(/<form[^>]*>/g)].map(m => m[0]).slice(0, 5), json: [...r.t.matchAll(/["']([^"']*(?:json|api|ReadViewEntries|\?OpenView|SearchView)[^"']*)["']/gi)].map(m => m[1]).slice(0, 25), links: links(r.t, /nsf|278|ethics|agreement|disclos|search/i) });
}
const wh = await get('https://www.whitehouse.gov/administration/cabinet/');
const firstCab = (wh.t.match(/<h2[^>]*>([^<]{3,60})<\/h2>/) || [])[1];
show('B2 first cabinet h2 (for search test)', firstCab);

// ---------- C. Cal-Access / CARS ----------
const st = JSON.parse((await import('fs')).readFileSync('data/state-executive-officials.json', 'utf8')).officials;
const gov = st[0].name.split(' ').pop();
for (const u of ['https://cal-access.sos.ca.gov/Campaign/Candidates/', `https://cal-access.sos.ca.gov/Campaign/Candidates/list.aspx?view=certified&electNav=93`, 'https://www.sos.ca.gov/campaign-lobbying/cars-project', 'https://cars.sos.ca.gov/', 'https://powersearch.sos.ca.gov/']) {
  const r = await get(u); show('C ' + u, { status: r.status, final: r.url, title: (r.t.match(/<title>([^<]*)/i) || [])[1], text: r.t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1200), links: links(r.t, /Detail\.aspx|Candidates|cars|launch|Committees|search|export|api|download/i) });
}
const srch = await get(`https://cal-access.sos.ca.gov/Campaign/Candidates/list.aspx?view=search&searchtext=${encodeURIComponent(gov)}`);
show('C2 candidate search ' + gov, { status: srch.status, final: srch.url, links: links(srch.t, /Detail\.aspx/i) });

// ---------- D. FPPC Form 700 ----------
for (const u of ['https://www.fppc.ca.gov/transparency/form-700-filed-by-public-officials.html', 'https://www.fppc.ca.gov/transparency/form-700-filed-by-public-officials/form700-2024-2025.html']) {
  const r = await get(u); show('D ' + u, { status: r.status, final: r.url, title: (r.t.match(/<title>([^<]*)/i) || [])[1], links: links(r.t, /700|form|governor|constitutional|statewide|newsom|\.pdf/i) });
}
