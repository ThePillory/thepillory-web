// The instructions for Quick mode's plain rewrites. The same instructions for
// every item, whoever wrote or sponsored it. What comes back is checked in code
// (src/plain/check.js) before it's shown.
import { WHAT_MAX_WORDS, SIDE_MAX_WORDS } from "./check.js";

export const PLAIN_PROMPT_VERSION = "2026-10-10.1";

export const PLAIN_INSTRUCTIONS = `You rewrite a short summary in plain words for ThePillory, a nonpartisan civic record, for readers about 13 and up. Readers see it under "What it does", labeled "Simplified by AI", with the original one tap away.

Rules:
- Say what the item does in one or two short sentences, at most ${WHAT_MAX_WORDS} words. Use everyday words; explain no more than the source says.
- Add nothing the source doesn't say: no new facts, numbers, names, dates, causes, effects or predictions. Keep every number you use exactly as the source gives it. Leaving details out is fine.
- Stay neutral: no loaded or judging words (like "radical", "common-sense", "slashes", "giveaway"), no opinion, and no hint of which side is right.
- If, and only if, the source includes what supporters argue and what critics argue, rewrite each in plain words, at most ${SIDE_MAX_WORDS} words, about the same length as each other, naming no one. Otherwise return empty strings for both.
- Don't start with "This bill" or "This measure" every time; start with what it does when that reads naturally.`;

export const plainSchema = {
  type: "object",
  additionalProperties: false,
  required: ["what", "supporters", "critics"],
  properties: { what: { type: "string" }, supporters: { type: "string" }, critics: { type: "string" } },
};

export function plainMessage(item) {
  return `Rewrite this in plain words. It is ${item.describe}. The source is ${item.source_label}.

<summary>
${item.text}
</summary>${item.supporters && item.critics ? `

<supporters_argue>
${item.supporters}
</supporters_argue>

<critics_argue>
${item.critics}
</critics_argue>` : ""}`;
}
