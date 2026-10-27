// What the AI calls cost: the price of a call from its tokens, and a running
// total by day, sync step and model in ai_usage (migration 0045), written as
// each call returns (src/analysis/claude.js, src/analysis/agenda.js). The step
// is the one src/index.js is running (setStep()); calls outside a step are
// logged as "other". A failure to log is reported, never fatal to the call.

// $ per million tokens: [input, output]. Cache writes cost 1.25 times input;
// cache reads a tenth of input (Claude Opus 5.5: a twentieth).
export const PRICES = { "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20], "claude-haiku-4-5": [1, 5] };
const CACHE_READ = { "claude-opus-5-5": 0.05 };

const priceKey = (model) => Object.keys(PRICES).find((k) => String(model || "").startsWith(k)) || "claude-opus-5-5";

/** Dollars for one call at the list price. Unknown models at the Opus price. Pure. */
export function dollarsFor(model, usage = {}) {
  const key = priceKey(model);
  const [inp, out] = PRICES[key];
  const read = CACHE_READ[key] ?? 0.1;
  return ((usage.input_tokens || 0) * inp + (usage.output_tokens || 0) * out + (usage.cache_read_tokens || 0) * inp * read + (usage.cache_write_tokens || 0) * inp * 1.25) / 1e6;
}

/** Cents for one call (the resolution step's daily cap counts in cents). Pure. */
export const centsFor = (model, usage = {}) => dollarsFor(model, usage) * 100;

let step = "other";
/** The sync step now running; every call until the next setStep() is counted under it. */
export function setStep(name) {
  step = name || "other";
}

/** Add one call to today's row for this step and model. */
export async function recordUsage(db, model, usage) {
  if (!db || !usage) return;
  const day = new Date().toISOString().slice(0, 10);
  try {
    await db
      .prepare(
        `INSERT INTO ai_usage (day, step, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT (day, step, model) DO UPDATE SET calls = calls + 1, input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens, cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens, cost_usd = cost_usd + excluded.cost_usd`
      )
      .bind(day, step, String(model || "unknown"), usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_tokens || 0, usage.cache_write_tokens || 0, dollarsFor(model, usage))
      .run();
  } catch (err) {
    console.error(`ai_usage not recorded (${step}, ${model}): ${err && err.message}`);
  }
}
