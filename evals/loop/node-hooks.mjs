// Lets node import the product's Vite-style `?raw` and `?url` imports (spec F30):
// shot.ts takes its font with `?url`, so without this board.ts and draw.ts can't
// load in node. Every node entry and check runs as
//   node --import ./evals/loop/node-hooks.mjs <file>
// `?raw` gives the file's text, `?url` its file: URL. In-thread hooks (registerHooks),
// so there's no loader thread or code-in-a-string to keep in sync.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const QUERY = /^(.*)\?(raw|url)$/;

registerHooks({
  resolve(specifier, context, next) {
    const m = QUERY.exec(specifier);
    if (!m) return next(specifier, context);
    return { url: `${next(m[1], context).url}?${m[2]}`, format: "module", shortCircuit: true };
  },
  load(url, context, next) {
    const m = QUERY.exec(url);
    if (!m || !m[1].startsWith("file:")) return next(url, context);
    const value = m[2] === "raw" ? readFileSync(new URL(m[1]), "utf8") : m[1];
    return { format: "module", source: `export default ${JSON.stringify(value)};`, shortCircuit: true };
  },
});
