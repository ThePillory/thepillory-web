// Cloudflare Access check for /admin. Access blocks anyone who isn't on the
// allow list before a request reaches the site; this verifies the signed token
// Access adds, so /admin also stays shut if the Access application is ever
// removed or misconfigured. Fails closed: without ACCESS_TEAM_DOMAIN and
// ACCESS_AUD set on the Pages project, /admin refuses every request.
//
//   ACCESS_TEAM_DOMAIN  e.g. "yourteam.cloudflareaccess.com"
//   ACCESS_AUD          the Access application's "Application Audience (AUD) Tag"
//   ADMIN_EMAILS        optional second check: comma-separated emails allowed in

let certs = { at: 0, keys: [], team: "" };

function b64url(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function cookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function keysFor(team) {
  if (certs.team === team && Date.now() - certs.at < 60 * 60 * 1000) return certs.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  certs = { at: Date.now(), keys: (await res.json()).keys || [], team };
  return certs.keys;
}

/**
 * Returns {ok: true, email} or {ok: false, status, reason}.
 */
export async function checkAccess(request, env) {
  const url = new URL(request.url);
  if (env.ADMIN_LOCAL_DEV === "1" && ["localhost", "127.0.0.1"].includes(url.hostname)) {
    return { ok: true, email: "local-test@localhost" };
  }
  const team = String(env.ACCESS_TEAM_DOMAIN || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const aud = env.ACCESS_AUD;
  if (!team || !aud) return { ok: false, status: 503, reason: "not-configured" };

  const token = request.headers.get("Cf-Access-Jwt-Assertion") || cookie(request, "CF_Authorization");
  if (!token) return { ok: false, status: 403, reason: "no-token" };
  try {
    const [h, p, sig] = token.split(".");
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
    if (header.alg !== "RS256") return { ok: false, status: 403, reason: "bad-token" };
    const jwk = (await keysFor(team)).find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, status: 403, reason: "bad-token" };
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const now = Date.now() / 1000;
    if (!valid || !auds.includes(aud) || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60) || payload.iss !== `https://${team}`) {
      return { ok: false, status: 403, reason: "bad-token" };
    }
    const email = String(payload.email || "").toLowerCase();
    const allowed = String(env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!email || (allowed.length && !allowed.includes(email))) return { ok: false, status: 403, reason: "not-allowed" };
    return { ok: true, email };
  } catch (_) {
    return { ok: false, status: 403, reason: "bad-token" };
  }
}
