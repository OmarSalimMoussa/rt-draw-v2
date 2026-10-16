// The Vite config every arm server runs with (spec §7.2, fix F11). It never imports the
// tree's vite.config.ts or dev/: an arm gets no product plugins, so its only model
// route is /api/model through the gateway, it loads no .env, and voice is refused.
// That is also why the optimizer may not edit those paths (§8.4): there an edit would
// silently do nothing.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { InlineConfig, Plugin } from "vite";

/** No voice in an eval (no ElevenLabs TTS, no Scribe token): those endpoints answer 403 on every arm server. */
export const denyVoice = (): Plugin => ({
  name: "rt-eval-deny-voice",
  configureServer(server) {
    // Added here, before Vite's own middlewares, so nothing else ever sees these requests.
    server.middlewares.use((req, res, next) => {
      if (!/^\/api\/(tts|stt-token)([/?]|$)/.test(req.url ?? "")) return next();
      res.statusCode = 403;
      res.end("voice is off in evals\n");
    });
  },
});

/** Serves `tree` on 127.0.0.1:<port>, streaming /api/model to `gateway` (e.g. http://127.0.0.1:5290). */
export function armConfig(tree: string, gateway: string, port: number): InlineConfig {
  // Kept inside the tree (node_modules is hard-linked, never written), one cache per port: two arms may serve one tree.
  const cacheDir = join(tree, ".vite", String(port));
  const envDir = join(tree, ".vite", "no-env");
  mkdirSync(envDir, { recursive: true });
  return {
    configFile: false,
    root: tree,
    envDir,
    cacheDir,
    appType: "mpa", // an unknown path is a 404, not some page's HTML
    logLevel: "warn",
    clearScreen: false,
    plugins: [denyVoice()],
    server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false, proxy: { "/api/model": { target: gateway } } },
  };
}
