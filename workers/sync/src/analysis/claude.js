// Claude API calls for the analysis pipeline. Each call returns JSON in a fixed
// shape (structured outputs), plus the model and token counts, which are saved
// with the result and logged.
//   draftAnalysis  the card or the full analysis (claude-sonnet-5-5), or its
//                  one revision after the AI reviewer flags it
//   (review.js)    the AI reviewer pass (claude-sonnet-5-5)
//   (relevance.js) the cheap relevance check (claude-haiku-4-5)
import Anthropic from "@anthropic-ai/sdk";
import { INSTRUCTIONS, CARD_INSTRUCTIONS, constitutionBlock, schema, cardSchema, billMessage, revisionMessage, cardToDraft } from "./prompt.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export class DraftRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "DraftRefused";
  }
}

let cachedBlock = null;
export function constitution() {
  cachedBlock ||= constitutionBlock();
  return cachedBlock;
}

/**
 * One structured-output call. `system` is a list of text blocks; the last one
 * is cached (the Constitution, or a long fixed prompt). Options:
 *   thinking  true for adaptive thinking (Sonnet); omit for Haiku
 *   effort    output_config.effort (Sonnet only)
 *   fallback  opt into the API's server-side refusal fallback
 */
export async function structuredCall(env, { model, system, message, jsonSchema, maxTokens = 32000, thinking = false, effort = null, fallback = false }) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined, // tests point this at the fixture server
    maxRetries: 2,
  });
  const params = {
    model,
    max_tokens: maxTokens,
    output_config: { ...(effort ? { effort } : {}), format: { type: "json_schema", schema: jsonSchema } },
    system: system.map((text, i) => (i === system.length - 1 ? { type: "text", text, cache_control: { type: "ephemeral" } } : { type: "text", text })),
    messages: [{ role: "user", content: message }],
  };
  if (thinking) params.thinking = { type: "adaptive" };
  if (fallback) {
    // If the model declines on a safety category the API can retry on another
    // model in the same call; the model that actually answered is saved.
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const msg = await client.beta.messages.stream(params).finalMessage();

  const usage = {
    input_tokens: msg.usage.input_tokens || 0,
    output_tokens: msg.usage.output_tokens || 0,
    cache_read_tokens: msg.usage.cache_read_input_tokens || 0,
    cache_write_tokens: msg.usage.cache_creation_input_tokens || 0,
  };
  if (msg.stop_reason === "refusal") {
    const d = msg.stop_details || {};
    throw Object.assign(new DraftRefused(`model declined (${d.category || "no category"})`), { usage, model: msg.model });
  }
  if (msg.stop_reason === "max_tokens") {
    throw Object.assign(new Error("answer cut off at the output limit"), { usage, model: msg.model });
  }
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error(`answer was not valid JSON: ${err.message}`), { usage, model: msg.model });
  }
  return { data, model: msg.model, usage };
}

/**
 * Draft a card (depth "card", the default) or a full analysis (depth "full").
 * Returns {draft, model, usage, trimmed}: a card comes back in the full
 * analysis's shape, and `trimmed` lists provisions cut beyond the first three.
 */
export async function draftAnalysis(env, bill, source, depth = "card", revision = null) {
  const card = depth === "card";
  const { data, model, usage } = await structuredCall(env, {
    model: env.ANALYSIS_MODEL || DEFAULT_MODEL,
    // The instructions and the Constitution are identical for every bill of the
    // same kind, so they're cached across the bills in a run.
    system: [card ? CARD_INSTRUCTIONS : INSTRUCTIONS, constitution()],
    message: revision
      ? revisionMessage(bill, source, depth, revision.draft, revision.reasons)
      : billMessage(bill, source, depth),
    jsonSchema: card ? cardSchema() : schema(),
    maxTokens: card ? 16000 : 32000,
    thinking: true,
    effort: env.ANALYSIS_EFFORT || "high",
    fallback: true,
  });
  if (!card) return { draft: data, model, usage, trimmed: [] };
  const { draft, trimmed } = cardToDraft(data);
  return { draft, model, usage, trimmed };
}
