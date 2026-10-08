// Topic tagging: the instructions, the answer's shape and the checks. Pure (no
// SDK); the call itself is in index.js. Tested in test/topics.test.mjs.
//
// Each item (a bill, a county agenda item, an executive action, or a Platform
// excerpt) gets up to three topics from the fixed list, each with one short,
// neutral sentence saying why. Items that are only procedure (a roll call, the
// pledge, approving minutes, a ceremonial resolution) get none. The same
// instructions for every item, place, official and party.
import { TOPICS, TOPIC } from "./list.js";
import { wordingProblems } from "../promises/check.js";

export const TOPIC_MODEL = "claude-haiku-4-5-20251001";
export const TOPIC_PROMPT_VERSION = "2026-10-08.1";
export const TOPIC_BATCH = 25;
export const MAX_TOPICS = 3;
const TEXT_CHARS = 900;

export const KIND_LABEL = {
  bill: "Bill",
  meeting_item: "County agenda item",
  executive_action: "Executive action",
  platform: "Excerpt from an official's own Issues or Priorities page",
};

export const TOPIC_INSTRUCTIONS = `You tag public records with topics for ThePillory, a nonpartisan civic record. Readers use the topics to find, for one subject, the bills, local agenda items, executive actions and officials' own statements about it, side by side.

The topics (use only these slugs):
${TOPICS.map((t) => `- ${t.slug}: ${t.name}. ${t.about}`).join("\n")}

For each item:
- topics: the one to three topics the item is mainly about, most central first. Tag what the item itself does or says, not every subject it might affect: a bill that funds wildfire crews is wildfire (and maybe taxes-budget if it is mainly about money), not environment and jobs-economy too.
- Give no topics (an empty list) when the item is only procedure or ceremony: a roll call, the pledge, approving minutes or a consent calendar as a whole, public comment, adjournment, closed-session announcements without a subject, a commemoration or honorary resolution.
- reason: one short, plain sentence saying what the item is about that makes those topics fit. Describe; never judge. No words like good, bad, harmful, extreme, radical, controversial, or anything about party, ideology or motive.

Judge by subject only, the same way for every item, official and party.`;

export function topicSchema(ids) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "topics", "reason"],
          properties: {
            id: { type: "string", enum: ids },
            topics: { type: "array", items: { type: "string", enum: TOPICS.map((t) => t.slug) } },
            reason: { type: "string" },
          },
        },
      },
    },
  };
}

const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The batch, one item per block: "<n> | <kind> | <text>". Items get short ids (i1, i2, …). */
export function topicMessage(items) {
  const lines = items.map((it, i) => `i${i + 1} | ${KIND_LABEL[it.kind] || it.kind} | ${clip(it.text, TEXT_CHARS)}`);
  return `Items, as: id | kind | text\n\n${lines.join("\n\n")}\n\nReturn one entry for every item.`;
}

/**
 * Keep only answers for items that were asked about, once each: topics from
 * the list, no repeats, at most three; a reason with loaded or judging wording
 * is replaced by a plain one (the topics stay). Returns
 * [{ item, topics, reason }] in the batch's order, items without an answer left out.
 */
export function cleanTags(data, items) {
  const byId = new Map(items.map((it, i) => [`i${i + 1}`, it]));
  const out = new Map();
  for (const a of (data && data.items) || []) {
    if (!a || !byId.has(a.id) || out.has(a.id)) continue;
    const topics = [...new Set((Array.isArray(a.topics) ? a.topics : []).filter((t) => TOPIC[t]))].slice(0, MAX_TOPICS);
    let reason = String(a.reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!reason || wordingProblems(reason, { strict: false }).length) {
      reason = topics.length ? `About ${topics.map((t) => TOPIC[t].name.toLowerCase()).join(", ")}.` : "Procedure or ceremony; no topic.";
    }
    out.set(a.id, { item: byId.get(a.id), topics, reason });
  }
  return items.map((it, i) => out.get(`i${i + 1}`)).filter(Boolean);
}
