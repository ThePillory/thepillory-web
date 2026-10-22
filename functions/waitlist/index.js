// /waitlist/: "Bring ThePillory to your county". The live communities and the
// waitlist form (functions/_lib/waitlist.js; POST /api/waitlist comes back here
// with ?waitlist=<result>). ?state=XX picks the state in the form.
import { page, loadSection, FAILED, guard } from "../_lib/render.js";
import { STATE_NAME } from "../_lib/districts.js";
import { waitlistCounts } from "../_lib/hub.js";
import { communities, WAITLIST_MESSAGES } from "../_lib/waitlist.js";

export const onRequestGet = guard(async ({ request, env }) => {
  const url = new URL(request.url);
  const st = String(url.searchParams.get("state") || "").toUpperCase();
  const joined = url.searchParams.get("waitlist");
  const counts = env.DB ? await loadSection("waitlist counts", () => waitlistCounts(env.DB), null) : null;
  const main = `
<header class="page-head stack-xs">
  <h1>Bring ThePillory to your county</h1>
  <p class="subtitle">County meetings, agendas and local officials open one community at a time.</p>
</header>
${communities(env, counts === FAILED ? null : counts, joined === "joined" ? WAITLIST_MESSAGES.joined : "", joined && joined !== "joined" ? WAITLIST_MESSAGES[joined] || "" : "", STATE_NAME[st] ? st : "")}`;
  return page("Bring ThePillory to your county", main, { tab: "you", back: ["You", "/you/"], partial: counts === FAILED });
}, { tab: "you" });
