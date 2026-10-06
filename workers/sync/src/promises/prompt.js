// The prompt and output shape for proposing promises from one official
// document. The same instructions for every official, whatever their office or
// party. Bump PROMISE_PROMPT_VERSION when this file changes.

export const PROMISE_PROMPT_VERSION = "2026-10-06.2";
export const MAX_PER_DOCUMENT = 3;

export const INSTRUCTIONS = `You find promises in official government documents for ThePillory, a nonpartisan civic record. A person reviews every candidate before anything is published.

A promise is a specific, checkable commitment by the named official (or their office, speaking for them) to do something in the future: an action, with an object, that a reader could later check happened or didn't. For example: signing or vetoing a named measure, issuing a named order, opening or closing a named facility, funding a named program at a stated amount, meeting a stated target by a stated date.

These are NOT promises:
- values, beliefs, priorities or positions ("I believe in…", "we stand with…", "protecting families is my priority");
- descriptions of what was already done ("signed", "announced", "launched today");
- predictions about others, or general aims without an action ("make the state safer", "a golden age");
- commitments by someone else (another official, a company, a quoted guest), unless the document says the official commits to it;
- claims about opponents or comparisons with them.

Rules:
- quote: copy the sentence or clause that states the commitment word for word from the document, with no changes, additions, ellipses or brackets. If you can't quote it exactly, leave it out. Prefer the official's own words; a sentence of the document stating "[the official] will …" also counts.
- check_note: one short, neutral sentence on what a reader could check to see it done (for example: "A signed executive order that …", "A budget that funds … at …"). Plain words only: no judgment of the official, no loaded or dramatic words, no prediction of whether it will happen, no party labels.
- due: only when the quote itself states a date or deadline, copy it as stated; otherwise an empty string.
- speaker: the official's name exactly as given in the list of officials.
- Return at most ${MAX_PER_DOCUMENT} promises: the clearest and most checkable. Return none when the document has none; most documents have none. Never invent or paraphrase.`;

export function schema(speakers) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["promises"],
    properties: {
      promises: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["speaker", "quote", "check_note", "due"],
          properties: {
            speaker: { type: "string", enum: speakers },
            quote: { type: "string" },
            check_note: { type: "string" },
            due: { type: "string" },
          },
        },
      },
    },
  };
}

const KIND = {
  press_release: "an official press release",
  address: "an official address",
  minutes: "official meeting minutes",
  agenda: "an official meeting agenda",
  campaign_site: "the official's campaign website page (as the campaign states it; keep only specific commitments to act, not slogans or positions)",
  office_site: "the official's office website page (keep only specific commitments to act, not descriptions of the office's work)",
};

export function documentMessage(doc, officials) {
  return `Officials (use these exact names as "speaker"):
${officials.map((o) => `- ${o.name}, ${o.office}`).join("\n")}

The document is ${KIND[doc.kind] || "an official document"}: "${doc.title}", dated ${doc.published_on || "(no date given)"}.

<document>
${doc.text}
</document>`;
}
