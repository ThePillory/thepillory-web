// The topics step: tags new items with topics after each sync's analysis round
// (called from src/analysis/index.js). Sends batches of TOPIC_BATCH items to a
// small model (claude-haiku-4-5) with the instructions in tag.js, and saves each
// item's topics and reason in topic_tags, and the item in topic_runs so it isn't
// sent again. Capped per day (TOPIC_DAILY_LIMIT items, 500); the rest wait.
//
// Order: county agenda items (newest meetings first), Platform excerpts,
// executive actions (newest first), then bills with recorded votes (newest
// first; bills the relevance check set aside as ceremonial or routine are left
// untagged). An excerpt is tagged again when its text changes. An item a person
// corrected on /admin/review/topics/ is locked and never re-tagged.
import { log } from "../db.js";
import { getState, setState, redact } from "../util.js";
import { structuredCall } from "../analysis/claude.js";
import { TOPIC_INSTRUCTIONS, topicSchema, topicMessage, cleanTags, TOPIC_MODEL, TOPIC_BATCH } from "./tag.js";
import { nextItems, saveTags } from "./store.js";

const day = () => new Date().toISOString().slice(0, 10);
const MIN_TIME_PER_BATCH_MS = 30 * 1000;

export async function runTopics(env, db, { run, deadline }) {
  const started = new Date().toISOString();
  if (!env.ANTHROPIC_API_KEY) return { tagged: 0, more_now: false };
  const limit = parseInt(env.TOPIC_DAILY_LIMIT || "500", 10);
  const key = `topics_${day()}`;
  let used = parseInt((await getState(db, key)) || "0", 10);
  let tagged = 0;
  let calls = 0;
  const tokens = { input: 0, output: 0 };
  let error = null;
  let stoppedEarly = false;
  while (used < limit) {
    if (deadline - Date.now() < MIN_TIME_PER_BATCH_MS) {
      stoppedEarly = true;
      break;
    }
    const batch = await nextItems(db, Math.min(TOPIC_BATCH, limit - used));
    if (!batch.length) break;
    try {
      const { data, model, usage } = await structuredCall(env, {
        model: env.TOPIC_MODEL || TOPIC_MODEL,
        system: [TOPIC_INSTRUCTIONS],
        message: topicMessage(batch),
        jsonSchema: topicSchema(batch.map((_, i) => `i${i + 1}`)),
        maxTokens: 6000,
      });
      calls += 1;
      tokens.input += usage.input_tokens;
      tokens.output += usage.output_tokens;
      const results = cleanTags(data, batch);
      await saveTags(db, results, model);
      tagged += results.length;
      used += batch.length;
      await setState(db, key, String(used));
      // Items the answer left out are tried again next time; stop if a whole batch came back empty.
      if (!results.length) break;
    } catch (err) {
      error = redact(`${err.name}: ${err.message}`);
      break;
    }
  }
  const more = !error && used < limit && (stoppedEarly || (await nextItems(db, 1)).length > 0);
  await log(
    db,
    run,
    "topics",
    error ? "error" : "ok",
    calls,
    `${tagged} item(s) tagged with topics in ${calls} call(s) (${tokens.input} tokens in, ${tokens.output} out); ${used} of ${limit} today${error ? `; stopped: ${error}` : used >= limit ? "; daily limit reached" : more ? "; more waiting" : "; nothing waiting"}`,
    started
  );
  return { tagged, more_now: more && stoppedEarly };
}
