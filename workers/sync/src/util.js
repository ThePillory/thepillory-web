// Small helpers shared by the sync steps.

export class BudgetExhausted extends Error {
  constructor(msg) {
    super(msg);
    this.name = "BudgetExhausted";
  }
}

export class UpstreamError extends Error {
  constructor(url, status, body, retryAfterMs = null) {
    super(`${status} from ${redact(url)}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "UpstreamError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// HTTP statuses that usually pass: rate limits, overloaded or unreachable
// servers, and Cloudflare's 52x errors (524: the origin took too long).
export const TEMPORARY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529, 530]);

/** true for an error a later attempt can get past: a temporary HTTP status, or a network failure. */
export function isTemporary(err) {
  if (!err) return false;
  if (err instanceof UpstreamError || err.name === "UpstreamError") return TEMPORARY_STATUS.has(err.status);
  return err.name === "TypeError" && /fetch|network|connection|socket|timed? ?out/i.test(String(err.message || ""))
    || /network connection lost|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(err.message || ""));
}

/** Retry-After in milliseconds (seconds or an HTTP date), or null. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * The wait before retry `attempt` (1, 2, 3…): the server's Retry-After when it
 * gives one, else exponential backoff (2 s, 6 s, 18 s…) with ±25% jitter.
 */
export function backoffMs(attempt, retryAfter = null, { baseMs = 2000, factor = 3, random = Math.random } = {}) {
  if (retryAfter != null) return retryAfter;
  return Math.round(baseMs * factor ** (attempt - 1) * (0.75 + random() * 0.5));
}

// Never log API keys.
export function redact(url) {
  return String(url).replace(/(api_key|apikey|token)=[^&]+/gi, "$1=REDACTED");
}

const USER_AGENT = "ThePilloryDataSync/1.0 (+https://thepillory.co)";

/**
 * Counts outbound requests against:
 *  - a per-run cap (Workers limit subrequests per invocation), and
 *  - a wall-clock deadline (so a run stops cleanly before it is killed),
 *  - plus, for Open States, a per-UTC-day cap stored in D1 and a minimum
 *    interval between calls.
 */
export class Budget {
  constructor(env, deadlineMs) {
    this.env = env;
    this.max = parseInt(env.MAX_SUBREQUESTS || "45", 10);
    this.used = 0;
    this.deadline = Date.now() + deadlineMs;
    this.lastOpenStates = 0;
    this.osUsedToday = null;
  }

  remaining() {
    return this.max - this.used;
  }

  timeLeft() {
    return this.deadline - Date.now();
  }

  take(label) {
    if (this.used >= this.max) throw new BudgetExhausted(`request budget used up (${this.max}) before ${label}`);
    if (this.timeLeft() < 5000) throw new BudgetExhausted(`run time limit reached before ${label}`);
    this.used += 1;
  }

  /**
   * One request, retried on a temporary error (a 429, a 5xx or 52x, or a
   * network failure) up to FETCH_RETRIES (3) times with backoff, honoring the
   * server's Retry-After. It doesn't wait longer than FETCH_RETRY_MAX_WAIT_MS
   * (60 s) at a time or past the round's deadline; then the error is thrown,
   * and the step reports "partial" and is tried again in a later round.
   */
  async fetch(url, init = {}, label = "request") {
    const retries = parseInt(this.env.FETCH_RETRIES || "3", 10);
    const maxWait = parseInt(this.env.FETCH_RETRY_MAX_WAIT_MS || "60000", 10);
    const sleep = this.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt++) {
      this.take(label);
      const headers = { "User-Agent": USER_AGENT, ...(init.headers || {}) };
      let err;
      try {
        const res = await (this.fetchImpl || fetch)(url, { ...init, headers });
        if (res.ok) return res;
        let body = "";
        try {
          body = await res.text();
        } catch (_) {}
        err = new UpstreamError(url, res.status, body, retryAfterMs(res.headers && res.headers.get && res.headers.get("Retry-After")));
      } catch (e) {
        err = e;
      }
      if (!isTemporary(err) || attempt > retries) throw err;
      const wait = backoffMs(attempt, err.retryAfterMs);
      if (wait > maxWait || this.timeLeft() < wait + 15000) throw err;
      console.warn(`${label}: temporary error (${redact(String(err.message || err))}); retry ${attempt} of ${retries} in ${Math.round(wait / 1000)} s`);
      this.retries = (this.retries || 0) + 1;
      await sleep(wait);
    }
  }

  async json(url, init, label) {
    const res = await this.fetch(url, init, label);
    return res.json();
  }

  async text(url, init, label) {
    const res = await this.fetch(url, init, label);
    return res.text();
  }

  // A polite source: a minimum gap between requests (kept across rounds and runs,
  // e.g. a robots.txt Crawl-delay) and its own daily cap, both stored in sync_state.
  async paced(db, key, { intervalMs, dailyLimit }, url, init, label) {
    this.pacedUsed ||= {};
    const countKey = `${key}_requests_${new Date().toISOString().slice(0, 10)}`;
    if (this.pacedUsed[key] === undefined) this.pacedUsed[key] = parseInt((await getState(db, countKey)) || "0", 10);
    if (this.pacedUsed[key] >= dailyLimit) throw new BudgetExhausted(`${key} daily limit (${dailyLimit}) reached`);
    const last = parseInt((await getState(db, `${key}_last_request`)) || "0", 10);
    const wait = last + intervalMs - Date.now();
    if (wait > 0) {
      if (this.timeLeft() < wait + 15000) throw new BudgetExhausted(`run time limit reached before ${label}`);
      await new Promise((r) => setTimeout(r, wait));
    }
    this.pacedUsed[key] += 1;
    await setState(db, countKey, String(this.pacedUsed[key]));
    await setState(db, `${key}_last_request`, String(Date.now()));
    return this.fetch(url, init, label);
  }

  // Open States: daily cap (persisted) and pacing between calls. `reserve`
  // requests are left for another step (see openStatesReserve).
  async openStates(db, url, init, label, { reserve = 0 } = {}) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `openstates_requests_${day}`;
    if (this.osUsedToday === null) {
      const row = await db.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first();
      this.osUsedToday = row ? parseInt(row.value, 10) : 0;
    }
    const limit = parseInt(this.env.OPENSTATES_DAILY_LIMIT || "250", 10);
    if (this.osUsedToday >= limit) throw new BudgetExhausted(`Open States daily limit (${limit}) reached`);
    if (reserve > 0 && this.osUsedToday >= limit - reserve) {
      throw new BudgetExhausted(`Open States daily limit (${limit}) reached, less the ${reserve} kept for loading state legislators`);
    }
    const gap = parseInt(this.env.OPENSTATES_MIN_INTERVAL_MS || "6500", 10);
    const wait = this.lastOpenStates + gap - Date.now();
    if (wait > 0) {
      if (this.timeLeft() < wait + 5000) throw new BudgetExhausted(`run time limit reached before ${label}`);
      await new Promise((r) => setTimeout(r, wait));
    }
    this.lastOpenStates = Date.now();
    this.osUsedToday += 1;
    await setState(db, key, String(this.osUsedToday));
    return this.json(url, init, label);
  }
}

export async function getState(db, key) {
  const row = await db.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export async function setState(db, key, value) {
  await db
    .prepare(
      "INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .bind(key, value)
    .run();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function slugify(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
}

// The Congress in session on a given date (the 119th began January 3, 2025).
export function currentCongress(date = new Date()) {
  const y = date.getUTCFullYear();
  const beforeJan3 = date.getUTCMonth() === 0 && date.getUTCDate() < 3;
  const year = beforeJan3 ? y - 1 : y;
  return Math.floor((year - 1789) / 2) + 1;
}

// Sessions of that Congress that have started by the given date.
export function congressSessions(congress, date = new Date()) {
  const firstYear = 1789 + (congress - 1) * 2;
  return date.getUTCFullYear() > firstYear ? [1, 2] : [1];
}

export function isHttp(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

const MONTHS = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

// "September 18, 2025, 11:52 AM" -> "2025-09-18"
export function parseLongDate(s) {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(s || "");
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, "0")}`;
}

// Minimal XML helpers for the flat senate.gov roll call files.
export function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .trim();
}

export function xmlTag(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]) : "";
}

export function xmlBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
