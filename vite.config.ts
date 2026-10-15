import { resolve } from "node:path";
import { defineConfig } from "vite";

const pages = ["render", "ops", "ink", "hittest", "marks"];

export default defineConfig({
  build: {
    rollupOptions: {
      input: Object.fromEntries([["index", resolve(import.meta.dirname, "index.html")], ...pages.map((p) => [p, resolve(import.meta.dirname, `playgrounds/${p}/index.html`)])]),
    },
  },
});
