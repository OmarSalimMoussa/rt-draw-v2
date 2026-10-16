import { resolve } from "node:path";
import { defineConfig } from "vite";
import { modelApi } from "./dev/model-plugin.ts";
import { ttsApi } from "./dev/tts-plugin.ts";
import { sttToken } from "./playgrounds/speech/token-plugin.ts";

const pages = ["render", "ops", "ink", "hittest", "marks", "speech", "link", "shot", "coords", "tidy", "describe", "resolve", "draw", "picture", "router"];

export default defineConfig({
  plugins: [sttToken(), modelApi(), ttsApi()],
  build: {
    rollupOptions: {
      input: Object.fromEntries([["index", resolve(import.meta.dirname, "index.html")], ...pages.map((p) => [p, resolve(import.meta.dirname, `playgrounds/${p}/index.html`)]), ["evals-driver", resolve(import.meta.dirname, "evals/driver/index.html")]]),
    },
  },
});
