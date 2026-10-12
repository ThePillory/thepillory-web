// /saved/<hash>.<ext>: ThePillory's own copy of a source document (financial
// disclosures, trade reports, agendas, earmark tables, travel reports), kept in
// the R2 bucket bound as SOURCES by the sync's source-copies step
// (workers/sync/src/health/sync.js). Linked as "Saved copy" when the original
// is gone. Served exactly as downloaded, with its source and download date.
import { notFound, guard } from "../_lib/render.js";

export const onRequestGet = guard(async (context) => {
  const name = (context.params.path || []).join("/");
  if (!/^[0-9a-f]{64}(\.[a-z]{2,4})?$/.test(name) || !context.env.SOURCES) return notFound("No saved copy at this address.", null, null);
  const obj = await context.env.SOURCES.get(`sources/${name}`);
  if (!obj) return notFound("No saved copy at this address.", null, null);
  const meta = obj.customMetadata || {};
  const headers = new Headers();
  headers.set("Content-Type", (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("X-Robots-Tag", "noindex");
  // HTML or scripts from another site are never run on this one.
  headers.set("Content-Security-Policy", "sandbox");
  if (meta.source_url) headers.set("Link", `<${meta.source_url}>; rel="canonical"`);
  if (meta.downloaded_at) headers.set("X-Saved-At", meta.downloaded_at);
  return new Response(obj.body, { headers });
});
