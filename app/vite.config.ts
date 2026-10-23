// The rt-draw app: v1's UI on v2's engine, served on its own port beside the
// playgrounds. The API is v2's dev-server plugins (Claude on the subscription and
// Jev, Scribe tokens) plus v1's projects, all reading the repo's .env and .data.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { type PluginOption, defineConfig } from "vite";
import { modelApi } from "../dev/model-plugin.ts";
import { sttToken } from "../playgrounds/speech/token-plugin.ts";
import { projectsApi } from "./server/plugin.ts";

const repo = resolve(import.meta.dirname, "..");
// v2's plugins read their keys through Vite's loadEnv, which includes process.env: the repo's .env, loaded here
// (a build, as in the Dockerfile, has none and needs none).
if (existsSync(join(repo, ".env"))) process.loadEnvFile(join(repo, ".env"));
process.env.RT_DATA_DIR ||= join(repo, ".data");

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), modelApi() as PluginOption, sttToken() as PluginOption, projectsApi()],
  server: { port: 5180, strictPort: true, fs: { allow: [repo] }, watch: { ignored: ["**/.data/**"] } },
});
