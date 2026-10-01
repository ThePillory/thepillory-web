// Text of an agenda PDF, page by page, in two forms:
//   streamPages   the order the PDF draws its text (unpdf's extractText). Good
//                 for agenda bodies, but a line with mixed fonts can come out
//                 shuffled ("… Clerk of the Board, , nobosclerk@… later than").
//   linePages     each line rebuilt from where its words sit on the page (top to
//                 bottom, left to right), which keeps such lines in reading order.
import { extractText, getDocumentProxy } from "unpdf";

export async function openPdf(bytes) {
  return getDocumentProxy(new Uint8Array(bytes));
}

export async function streamPages(pdf) {
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

/** Lines by position, for the first `maxPages` pages. */
export async function linePages(pdf, maxPages = 2) {
  const out = [];
  for (let p = 1; p <= Math.min(pdf.numPages, maxPages); p++) {
    const page = await pdf.getPage(p);
    const { items } = await page.getTextContent();
    const words = items
      .filter((it) => typeof it.str === "string" && it.str.trim())
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || it.height || 10 }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const wd of words) {
      const line = lines.find((l) => Math.abs(l.y - wd.y) <= Math.max(2, Math.min(l.h, wd.h) * 0.4));
      if (line) line.words.push(wd);
      else lines.push({ y: wd.y, h: wd.h, words: [wd] });
    }
    lines.sort((a, b) => b.y - a.y);
    out.push(
      lines
        .map((l) => {
          l.words.sort((a, b) => a.x - b.x);
          let s = "";
          let end = null;
          for (const wd of l.words) {
            const gap = end === null ? 0 : wd.x - end;
            if (s && gap > wd.h * 0.15 && !/\s$/.test(s) && !/^\s/.test(wd.str)) s += " ";
            s += wd.str;
            end = wd.x + wd.w;
          }
          return s.replace(/\s{2,}/g, " ").trim();
        })
        .join("\n")
    );
  }
  return out;
}
