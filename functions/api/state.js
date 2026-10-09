// POST /api/state: the state picker on the home page. st=XX saves that state
// in this browser (the pillory_state cookie); st empty goes back to the
// connection's approximate state. Nothing is stored on the server.
import { STATE_NAME } from "../_lib/districts.js";
import { stateCookie } from "../_lib/visitor-state.js";

export async function onRequestPost({ request }) {
  const url = new URL(request.url);
  let st = "";
  try {
    st = String((await request.formData()).get("st") || "").toUpperCase();
  } catch (_) {}
  const keep = /^[A-Z]{2}$/.test(st) && STATE_NAME[st] ? st : null;
  return new Response(null, {
    status: 303,
    headers: { Location: `${url.origin}/`, "Set-Cookie": stateCookie(keep), "Cache-Control": "no-store" },
  });
}
