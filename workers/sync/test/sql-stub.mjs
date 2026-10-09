// Lets node import modules that import migrations (wrangler bundles .sql as text):
// each .sql file loads as its text. Used with node --import ./test/sql-stub.mjs.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { readFileSync } from "node:fs";
      export async function load(url, context, next) {
        if (url.endsWith(".sql")) {
          return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(readFileSync(new URL(url), "utf8")) + ";" };
        }
        return next(url, context);
      }`)
);
