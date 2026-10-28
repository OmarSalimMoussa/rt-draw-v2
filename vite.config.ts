import { resolve } from "node:path";
import { defineConfig } from "vite";
import { modelApi } from "./dev/model-plugin.ts";
import { ttsApi } from "./dev/tts-plugin.ts";
import { recordApi } from "./evals/pages/record.ts";
import { sttToken } from "./playgrounds/speech/token-plugin.ts";

const pages = ["render", "ops", "ink", "hittest", "marks", "speech", "link", "shot", "coords", "tidy", "describe", "resolve", "draw", "picture", "router", "board", "camera", "course", "course-imagine", "course-flow"];

export default defineConfig({
  // The eval's one endpoint here: the draw playground's ?record=1 sends. Eval HQ is the PGX's (evals/pages.vite.config.ts).
  plugins: [sttToken(), modelApi(), ttsApi(), recordApi()],
  build: {
    rollupOptions: {
      input: Object.fromEntries([["index", resolve(import.meta.dirname, "index.html")], ...pages.map((p) => [p, resolve(import.meta.dirname, `playgrounds/${p}/index.html`)]), ...["driver", "bridge"].map((p) => [`evals-${p}`, resolve(import.meta.dirname, `evals/${p}/index.html`)])]),
    },
  },
});
