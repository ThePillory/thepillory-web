// Open States v3 API base and headers, and the daily reserve for state officials.
// https://docs.openstates.org/api-v3/
import { getState } from "./util.js";
export const API = "https://v3.openstates.org";

export function headers(env) {
  if (!env.OPENSTATES_API_KEY) throw new Error("OPENSTATES_API_KEY secret is not set");
  return { "X-API-KEY": env.OPENSTATES_API_KEY, Accept: "application/json" };
}

/**
 * Open States requests the other Open States steps (state votes, hearings)
 * leave untouched each day, so the legislators load before the votes backfill
 * uses up the daily limit: OPENSTATES_OFFICIALS_RESERVE (10; a full load takes
 * about 4) while the weekly load of every legislator is due, else 0.
 */
export async function openStatesReserve(env, db) {
  const loadedAll = await getState(db, "state_officials_all");
  if (loadedAll && (Date.now() - Date.parse(loadedAll)) / 86400000 < 7) return 0;
  return parseInt(env.OPENSTATES_OFFICIALS_RESERVE || "10", 10);
}

