import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";

const pages = ["render", "ops", "ink", "hittest", "marks", "arrow"];

const readBody = async (req: IncomingMessage) => {
  let s = "";
  for await (const c of req) s += c;
  if (s.length > 200_000) throw new Error("body too big");
  return JSON.parse(s);
};

/**
 * POST /api/jev: forwards one TypeSafe Jev request. The key stays here, never in the
 * browser.
 */
function jev(): Plugin {
  return {
    name: "jev",
    apply: "serve",
    configureServer(server) {
      const env = resolve(server.config.root, ".env");
      if (existsSync(env)) process.loadEnvFile(env);
      server.middlewares.use("/api/jev", async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return send(405, { error: "POST only" });
        const key = process.env.TYPESAFE_API_KEY;
        if (!key) return send(503, { error: "set TYPESAFE_API_KEY in .env" });
        try {
          const { state, questions } = await readBody(req);
          if (typeof state !== "string" || state.length > 20_000 || typeof questions !== "object") return send(400, { error: "send { state, questions }" });
          const t0 = performance.now();
          const r = await fetch("https://api.typesafe.ai/v1/systemone", {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "jev-latest", state, questions }),
          });
          const body = await r.json();
          send(r.status, { ...body, ms: Math.round(performance.now() - t0) });
        } catch (e) {
          send(502, { error: (e as Error).message });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [jev()],
  build: {
    rollupOptions: {
      input: Object.fromEntries([["index", resolve(import.meta.dirname, "index.html")], ...pages.map((p) => [p, resolve(import.meta.dirname, `playgrounds/${p}/index.html`)])]),
    },
  },
});
