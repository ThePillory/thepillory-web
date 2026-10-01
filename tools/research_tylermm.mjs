// TEMPORARY: what the Planning Commission publishes, and the packet link.
import { extractText, getDocumentProxy } from "unpdf";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const API = "https://calaverascountycatmmapp.tylerhost.net/tylermmcalendar9579prod/";
for (const [p, id] of [["false", 140], ["true", 140], ["true", 145], ["true", 142], ["false", 129]]) {
  const r = await fetch(`${API}meetingInformation/Agenda/${p}/${id}`, { method: "HEAD", headers: { "User-Agent": UA } });
  console.log(`HEAD Agenda/${p}/${id} -> ${r.status} ${r.headers.get("content-type")} ${r.headers.get("content-length")} ${r.headers.get("content-disposition")}`);
  await sleep(2000);
}
// The Planning Commission's Sep 24 agenda, whichever form is small enough.
for (const p of ["false", "true"]) {
  const r = await fetch(`${API}meetingInformation/Agenda/${p}/140`, { headers: { "User-Agent": UA } });
  const len = parseInt(r.headers.get("content-length") || "0", 10);
  console.log(`GET Agenda/${p}/140 -> ${r.status} ${r.headers.get("content-type")} ${len}`);
  if (!r.ok || len > 40e6) { await r.body?.cancel(); continue; }
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] !== 0x25) { console.log(new TextDecoder().decode(buf.slice(0, 300))); continue; }
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: false });
  console.log(`pages ${text.length}`);
  console.log(text.slice(0, 6).join("\n<<PAGE>>\n").slice(0, 9000));
  break;
}
