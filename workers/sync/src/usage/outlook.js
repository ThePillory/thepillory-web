// The month so far, its projection, and what jumped: pure, shared by the sync's
// usage-check step (src/usage/sync.js) and /admin/usage/ (functions/_lib/usage-pages.js).
// Tested in test/usage.test.mjs.
import { priceMonth, dayCost, PRICES } from "./cloudflare.js";

export const SPIKE = 3; // a day more than this many times the 7-day average
const MIN_SPIKE_DOLLARS = 1; // and at least this much, so a quiet week's cents don't alert

/** The month so far and projected to its end, from daily rows (`usage_daily` or our own counts). Pure. */
export function monthOutlook(days, today) {
  const month = today.slice(0, 7);
  const mDays = days.filter((d) => d.day.startsWith(month) && d.day <= today);
  const [y, m] = month.split("-").map(Number);
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const counted = Math.max(1, Number(today.slice(8, 10)));
  return { month, inMonth, counted, soFar: priceMonth(mDays), projected: priceMonth(mDays, { scale: inMonth / counted }) };
}

/**
 * What jumped: each priced line on `day` against its average over the 7 days before. Lines up at
 * least SPIKE times (and worth at least a dollar a day at the marginal rate). Pure.
 */
export function jumps(days, day) {
  const i = days.findIndex((d) => d.day === day);
  if (i < 1) return [];
  const before = days.slice(Math.max(0, i - 7), i);
  const out = [];
  for (const [key, p] of Object.entries(PRICES)) {
    if (key === "base" || p.level) continue;
    const today = Number(days[i][key]) || 0;
    const avg = before.reduce((a, d) => a + (Number(d[key]) || 0), 0) / before.length;
    const dollars = (today / p.per) * p.price;
    if (today > SPIKE * avg && dollars >= MIN_SPIKE_DOLLARS) out.push({ key, label: p.label, today, avg, dollars });
  }
  return out.sort((a, b) => b.dollars - a.dollars);
}

/** The alert's decision for the latest complete day: why to send, or null. Pure. */
export function alertReasons(days, today, limit) {
  const reasons = [];
  const outlook = monthOutlook(days, today);
  if (outlook.projected.total > limit) reasons.push(`The month is projected at $${outlook.projected.total.toFixed(2)}, over the $${limit} alert line ($${outlook.soFar.total.toFixed(2)} so far, ${outlook.counted} of ${outlook.inMonth} days).`);
  const latest = [...days].filter((d) => d.day < today).pop();
  if (latest) {
    const i = days.indexOf(latest);
    const before = days.slice(Math.max(0, i - 7), i);
    const avg = before.length ? before.reduce((a, d) => a + dayCost(d), 0) / before.length : 0;
    const cost = dayCost(latest);
    if (before.length && cost > SPIKE * avg && cost >= MIN_SPIKE_DOLLARS) reasons.push(`${latest.day} cost about $${cost.toFixed(2)}, more than ${SPIKE} times the 7 days before (about $${avg.toFixed(2)} a day).`);
  }
  return { reasons, outlook, latest };
}

