// The harness pages server: the progress and labeling pages with their endpoints
// and nothing else (no model, TTS or STT plugin), for the PGX over Tailscale:
//   ./node_modules/.bin/vite --config evals/pages.vite.config.ts --host "$(tailscale ip -4)" --port 5181
import { resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";
import { evalPages } from "./pages/plugin.ts";

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

export default defineConfig({
  root: resolve(import.meta.dirname, ".."),
  // A folder with no .env: this server never loads the owner's keys.
  envDir: resolve(import.meta.dirname, "pages"),
  plugins: [evalPages(), noVoice],
  // Opened by the PGX's name over Tailscale, which Vite's host check would refuse.
  server: { port: 5181, strictPort: true, allowedHosts: ["thinkstationpgx-0eea", ".ts.net"] },
});
