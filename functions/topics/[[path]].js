// /topics/ and /topics/<topic>/ (functions/_lib/topic-pages.js). The same for
// every visitor: kept at the edge for a few minutes.
import { guard, edgeCached, notFound } from "../_lib/render.js";
import { topicsIndex, topicPage } from "../_lib/topic-pages.js";
import { TOPIC } from "../_lib/topics.js";
import { pickYear } from "../_lib/history.js";
import { topicPastYear } from "../_lib/history-pages.js";

const TOPIC_CACHE_SECONDS = 300;

export const onRequestGet = guard(async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const [slug, extra] = (params.path || []).filter(Boolean).map((s) => s.toLowerCase());
  if (extra) return notFound("No page at this address.", "laws", ["Topics", "/topics/"]);
  // The Time Machine: ?year= shows the topic as it was that year.
  const year = slug && TOPIC[slug] ? pickYear(url) : null;
  return edgeCached(context, TOPIC_CACHE_SECONDS, () => (year ? topicPastYear(env, url, slug, year) : slug ? topicPage(env, slug, url) : topicsIndex(env)));
}, { tab: "laws" });
