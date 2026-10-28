// Eval HQ's server (evals/progress/hq.ts): its pages with their endpoints and nothing else (no model, TTS or STT
// plugin), on the PGX over Tailscale only, since it serves testers' cards (rt-pages.service, evals/ops/units.sh):
//   ./node_modules/.bin/vite --config evals/pages.vite.config.ts --host "$(tailscale ip -4)" --port 5181
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Plugin, defineConfig } from "vite";
// The plugin's code reaches the product's `?url` and `?raw` imports (the board's font), which Vite's config bundler
// can't load: node-hooks.mjs teaches node them, and the plugin is imported at run time, by a path the bundler leaves.
import "./loop/node-hooks.mjs";

const { evalPages }: typeof import("./pages/plugin.ts") = await import(pathToFileURL(join(import.meta.dirname, "pages/plugin.ts")).href);

/** Voice is never part of the eval: a server the harness starts answers 403. */
const noVoice: Plugin = {
  name: "no-voice",
  configureServer(server) {
    for (const path of ["/api/tts", "/api/stt-token"])
      server.middlewares.use(path, (_req, res) => {
        res.statusCode = 403;
        res.end("voice is off on the eval pages server");
      });
  },
};

/** Its front page is Eval HQ: the repo's own index is the playgrounds', which need the dev server's model API. */
const hq: Plugin = {
  name: "eval-hq-home",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/" && req.url !== "/index.html") return next();
      res.statusCode = 302;
      res.setHeader("location", "/evals/progress/");
      res.end();
    });
  },
};

const root = resolve(import.meta.dirname, "..");
export default defineConfig({
  root,
  // A folder with no .env: this server never loads the owner's keys.
  envDir: resolve(import.meta.dirname, "pages"),
  plugins: [hq, evalPages(root), noVoice],
  // Opened by this machine's name over Tailscale (MagicDNS), which Vite's host check would refuse.
  server: { port: 5181, strictPort: true, allowedHosts: [hostname(), ".ts.net"] },
});
