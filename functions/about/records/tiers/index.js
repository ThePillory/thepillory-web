// The evidence tiers page of the Public Records & Investigations tab (functions/_lib/records.js,
// docs/records-tab-spec.md). Hidden ("not found") unless RECORDS_TAB is "on".
import { page, guard, notFound } from "../../../_lib/render.js";
import { recordsOn, tiersMain } from "../../../_lib/records.js";

export const onRequestGet = guard((context) => {
  if (!recordsOn(context.env)) return notFound("No page at this address.", "you", ["About", "/about/"]);
  return page("Evidence tiers", tiersMain(), { tab: "you", back: ["About", "/about/"] });
});
