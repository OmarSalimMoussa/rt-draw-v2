// Tests only: no plugins, so the dev server's API (model calls, Scribe tokens) never runs under them.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "happy-dom", include: ["src/**/*.test.ts", "server/**/*.test.ts"] },
});
