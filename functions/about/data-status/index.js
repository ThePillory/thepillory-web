// /about/data-status/: each data source, what it provides, and when it last
// updated (functions/_lib/health-pages.js). No error details: those are on
// /admin/health/. The same for everyone, so kept at the edge for five minutes.
import { page, guard, edgeCached } from "../../_lib/render.js";
import { healthData, dataStatusMain } from "../../_lib/health-pages.js";

export const onRequestGet = guard((context) =>
  edgeCached(context, 300, async () => {
    const data = context.env.DB ? await healthData(context.env.DB).catch(() => null) : null;
    return page("Data status", dataStatusMain(data), { tab: "you", back: ["About", "/about/"] });
  })
);
