// TEMPORARY research script (round 3). Remove before merging.
const UA = { 'User-Agent': 'ThePillory research (thepillory.co)' };
const show = (label, x) => console.log(`\n### ${label}\n` + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 3000));
async function get(url, opts = {}) {
  try { const r = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) }, redirect: 'follow', signal: AbortSignal.timeout(40000), ...opts }); const b = Buffer.from(await r.arrayBuffer()); return { status: r.status, ct: r.headers.get('content-type'), len: b.length, url: r.url, t: b.toString('latin1') }; }
  catch (e) { return { status: 'ERR ' + e.message, t: '' }; }
}
const text = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// A. .fec file for the inaugural report
const f = await get('https://docquery.fec.gov/dcdev/posted/1910509.fec');
const lines = f.t.split(/\r?\n/);
show('A .fec size/lines', { status: f.status, ct: f.ct, len: f.len, lines: lines.length });
show('A header lines', lines.slice(0, 3).map(l => l.split('\x1c').slice(0, 40)));
const types = {}; for (const l of lines) { const k = l.split('\x1c')[0]; types[k] = (types[k] || 0) + 1; }
show('A record types', types);
const f132 = lines.filter(l => l.startsWith('F132')).map(l => l.split('\x1c'));
show('A F132 sample fields (first 3 rows)', f132.slice(0, 3));
const ent = {}; for (const r of f132) ent[r[5]] = (ent[r[5]] || 0) + 1; show('A F132 field5 values', ent);
const orgRows = f132.filter(r => r[5] && r[5] !== 'IND').slice(0, 5); show('A non-IND sample', orgRows);
const f133 = lines.filter(l => l.startsWith('F133')).map(l => l.split('\x1c')); show('A F133 sample', f133.slice(0, 2));
// B. CARS go-live page
const c = await get('https://www.sos.ca.gov/campaign-lobbying/helpful-resources/cal-access-replacement-system-project-cars-updates/cal-access-replacement-system-cars-go-live-updates');
const ct = text(c.t); const i = ct.indexOf('Go-Live'); show('B CARS go-live', { status: c.status, text: ct.slice(Math.max(0, ct.indexOf('Home Campaign')), Math.max(0, ct.indexOf('Home Campaign')) + 3000) });
const c2 = await get('https://www.sos.ca.gov/campaign-lobbying/helpful-resources/cal-access-replacement-system-project-cars-updates');
const ct2 = text(c2.t); show('B2 CARS updates', ct2.slice(Math.max(0, ct2.indexOf('Home Campaign')), Math.max(0, ct2.indexOf('Home Campaign')) + 2500));
// C. Power Search forms
const q = await get('https://powersearch.sos.ca.gov/quick-search.php');
show('C quick search forms', [...q.t.matchAll(/<form[\s\S]*?<\/form>/g)].map(m => m[0].replace(/<option[^>]*>[^<]*<\/option>/g, '').replace(/\s+/g, ' ').slice(0, 900)));
// D. FPPC Form 700 search
const d = await get('https://form700search.fppc.ca.gov/');
show('D form700search', { status: d.status, final: d.url, ct: d.ct, text: text(d.t).slice(0, 1500), scripts: [...d.t.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]), forms: [...d.t.matchAll(/<form[\s\S]*?<\/form>/g)].map(m => m[0].replace(/\s+/g, ' ').slice(0, 1200)), api: [...d.t.matchAll(/["'](\/?api[^"']*|[^"']*Search[^"']*\.aspx[^"']*)["']/gi)].map(m => m[1]).slice(0, 20) });
for (const u of ['https://form700search.fppc.ca.gov/Search/SearchFilerForms.aspx', 'https://form700search.fppc.ca.gov/Search/SearchFilerForms.aspx?name=Newsom']) {
  const r = await get(u); show('D2 ' + u, { status: r.status, final: r.url, text: text(r.t).slice(0, 1200), links: [...r.t.matchAll(/href="([^"]+)"/g)].map(m => m[1]).filter(h => /pdf|View|Filer|Form|aspx/i.test(h)).slice(0, 25) });
}
// retry
