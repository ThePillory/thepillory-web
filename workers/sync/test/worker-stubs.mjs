// Lets node import Worker modules: .sql files load as their text (as wrangler
// bundles them), and cloudflare:email is a stand-in whose EmailMessage keeps
// what it was given. Used with node --import ./test/worker-stubs.mjs.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { readFileSync } from "node:fs";
      const EMAIL = "export class EmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }";
      export async function resolve(specifier, context, next) {
        if (specifier === "cloudflare:email") return { url: "data:text/javascript," + encodeURIComponent(EMAIL), shortCircuit: true };
        return next(specifier, context);
      }
      export async function load(url, context, next) {
        if (url.endsWith(".sql")) {
          return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(readFileSync(new URL(url), "utf8")) + ";" };
        }
        return next(url, context);
      }`)
);
