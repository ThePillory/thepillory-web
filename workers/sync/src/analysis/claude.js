// One Claude API call per bill. Returns the parsed draft plus the model and
// token counts, which are saved with the draft and logged.
import Anthropic from "@anthropic-ai/sdk";
import { INSTRUCTIONS, constitutionBlock, schema, billMessage } from "./prompt.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export class DraftRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "DraftRefused";
  }
}

let cachedBlock = null;

export async function draftAnalysis(env, bill, source) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined, // tests point this at the fixture server
    maxRetries: 2,
  });
  cachedBlock ||= constitutionBlock();
  const stream = client.beta.messages.stream({
    model: env.ANALYSIS_MODEL || DEFAULT_MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: env.ANALYSIS_EFFORT || "high",
      format: { type: "json_schema", schema: schema() },
    },
    // If the model declines on a safety category the API can retry on another
    // model in the same call; the model that actually wrote the draft is saved.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // The instructions and the Constitution are identical for every bill, so
    // they're cached across the bills in a run; only the bill text changes.
    system: [
      { type: "text", text: INSTRUCTIONS },
      { type: "text", text: cachedBlock, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: billMessage(bill, source) }],
  });
  const msg = await stream.finalMessage();

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
    throw Object.assign(new Error("draft cut off at the output limit"), { usage, model: msg.model });
  }
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let draft;
  try {
    draft = JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error(`draft was not valid JSON: ${err.message}`), { usage, model: msg.model });
  }
  return { draft, model: msg.model, usage };
}
