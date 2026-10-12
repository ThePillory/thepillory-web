// The transcription prompt for scanned OGE Form 278-T reports (docs/trades.md).
// The same prompt goes to both models; their answers are compared in code
// (scan-check.js) and then checked by a person against the scan.

export const SCAN_INSTRUCTIONS = `You transcribe the transactions table of a scanned U.S. Office of Government Ethics Form 278-T (Periodic Transaction Report) for a public record. Accuracy matters more than completeness: a wrong date or amount would be published as fact.

Rules:
- Transcribe only the table headed "Transactions": one entry per numbered row, across every page, in order.
- Copy each cell exactly as printed, character for character: the row number, the description, the transaction type, the date and the amount. Keep abbreviations, capitalization and punctuation as printed. Do not correct, expand, complete or reformat anything.
- The date as printed (for example 7/22/2026). The amount as printed (for example "$1,001 - $15,000" or "Over $50,000,000").
- If any cell is hard to read (blurred, cut off, overwritten, stamped over), still give your best reading, set "uncertain" to true for that row and say which cell in "note". Never guess silently.
- Leave out the "Notification Received Over 30 Days Ago" column, signatures, stamps, instructions and page headers.
- You are asked for a range of row numbers. Return only the rows numbered in that range, as numbered on the form; if the table ends before the range does, stop at the last row. If no row in the range exists, return an empty list.
- If there is no transactions table, return an empty list.`;

export const scanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "description", "type", "date", "amount", "uncertain", "note"],
        properties: {
          n: { type: "integer" },
          description: { type: "string" },
          type: { type: "string" },
          date: { type: "string" },
          amount: { type: "string" },
          uncertain: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
  },
};

/**
 * The user message: the report's PDF, by its OGE link, and the rows asked for.
 * The document is cached, so reading a long report in several chunks pays for
 * it in full only once per model.
 */
export const scanMessage = (url, first, last) => [
  { type: "document", source: { type: "url", url }, cache_control: { type: "ephemeral" } },
  { type: "text", text: `Transcribe rows ${first} to ${last} of this report's Transactions table, following the rules.` },
];
