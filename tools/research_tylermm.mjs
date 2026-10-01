// TEMPORARY: the text of two real agenda PDFs, to write the item parser against.
import { extractText, getDocumentProxy } from "unpdf";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const API = "https://calaverascountycatmmapp.tylerhost.net/tylermmcalendar9579prod/";
for (const id of [142, 145]) {
  const r = await fetch(`${API}meetingInformation/Agenda/false/${id}`, { headers: { "User-Agent": UA } });
  const buf = new Uint8Array(await r.arrayBuffer());
  console.log(`=== agenda ${id}: ${r.status} ${r.headers.get("content-type")} ${buf.length} bytes`);
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: false });
  console.log(`pages: ${text.length}`);
  const all = text.join("\n<<PAGE>>\n");
  console.log(all.slice(0, id === 142 ? 16000 : 9000));
  await sleep(5000);
}
// The packet: only its headers (it is over 100 MB).
for (const p of ["true"]) {
  const r = await fetch(`${API}meetingInformation/Agenda/${p}/142`, { method: "HEAD", headers: { "User-Agent": UA } });
  console.log(`HEAD Agenda/${p}/142 -> ${r.status} ${r.headers.get("content-type")} ${r.headers.get("content-length")}`);
}
