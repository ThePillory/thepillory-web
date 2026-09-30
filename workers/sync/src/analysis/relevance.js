// The relevance check: a cheap claude-haiku-4-5 call, before any drafting, that
//   - skips ceremonial and routine measures (commemorations, awareness days,
//     post office and building namings, honorary resolutions, rules that only
//     set how a chamber will debate another bill), and
//   - rates how much each bill bears on Calaveras County (California, rural
//     counties, federal lands, water, wildfire, roads, …), so the daily cap
//     goes to what matters most here.
// Bills are sent in batches, by number and title only. Every verdict is saved
// in bill_relevance with its reason; a person can un-skip a bill at /admin/review/.
import { structuredCall } from "./claude.js";

export const RELEVANCE_MODEL = "claude-haiku-4-5-20251001";
export const RELEVANCE_PROMPT_VERSION = "2026-09-30.1";
export const BATCH = 25;

export const CATEGORIES = ["substantive", "procedural_rule", "commemoration", "awareness", "naming", "honorary", "other_routine"];
export const LOCAL = ["high", "medium", "low", "none"];
export const LOCAL_RANK = { high: 3, medium: 2, low: 1, none: 0 };

export const RELEVANCE_INSTRUCTIONS = `You sort bills for The Pillory, a nonpartisan civic site for residents of Calaveras County, California: a rural county in the Sierra Nevada foothills with national forest and other federal land, rivers and reservoirs, high wildfire risk, and long rural roads. The site writes a constitutional analysis of the bills its residents' officials vote on. You decide, for each bill, from its number and title only, whether an analysis is worth writing, and how much the bill bears on this county.

For each bill:
- verdict: "skip" only for ceremonial or routine measures that change no law or policy of substance:
  - commemoration: commemorating an event, anniversary or person
  - awareness: designating an awareness day, week or month
  - naming: naming or renaming a post office, federal building, courthouse, road, facility or feature
  - honorary: congratulating, honoring or recognizing people, teams, groups or achievements
  - procedural_rule: a resolution that only sets how a chamber will consider or debate another bill
  - other_routine: another purely ceremonial or housekeeping measure (say which in the reason)
  Everything else is "analyze" (category "substantive"), including anything that spends money, changes a program, a right, a tax, a rule or a power. If you are unsure, choose "analyze".
- reason: one short, neutral sentence saying why.
- local: how directly the bill bears on residents of this county.
  - "high": it is about California, rural counties or communities, federal or public lands and forests, water, wildfire, roads and rural transportation, rural broadband, agriculture or ranching, or local government, or it changes something county residents directly use or pay.
  - "medium": broad national or statewide policy that reaches residents here as it reaches everyone.
  - "low": mainly about other places, or a narrow group with little presence here.
  - "none": no connection to residents here.
- local_reason: one short, neutral sentence.

Judge by subject only. Never by party, sponsor, ideology or whether a measure is popular; don't mention any of those.`;

export function relevanceSchema(ids) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["bills"],
    properties: {
      bills: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["bill_id", "verdict", "category", "reason", "local", "local_reason"],
          properties: {
            bill_id: { type: "string", enum: ids },
            verdict: { type: "string", enum: ["analyze", "skip"] },
            category: { type: "string", enum: CATEGORIES },
            reason: { type: "string" },
            local: { type: "string", enum: LOCAL },
            local_reason: { type: "string" },
          },
        },
      },
    },
  };
}

export function relevanceMessage(bills) {
  const lines = bills.map((b) => `${b.id} | ${b.bill_number} | ${b.level === "state" ? "California Legislature" : "U.S. Congress"} | ${b.title}`);
  return `Bills, one per line, as: id | number | legislature | title\n\n${lines.join("\n")}\n\nReturn one entry for every bill.`;
}

/**
 * Keep only well-formed verdicts for bills that were asked about, once each.
 * A "skip" must come with a routine category; otherwise it's treated as
 * "analyze" (the check only skips what it can name). Pure; tested.
 */
export function cleanVerdicts(data, bills) {
  const asked = new Set(bills.map((b) => b.id));
  const out = new Map();
  for (const v of (data && data.bills) || []) {
    if (!v || !asked.has(v.bill_id) || out.has(v.bill_id)) continue;
    let verdict = v.verdict === "skip" ? "skip" : "analyze";
    let category = CATEGORIES.includes(v.category) ? v.category : "substantive";
    if (verdict === "skip" && category === "substantive") verdict = "analyze";
    if (verdict === "analyze") category = "substantive";
    out.set(v.bill_id, {
      bill_id: v.bill_id,
      verdict,
      category,
      reason: String(v.reason || "").trim().slice(0, 400) || (verdict === "skip" ? "Ceremonial or routine measure." : "Substantive measure."),
      local: LOCAL.includes(v.local) ? v.local : "medium",
      local_reason: String(v.local_reason || "").trim().slice(0, 400),
    });
  }
  return [...out.values()];
}

/** Check one batch. Returns {verdicts, model, usage}. */
export async function checkRelevance(env, bills) {
  const { data, model, usage } = await structuredCall(env, {
    model: env.RELEVANCE_MODEL || RELEVANCE_MODEL,
    system: [RELEVANCE_INSTRUCTIONS],
    message: relevanceMessage(bills),
    jsonSchema: relevanceSchema(bills.map((b) => b.id)),
    maxTokens: 8000,
  });
  return { verdicts: cleanVerdicts(data, bills), model, usage };
}
