// The hosted app (main.ts, the Dockerfile): the built page and the dev server's API on
// one port. The API is the dev server's own plugins (Claude on the subscription and
// Jev, Scribe tokens, the projects), given a bare middleware stack in place of Vite's;
// their keys come from the environment, which loadEnv reads as well as a .env.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { modelApi } from "../../dev/model-plugin.ts";
import { sttToken } from "../../playgrounds/speech/token-plugin.ts";
import { json } from "./http.ts";
import { projectsApi } from "./plugin.ts";

type Next = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => unknown;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

/** The app's server: `dist` is the built page, `root` where loadEnv looks for a .env. */
export function host(dist: string, root: string, plugins: Plugin[] = [modelApi(), sttToken(), projectsApi()]): Server {
  const stack: { path: string; fn: Middleware }[] = [];
  const middlewares = { use: (path: string | Middleware, fn?: Middleware) => stack.push(typeof path === "string" ? { path, fn: fn! } : { path: "", fn: path }) };
  for (const p of plugins) {
    (p.configResolved as ((c: Partial<ResolvedConfig>) => void) | undefined)?.({ mode: "production", root });
    (p.configureServer as ((s: ViteDevServer) => void) | undefined)?.({ middlewares } as unknown as ViteDevServer);
  }

  const fail = (res: ServerResponse, err: unknown) => {
    console.error(err);
    if (res.headersSent) res.end();
    else json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  };
  // As Connect runs them: in order, a path-mounted one only under its path, each passing on with next().
  const run = (req: IncomingMessage, res: ServerResponse, from: number): unknown => {
    const url = req.url ?? "/";
    for (let i = from; i < stack.length; i++) {
      const { path, fn } = stack[i];
      if (path && url !== path && !url.startsWith(`${path}/`) && !url.startsWith(`${path}?`)) continue;
      return Promise.resolve(fn(req, res, (err) => (err ? fail(res, err) : run(req, res, i + 1)))).catch((err) => fail(res, err));
    }
    return page(req, res);
  };

  const page = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path.startsWith("/api/")) return json(res, 404, { error: "no such route" });
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "GET only" });
    let file: string;
    try {
      file = resolve(dist, `.${decodeURIComponent(path)}`);
    } catch {
      return json(res, 404, { error: "not found" });
    }
    if (file !== dist && !file.startsWith(dist + sep)) return json(res, 404, { error: "not found" });
    const found = await stat(file).then((s) => s.isFile(), () => false);
    // Any other path without a file extension is one of the app's own (the editor, /projects): the page.
    if (!found && extname(path)) return json(res, 404, { error: "not found" });
    const send = found ? file : resolve(dist, "index.html");
    res.setHeader("Content-Type", TYPES[extname(send)] ?? "application/octet-stream");
    // Built files are named by their content, so they never change; the page names the current ones.
    res.setHeader("Cache-Control", found && path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    if (req.method === "HEAD") return res.end();
    createReadStream(send).on("error", (err) => fail(res, err)).pipe(res);
  };

  return createServer((req, res) => void run(req, res, 0));
}
