// Cloudflare usage and its estimated cost, from the GraphQL Analytics API
// (https://api.cloudflare.com/client/v4/graphql): D1 rows read and written and
// storage, Workers and Pages Functions requests and CPU, Durable Object
// requests and duration, R2 storage and operations, Workers AI neurons. Pure
// apart from the fetch; the token (Account Analytics Read) is a secret, never
// in the repo. Used by the sync's daily usage check (src/usage/sync.js), the
// admin page /admin/usage/ (through the stored daily rows) and the one-off
// report tools/cf_usage.mjs. Tested in test/usage.test.mjs.

export const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

// Workers Paid, as Cloudflare publishes it (checked in docs/data-sync.md, "What Cloudflare costs"):
// each line's monthly included amount and the price per `per` units beyond it.
export const PRICES = {
  base: { label: "Workers Paid subscription", monthly: 5 },
  workersRequests: { label: "Workers and Pages Functions requests", included: 10e6, per: 1e6, price: 0.3, unit: "requests" },
  workersCpuMs: { label: "Workers and Pages Functions CPU time", included: 30e6, per: 1e6, price: 0.02, unit: "CPU ms" },
  d1RowsRead: { label: "D1 rows read", included: 25e9, per: 1e6, price: 0.001, unit: "rows" },
  d1RowsWritten: { label: "D1 rows written", included: 50e6, per: 1e6, price: 1.0, unit: "rows" },
  d1StorageGb: { label: "D1 storage", included: 5, per: 1, price: 0.75, unit: "GB-month", level: true },
  doRequests: { label: "Durable Object requests", included: 1e6, per: 1e6, price: 0.15, unit: "requests" },
  doGbSeconds: { label: "Durable Object duration", included: 400e3, per: 1e6, price: 12.5, unit: "GB-s" },
  r2StorageGb: { label: "R2 storage", included: 10, per: 1, price: 0.015, unit: "GB-month", level: true },
  r2ClassA: { label: "R2 Class A operations", included: 1e6, per: 1e6, price: 4.5, unit: "operations" },
  r2ClassB: { label: "R2 Class B operations", included: 10e6, per: 1e6, price: 0.36, unit: "operations" },
  aiNeurons: { label: "Workers AI", included: 10e3 * 30, per: 1e3, price: 0.011, unit: "neurons" },
};
const DO_GB = 128 / 1024; // a Durable Object is billed at 128 MB while active

// R2 operations by action type (Class A changes or lists, Class B reads).
const CLASS_A = /^(ListBuckets|PutBucket|ListObjects|PutObject|CopyObject|CompleteMultipartUpload|CreateMultipartUpload|UploadPart|UploadPartCopy|ListMultipartUploads|ListParts|PutBucketEncryption|PutBucketCors|PutBucketLifecycleConfiguration|LifecycleStorageTierTransition)$/;
const FREE = /^(DeleteObject|DeleteObjects|DeleteBucket|AbortMultipartUpload)$/;

/** One GraphQL query per dataset, so a field one account can't see doesn't hide the others. */
export const QUERIES = {
  d1: `d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $since, date_leq: $until}, orderBy: [date_ASC]) { dimensions { date databaseId } sum { readQueries writeQueries rowsRead rowsWritten } }`,
  d1Storage: `d1StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $since, date_leq: $until}, orderBy: [date_ASC]) { dimensions { date databaseId } max { databaseSizeBytes } }`,
  workers: `workersInvocationsAdaptive(limit: 10000, filter: {date_geq: $since, date_leq: $until}, orderBy: [date_ASC]) { dimensions { date scriptName } sum { requests errors subrequests cpuTimeUs } }`,
  pages: `pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: {date_geq: $since, date_leq: $until}, orderBy: [date_ASC]) { dimensions { date scriptName } sum { requests errors subrequests } }`,
  doInvocations: `durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {date_geq: $since, date_leq: $until}, orderBy: [date_ASC]) { dimensions { date scriptName } sum { requests } }`,
  doPeriodic: `durableObjectsPeriodicGroups(limit: 10000, filter: {date_geq: $since, date_leq: $until}, orderBy: [date_ASC]) { dimensions { date namespaceId } sum { activeTime cpuTime storageReadUnits storageWriteUnits } }`,
  r2Storage: `r2StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $since, date_leq: $until}, orderBy: [date_ASC]) { dimensions { date bucketName } max { payloadSize metadataSize objectCount } }`,
  r2Ops: `r2OperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $since, date_leq: $until}, orderBy: [date_ASC]) { dimensions { date bucketName actionType } sum { requests } }`,
  ai: `aiInferenceAdaptiveGroups(limit: 10000, filter: {date_geq: $since, date_leq: $until}, orderBy: [date_ASC]) { dimensions { date modelId } sum { totalNeurons } }`,
};

/** Every dataset for an account between two dates (YYYY-MM-DD, inclusive): {name: rows | {error}}. */
export async function fetchUsage({ accountId, token, since, until, fetchImpl = fetch }) {
  const out = {};
  for (const [name, body] of Object.entries(QUERIES)) {
    const query = `query U($account: String!, $since: Date!, $until: Date!) { viewer { accounts(filter: {accountTag: $account}) { rows: ${body} } } }`;
    try {
      const res = await fetchImpl(GRAPHQL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { account: accountId, since, until } }),
      });
      const json = await res.json().catch(() => ({}));
      const errors = (json.errors || []).map((e) => e.message).filter(Boolean);
      const rows = json.data && json.data.viewer && json.data.viewer.accounts && json.data.viewer.accounts[0] ? json.data.viewer.accounts[0].rows : null;
      out[name] = rows && !errors.length ? rows : { error: errors.join("; ") || `HTTP ${res.status}` };
    } catch (err) {
      out[name] = { error: `${err.name}: ${err.message}` };
    }
  }
  return out;
}

const n = (v) => Number(v) || 0;
const list = (x) => (Array.isArray(x) ? x : []);

/**
 * The datasets folded into one row per day, the units the prices use:
 * {day, workersRequests, workersCpuMs, d1RowsRead, d1RowsWritten, d1StorageGb, doRequests, doGbSeconds,
 *  r2StorageGb, r2ClassA, r2ClassB, aiNeurons, byScript: {script: {requests, cpuMs}}, byDatabase: {id: {rowsRead, rowsWritten}}}.
 * Pure.
 */
export function dailyUsage(data) {
  const days = new Map();
  const at = (d) => {
    if (!days.has(d)) days.set(d, { day: d, workersRequests: 0, workersCpuMs: 0, pagesRequests: 0, d1RowsRead: 0, d1RowsWritten: 0, d1StorageGb: 0, doRequests: 0, doGbSeconds: 0, doCpuMs: 0, r2StorageGb: 0, r2ClassA: 0, r2ClassB: 0, aiNeurons: 0, byScript: {}, byDatabase: {} });
    return days.get(d);
  };
  for (const r of list(data.d1)) {
    const d = at(r.dimensions.date);
    d.d1RowsRead += n(r.sum.rowsRead);
    d.d1RowsWritten += n(r.sum.rowsWritten);
    const db = (d.byDatabase[r.dimensions.databaseId] ||= { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 });
    db.rowsRead += n(r.sum.rowsRead);
    db.rowsWritten += n(r.sum.rowsWritten);
    db.readQueries += n(r.sum.readQueries);
    db.writeQueries += n(r.sum.writeQueries);
  }
  for (const r of list(data.d1Storage)) at(r.dimensions.date).d1StorageGb += n(r.max.databaseSizeBytes) / 1e9;
  for (const r of list(data.workers)) {
    const d = at(r.dimensions.date);
    d.workersRequests += n(r.sum.requests);
    d.workersCpuMs += n(r.sum.cpuTimeUs) / 1000;
    const s = (d.byScript[r.dimensions.scriptName || "(unnamed)"] ||= { requests: 0, cpuMs: 0, errors: 0 });
    s.requests += n(r.sum.requests);
    s.cpuMs += n(r.sum.cpuTimeUs) / 1000;
    s.errors += n(r.sum.errors);
  }
  // Pages Functions requests, kept apart: whether workersInvocationsAdaptive already counts them is checked, not assumed.
  for (const r of list(data.pages)) at(r.dimensions.date).pagesRequests += n(r.sum.requests);
  for (const r of list(data.doInvocations)) at(r.dimensions.date).doRequests += n(r.sum.requests);
  for (const r of list(data.doPeriodic)) {
    const d = at(r.dimensions.date);
    d.doGbSeconds += (n(r.sum.activeTime) / 1e6) * DO_GB;
    d.doCpuMs += n(r.sum.cpuTime) / 1000;
  }
  for (const r of list(data.r2Storage)) at(r.dimensions.date).r2StorageGb += (n(r.max.payloadSize) + n(r.max.metadataSize)) / 1e9;
  for (const r of list(data.r2Ops)) {
    const t = r.dimensions.actionType || "";
    if (FREE.test(t)) continue;
    at(r.dimensions.date)[CLASS_A.test(t) ? "r2ClassA" : "r2ClassB"] += n(r.sum.requests);
  }
  for (const r of list(data.ai)) at(r.dimensions.date).aiNeurons += n(r.sum.totalNeurons);
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * A month's estimated bill from its days: each line's total, what's beyond the included amount, and its
 * dollars. Storage lines are levels, billed on the month's average. `scale` projects a partial month
 * (days in the month / days counted). Pure.
 */
export function priceMonth(days, { scale = 1 } = {}) {
  const lines = [];
  let total = PRICES.base.monthly;
  lines.push({ key: "base", label: PRICES.base.label, used: null, billable: null, dollars: PRICES.base.monthly });
  for (const [key, p] of Object.entries(PRICES)) {
    if (key === "base") continue;
    const values = days.map((d) => n(d[key]));
    const used = p.level ? (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0) : values.reduce((a, b) => a + b, 0) * scale;
    const billable = Math.max(0, used - p.included);
    const dollars = (billable / p.per) * p.price;
    total += dollars;
    lines.push({ key, label: p.label, unit: p.unit, used, included: p.included, billable, dollars });
  }
  return { lines: lines.sort((a, b) => b.dollars - a.dollars), total };
}

/** One day's cost at the marginal rates (what that day added beyond the included amounts, spread evenly). Pure. */
export function dayCost(d) {
  let total = 0;
  for (const [key, p] of Object.entries(PRICES)) {
    if (key === "base" || p.level) continue;
    total += (n(d[key]) / p.per) * p.price;
  }
  return total;
}
