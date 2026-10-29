// D1 rows read and written, counted where they happen: per page request (the
// site's Functions, through guard() and functions/_middleware.js) and per sync
// step (src/index.js). Every D1 result carries meta.rows_read and
// meta.rows_written; meterD1() adds them to a tally without changing what the
// caller gets back. Pure (no bindings of its own); tested in test/usage.test.mjs.
//
// Nothing about a visitor is kept: a page is recorded by its route pattern
// ("/reps/:id/"), never its URL or query string, and the SQL by its text with
// literals replaced by "?", never the values bound to it.

/** A fresh tally for one request or one step. */
export function newTally() {
  return { rowsRead: 0, rowsWritten: 0, queries: new Map() };
}

/** The SQL text without its values: whitespace collapsed, string and number literals replaced by "?", 400 characters at most. Pure. */
export function sqlShape(sql) {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?…)")
    .trim()
    .slice(0, 400);
}

/** A short stable key for a SQL shape. Pure. */
export function sqlKey(shape) {
  let h = 2166136261;
  for (let i = 0; i < shape.length; i++) h = Math.imul(h ^ shape.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function add(tally, sql, meta) {
  const read = Number(meta && meta.rows_read) || 0;
  const written = Number(meta && meta.rows_written) || 0;
  tally.rowsRead += read;
  tally.rowsWritten += written;
  const shape = sqlShape(sql);
  const q = tally.queries.get(shape) || { calls: 0, rowsRead: 0, rowsWritten: 0 };
  q.calls++;
  q.rowsRead += read;
  q.rowsWritten += written;
  tally.queries.set(shape, q);
}

function statement(stmt, sql, tally) {
  return {
    __metered: stmt,
    __sql: sql,
    bind: (...args) => statement(stmt.bind(...args), sql, tally),
    all: async () => {
      const r = await stmt.all();
      add(tally, sql, r && r.meta);
      return r;
    },
    run: async () => {
      const r = await stmt.run();
      add(tally, sql, r && r.meta);
      return r;
    },
    // first() through all(): the same query and rows read (D1 runs the statement in full either way), with its meta.
    first: async (col) => {
      const r = await stmt.all();
      add(tally, sql, r && r.meta);
      const row = (r && r.results && r.results[0]) ?? null;
      return col === undefined ? row : row ? row[col] ?? null : null;
    },
    // raw() returns no meta: passed through, its rows not counted.
    raw: (o) => stmt.raw(o),
  };
}

/**
 * A D1 binding that adds each query's rows read and written to `tally`. Wraps any D1-shaped
 * binding (the real one, or src/d1retry.js's), and batch() hands the wrapped one its own statements.
 */
export function meterD1(db, tally) {
  if (!db || !tally) return db;
  return {
    __meteredDb: true,
    prepare: (sql) => statement(db.prepare(sql), sql, tally),
    batch: async (stmts) => {
      const results = await db.batch(stmts.map((s) => (s && s.__metered) || s));
      (results || []).forEach((r, i) => add(tally, (stmts[i] && stmts[i].__sql) || "(batch)", r && r.meta));
      return results;
    },
    exec: (sql) => db.exec(sql),
    dump: db.dump ? () => db.dump() : undefined,
  };
}

/** The same env with DB metered into `tally`; every other binding unchanged. */
export function meteredEnv(env, tally) {
  if (!env || !env.DB || !tally) return env;
  return Object.create(env, { DB: { value: meterD1(env.DB, tally), enumerable: true } });
}

// Path segments kept as they are in a route pattern; anything else (a slug, an id, a date,
// a state) becomes ":id". Route folders and the fixed words under them.
const WORDS = new Set(
  (
    "about admin api awards ballot bodies briefing calaveras candidates corrections court district elections explore " +
    "finances foreign-agents home justices laws meetings place races reps saved states topics trades votes waitlist you " +
    "search issues report assets data geo zip local-money history scotus " +
    "bills orders constitution analysis rollcall earmarks travel funding more promises flag measure contest ballot " +
    "map term cases review health usage statements pages new candidates networth measures relevance batch " +
    "search-officials districts form700 records tiers disclaimer data-status methodology how-it-works principles " +
    "pacs industries employers california"
  ).split(" ")
);

/** A page's route pattern: "/reps/jane-doe/votes/" -> "/reps/:id/votes/". No query string, ever. Pure. */
export function routePattern(pathname) {
  const path = String(pathname || "/").split("?")[0];
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return "/";
  // Static files: by folder and extension only.
  if (/\.[a-z0-9]{1,5}$/i.test(parts[parts.length - 1])) {
    const ext = parts[parts.length - 1].split(".").pop().toLowerCase();
    return `/${parts.length > 1 ? `${parts[0]}/` : ""}*.${ext}`;
  }
  const out = parts.map((p, i) => (i === 0 || WORDS.has(p.toLowerCase()) ? p.toLowerCase() : ":id"));
  // Collapse runs of ids ("/place/:id/:id/" stays two, but never more than three in a row).
  return `/${out.join("/")}/`.replace(/(\/:id){4,}/g, "/:id/:id/:id");
}

// User agents that say they're automated: search crawlers, AI crawlers, SEO tools, scripts.
const BOT_UA = /bot\b|bot\/|crawl|spider|slurp|scrapy|python-requests|python-urllib|aiohttp|httpx|curl\/|wget|go-http-client|java\/|okhttp|libwww|node-fetch|axios|headless|phantomjs|puppeteer|playwright|semrush|ahrefs|mj12|dotbot|blexbot|petalbot|bytespider|gptbot|claudebot|ccbot|perplexity|facebookexternalhit|amazonbot|applebot|yandex|baidu|duckduckbot|bingpreview|ia_archiver|archive\.org_bot|uptime|monitor|pingdom|statuscake/i;

/**
 * Who a request is from, as far as Cloudflare and the user agent say: 'verified-bot' (Cloudflare's
 * verified bot signal), 'likely-bot' (a bot score under 30, or a user agent that says it's
 * automated, or none), or 'person'. Nothing is kept but this label. Pure.
 */
export function visitorKind(request) {
  const cf = (request && request.cf) || {};
  const bm = cf.botManagement || {};
  if (bm.verifiedBot || cf.verifiedBotCategory) return "verified-bot";
  if (typeof bm.score === "number" && bm.score > 0 && bm.score < 30) return "likely-bot";
  const ua = (request && request.headers && request.headers.get("user-agent")) || "";
  if (!ua || BOT_UA.test(ua)) return "likely-bot";
  return "person";
}
