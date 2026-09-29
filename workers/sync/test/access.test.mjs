// Unit tests for the /admin Cloudflare Access check (functions/_lib/access.js),
// with a locally generated signing key standing in for Access. Run:
//   node workers/sync/test/access.test.mjs
import assert from "node:assert/strict";
import { checkAccess } from "../../../functions/_lib/access.js";

const TEAM = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
globalThis.fetch = async (url) => {
  assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }));
};
const b64 = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
async function token(claims, kid = "k1") {
  const h = b64({ alg: "RS256", kid });
  const p = b64({ aud: [AUD], iss: `https://${TEAM}`, email: "owner@example.com", exp: Date.now() / 1000 + 600, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: "owner@example.com" };
const req = (t, host = "thepillory.co") => new Request(`https://${host}/admin/review/`, t ? { headers: { "Cf-Access-Jwt-Assertion": t } } : {});
const cases = [
  ["valid token", await checkAccess(req(await token({})), env), true],
  ["no token", await checkAccess(req(null), env), false],
  ["wrong audience", await checkAccess(req(await token({ aud: ["other"] })), env), false],
  ["wrong issuer", await checkAccess(req(await token({ iss: "https://evil.cloudflareaccess.com" })), env), false],
  ["expired", await checkAccess(req(await token({ exp: Date.now() / 1000 - 10 })), env), false],
  ["email not allowed", await checkAccess(req(await token({ email: "someone@example.com" })), env), false],
  ["tampered payload", await checkAccess(req((await token({})).replace(/\.[^.]+\./, `.${b64({ aud: [AUD], iss: `https://${TEAM}`, email: "owner@example.com", exp: 9e9 })}.`)), env), false],
  ["unknown key", await checkAccess(req(await token({}, "k2")), env), false],
  ["not configured", await checkAccess(req(await token({})), {}), false],
  ["local dev flag ignored off localhost", await checkAccess(req(null), { ADMIN_LOCAL_DEV: "1" }), false],
  ["local dev flag on localhost", await checkAccess(req(null, "localhost"), { ADMIN_LOCAL_DEV: "1" }), true],
];
for (const [name, r, want] of cases) {
  assert.equal(r.ok, want, `${name}: ${JSON.stringify(r)}`);
  console.log(`ok   ${name}${r.ok ? ` (${r.email})` : ` (${r.reason})`}`);
}
console.log(`\n${cases.length} passed`);
