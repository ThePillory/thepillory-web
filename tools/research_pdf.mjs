// TEMPORARY: extract agenda PDF text with unpdf (the library the Worker would use).
import { readFileSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";
const pdf = await getDocumentProxy(new Uint8Array(readFileSync("/tmp/agenda.pdf")));
const { totalPages, text } = await extractText(pdf, { mergePages: false });
console.log("PAGES", totalPages);
console.log("PAGE1:\n" + text[0].slice(0, 6000));
const all = text.join("\n");
for (const m of all.matchAll(/[^.]*\b(comment|Zoom|zoom|YouTube|written|e-mail|email|deadline|4:00|p\.m\.|pm)\b[^.]*\./g)) console.log("SENTENCE:", m[0].replace(/\s+/g, " ").trim().slice(0, 400));
