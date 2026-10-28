// The owner's recorded sends (§2.8, human set U1): POST /api/eval/record {input, strokes, scene, view, at} from the draw
// playground's ?record=1, kept as $RT_EVAL_HOME/human/<id>.json. The one eval endpoint the owner's dev server
// (vite.config.ts) takes; Eval HQ (plugin.ts) serves it too, beside the page where the owner writes what each meant.
import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";
import { paths } from "../loop/paths.ts";

/**
 * Whether a POST is a page of this server's own: JSON (a page elsewhere can't send that without asking first, and this
 * server never says yes) and, when the browser names its origin, this host. Any page the owner opens could otherwise
 * post a form at the PGX's address on the tailnet.
 */
export function ownPost(req: IncomingMessage): boolean {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false; // "null": a sandboxed frame or a file
  }
}

/** A recorded send's file, for an id the server made (h-<time>-<4>); undefined for anything else. */
export const sendFile = (id: string) => (/^h-[\w-]+$/.test(id) ? join(paths().human, `${id}.json`) : undefined);

/** Keeps one recorded send; its id, or why it can't. */
export function saveRecord(b: Record<string, unknown>): { id: string } | { error: string } {
  if (b.input === undefined || !b.scene) return { error: "a send needs input and scene" };
  const id = `h-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(paths().human, { recursive: true });
  writeFileSync(sendFile(id)!, JSON.stringify({ id, ...b, recordedAt: new Date().toISOString() }));
  return { id };
}

export const recordApi = (): Plugin => ({
  name: "eval-record",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/api/eval/record", (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      if (req.method !== "POST") return next();
      if (!ownPost(req)) return void ((res.statusCode = 403), res.end('{"error":"a JSON POST from this server\'s own pages only"}'));
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        let r: { id: string } | { error: string };
        try {
          r = saveRecord(JSON.parse(Buffer.concat(parts).toString("utf8")));
        } catch (err) {
          r = { error: (err as Error).message };
        }
        res.statusCode = "error" in r ? 400 : 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(r));
      });
    });
  },
});
