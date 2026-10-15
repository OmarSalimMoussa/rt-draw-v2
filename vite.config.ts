import { resolve } from "node:path";
import { defineConfig } from "vite";
import { sttToken } from "./playgrounds/speech/token-plugin.ts";

const pages = ["render", "ops", "ink", "hittest", "marks", "speech", "link", "shot", "coords", "tidy"];

export default defineConfig({
  plugins: [sttToken()],
  build: {
    rollupOptions: {
      input: Object.fromEntries([["index", resolve(import.meta.dirname, "index.html")], ...pages.map((p) => [p, resolve(import.meta.dirname, `playgrounds/${p}/index.html`)])]),
    },
  },
});
