// Every state's page is /states/<name>/ ("washington", "new-york",
// "district-of-columbia", "puerto-rico"): the home page's template filled with
// that state (functions/_lib/home.js). Pure; tested in workers/sync/test/state-template.test.mjs.
import { STATE_NAME } from "./districts.js";

/** "New York" → "new-york". */
export const stateSlug = (st) => String(STATE_NAME[st] || st).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const BY_SLUG = Object.fromEntries(Object.keys(STATE_NAME).map((st) => [stateSlug(st), st]));

/** "new-york" → "NY"; also accepts a two-letter code ("ny"). Null when it isn't a state. */
export function stateFromSlug(slug) {
  const s = String(slug || "").toLowerCase();
  if (BY_SLUG[s]) return BY_SLUG[s];
  const st = s.toUpperCase();
  return /^[A-Z]{2}$/.test(st) && STATE_NAME[st] ? st : null;
}

/** The state's page: "/states/washington/". */
export const statePath = (st) => `/states/${stateSlug(st)}/`;
