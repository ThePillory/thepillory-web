// /api/search-officials: adds current officials, recently voted bills and
// meetings from D1 to the global search index (the static part, governing
// bodies and the Constitution, is assets/search-index.js).
import { safe } from "../_lib/data.js";

export async function onRequestGet(context) {
  const items =
    (await safe(context.env, async (db) => {
      const officials = (await db.prepare("SELECT slug, name, office, district FROM officials WHERE active = 1").all()).results;
      const bills = (
        await db.prepare(
          `SELECT b.id, b.bill_number, b.title, b.level FROM bills b
           WHERE EXISTS (SELECT 1 FROM votes v WHERE v.bill_id = b.id)
           ORDER BY b.updated_at DESC LIMIT 500`
        ).all()
      ).results;
      const meetings = (
        await db
          .prepare(
            `SELECT id, body, meeting_type, starts_at, level FROM meetings
             WHERE status != 'cancelled' AND starts_at >= date('now', '-60 days') ORDER BY starts_at LIMIT 200`
          )
          .all()
          .catch(() => ({ results: [] }))
      ).results;
      return [
        ...meetings.map((m) => ({
          type: "Meeting",
          title: `${m.body}: ${m.meeting_type || "Meeting"}`,
          sub: `${m.level === "state" ? "State" : "County"} · ${m.starts_at.slice(0, 10)}`,
          url: `/meetings/${encodeURIComponent(m.id)}/`,
          k: "meeting agenda hearing",
        })),
        ...officials.map((o) => ({
          type: "Rep",
          title: o.name,
          sub: [o.office, o.district].filter(Boolean).join(" · "),
          url: `/reps/${o.slug}/`,
          k: "official representative",
        })),
        ...bills.map((b) => ({
          type: "Bill",
          title: `${b.bill_number}: ${b.title}`,
          sub: b.level === "federal" ? "Federal" : "State",
          url: `/laws/bills/${encodeURIComponent(b.id)}/`,
          k: "bill law",
        })),
      ];
    })) || [];
  const js = `window.PILLORY_INDEX = (window.PILLORY_INDEX || []).concat(${JSON.stringify(items)});\n`;
  return new Response(js, {
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=600" },
  });
}
