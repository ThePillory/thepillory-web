// TEMPORARY: run the new Tyler Meeting Manager parsers on the county's real agendas.
import { parseMeetingList, parseSummaryAgenda, parsePacketAgenda, API } from "../workers/sync/src/meetings/tylermm.js";
import { openPdf, streamPages, linePages } from "../workers/sync/src/meetings/pdftext.js";
import { commentInfo, deadlineLabel } from "../workers/sync/src/meetings/comment.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const res = await fetch(`${API}meetingInformation/getMeetingInformationByDate`, {
  method: "POST",
  headers: { "User-Agent": UA, "Content-Type": "application/json; charset=UTF-8", Accept: "application/json" },
  body: JSON.stringify({ startDate: "08/15/2026", endDate: "11/15/2026", meetingTypeIds: [5, 11] }),
});
const json = await res.json();
const meetings = parseMeetingList(json);
for (const m of meetings) console.log("MEETING", JSON.stringify({ ...m, titles: m.titles.length }));
for (const m of meetings.filter((x) => x.pdf_url)) {
  await sleep(3000);
  const t0 = Date.now();
  const r = await fetch(m.pdf_url, { headers: { "User-Agent": UA } });
  const buf = await r.arrayBuffer();
  console.log(`\n===== ${m.id} ${m.body} ${m.starts_at} ${r.status} ${buf.byteLength} bytes ${Date.now() - t0}ms`);
  const pdf = await openPdf(buf);
  const stream = await streamPages(pdf);
  const lines = await linePages(pdf, 2);
  console.log(`pages ${stream.length}`);
  console.log("--- LINE PAGE 1\n" + lines[0]);
  for (const [name, pages] of [["stream", stream], ["lines", [...lines, ...stream.slice(2)]]]) {
    const info = commentInfo(pages);
    console.log(`--- COMMENT (${name})`, JSON.stringify(info), JSON.stringify(deadlineLabel(info.comment_deadline_text, m.starts_at)));
  }
  const items = m.packet_url ? parseSummaryAgenda(stream, m.titles) : parsePacketAgenda(stream);
  for (const it of items) console.log(`ITEM ${it.number} [${it.section} / ${it.section_kind}] ${it.title.slice(0, 260)} | att ${it.attachments.map((a) => a.title).join("; ")}`);
}
