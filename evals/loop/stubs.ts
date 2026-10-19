// The stub table readiness answers every model call from (spec §7.5): canned
// resolver, drawing and picture replies for the bridge pages, and canned driver,
// judge and expectation replies for the eval roles on the fake API, from
// evals/checks/data/stub-replies/. So readiness makes 0 model calls.
//
// A Jev call (a tuning with resolve.engine or draw.thinkRouter on) gets every question
// at 0.1, as the fake API's Jev would.
//
// The pages' stubs sit where the gateway would: each arm server proxies /api/model
// here (chrome.ts adds the x-rt-* labels, as in a run), so readiness also exercises
// the arm proxy and the labels, and every request is counted per arm.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJev } from "../../dev/jev.ts";
import { readPicture } from "../../src/core/picture.ts";
import type { Scene } from "../../src/core/scene.ts";
import { type Pictures, pictureKey } from "../fixtures/fixtures.ts";

const DIR = fileURLToPath(new URL("../checks/data/stub-replies/", import.meta.url));
/** Each role's canned reply (draw-refs is the product's resolver call). */
const FILES = { "draw-refs": "resolver.txt", draw: "draw.txt", picture: "picture.txt", driver: "driver.json", judge: "judge.json", expectation: "expectation.json" } as const;
export type StubRole = keyof typeof FILES;
export const stubReply = (role: StubRole) => readFileSync(join(DIR, FILES[role]), "utf8");

/** The drawing model answers this late, so readiness can tell TTFC is counted from Enter (TTFC > it). It is the one
 * call every send makes: with resolve.engine 1 no resolver call comes first. */
export const DRAW_DELAY_MS = 150;
/** The canned doodle's own w × h space. */
const DOODLE = 100;

/** Every drawing in `scene` filled with the canned doodle, so the before-scene needs no picture call (no bake needed). */
export function stubPictures(scene: Scene): Pictures {
  const els = readPicture(stubReply("picture"), "stub", DOODLE, DOODLE).els;
  return Object.fromEntries(scene.stacked().filter((s) => s.drawing).map((s) => [pictureKey(s), { w: DOODLE, h: DOODLE, els }]));
}

/** The fake API's --replies files for these roles: each role's canned reply keyed by its system prompt (fake-api.ts). */
export function fakeApiReplies(dir: string, systems: Partial<Record<StubRole, string>>) {
  mkdirSync(dir, { recursive: true });
  for (const [role, system] of Object.entries(systems)) {
    const sha12 = createHash("sha256").update(system!).digest("hex").slice(0, 12);
    writeFileSync(join(dir, `${role}.${sha12}.txt`), stubReply(role as StubRole)); // .json there means "a list of replies"
  }
}

const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * A stand-in gateway for the arm servers: /api/model answered the way dev/model-plugin.ts streams
 * (NDJSON text lines, then the stats line), counted per arm (x-rt-arm) and role. Anything else, or a
 * request without labels, is refused and listed in `unexpected`.
 */
export async function serveStubs() {
  const counts: Record<string, Record<string, number>> = {};
  const unexpected: string[] = [];
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const arm = req.headers["x-rt-arm"] as string | undefined;
    const b = JSON.parse((await body(req)) || "{}") as { model?: string; user?: string; from?: string };
    const role = b.user === undefined ? "warm" : (b.from ?? "?");
    const jev = isJev(b.model) && role !== "warm";
    if (path !== "/api/model" || !arm || (role !== "warm" && !jev && !(role in FILES))) {
      unexpected.push(`${req.method} ${path} from ${role} (arm ${arm ?? "unlabelled"})`);
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not stubbed" }));
    }
    (counts[arm] ??= {})[role] = (counts[arm][role] ?? 0) + 1;
    if (role === "warm") return res.end(JSON.stringify({ warming: 0 }));
    res.setHeader("content-type", "application/x-ndjson");
    if (jev) {
      const ids = Object.keys((JSON.parse(b.user!) as { questions?: object }).questions ?? {});
      res.write(`${JSON.stringify({ text: JSON.stringify(Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.1 }]))) })}\n`);
      return res.end(`${JSON.stringify({ done: true, model: b.model, ms: 1 })}\n`);
    }
    if (role === "draw") await new Promise((r) => setTimeout(r, DRAW_DELAY_MS));
    for (const line of stubReply(role as StubRole).split(/(?<=\n)/)) res.write(`${JSON.stringify({ text: line })}\n`);
    res.end(`${JSON.stringify({ done: true, model: b.model, ms: 1 })}\n`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    counts,
    unexpected,
    /** Requests answered for this arm: one role, or all of them. */
    count: (arm: string, role?: string) => Object.entries(counts[arm] ?? {}).reduce((n, [k, v]) => n + (!role || k === role ? v : 0), 0),
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}
export type Stubs = Awaited<ReturnType<typeof serveStubs>>;
