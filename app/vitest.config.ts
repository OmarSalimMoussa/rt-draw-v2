// Tests only: no plugins, so the dev server's API (model calls, Scribe tokens) never runs under them.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // v2's core sits beside the app (its board shots embed the font, src/fonts).
  server: { fs: { allow: [resolve(import.meta.dirname, "..")] } },
  test: { environment: "happy-dom", include: ["src/**/*.test.ts", "src/**/*.test.tsx", "server/**/*.test.ts"] },
});
