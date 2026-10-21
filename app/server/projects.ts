// Projects, kept on the server: nothing of a person's work stays in their browser.
// Until there are accounts, each browser gets an anonymous owner id in an HttpOnly
// cookie (page scripts can't read it), and its projects live in <RT_DATA_DIR>/app/owners/<owner>/:
// index.json (names, sizes, dates) and <project>.ndjson, one version per line,
// only ever appended. Writes for one owner run one at a time. Copied from rt-draw v1
// (server/projects.ts); only where the data lives changed. A version's doc is a v2
// board (Scene.toJSON()), which this file never looks inside.
//   GET  /api/projects                  -> { projects: [meta + latest doc] }, most recent first
//   GET  /api/project?id=               -> { versions } the newest VERSIONS_SENT
//   POST /api/project/save   { id, versions, meta }  -> { versions } (creates the project; renumbers clashing versions)
//   POST /api/project/rename { id, name }
//   POST /api/project/delete { id }
//   POST /api/projects/reset            (dev only) deletes all of this browser's projects
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError, type Router, json, readJson } from "./http.ts";

/** The repo: <repo>/.data is RT_DATA_DIR's default, as for v2's model call log. */
const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** Read per request, so a check can point RT_DATA_DIR elsewhere before it starts. */
const data = () => join(process.env.RT_DATA_DIR || join(REPO, ".data"), "app", "owners");
const COOKIE = "rt_owner";
const YEAR_S = 365 * 24 * 3600;
const OWNER = /^[a-f0-9]{32}$/;
const PROJECT = /^[a-z0-9]{6,16}$/;
/** The newest versions a browser gets; older ones stay on the server. */
const VERSIONS_SENT = 200;

type Version = { n: number; doc: unknown; at: number; label: string; undoOf?: number };
type Meta = { id: string; name: string; named?: boolean; createdAt: number; updatedAt: number; pages: number; versions: number };

/** The browser's owner id, from its cookie; a new one, and the cookie, the first time. */
export function ownerOf(req: IncomingMessage, res?: ServerResponse): string | undefined {
  const found = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{32})`).exec(req.headers.cookie ?? "")?.[1];
  if (found && OWNER.test(found)) return found;
  if (!res) return;
  const id = randomBytes(16).toString("hex");
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${YEAR_S}${secure}`);
  return id;
}

/** One owner's writes, one at a time (kept on globalThis: this module is evaluated afresh after edits). */
const g = globalThis as typeof globalThis & { __rtProjectQueues?: Map<string, Promise<unknown>> };
const queues = (g.__rtProjectQueues ??= new Map());
function serial<T>(owner: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(owner) ?? Promise.resolve()).catch(() => {}).then(job);
  queues.set(owner, run);
  return run;
}

const dir = (owner: string) => join(data(), owner);
const file = (owner: string, id: string) => join(dir(owner), `${id}.ndjson`);

async function readIndex(owner: string): Promise<Meta[]> {
  try {
    return JSON.parse(await readFile(join(dir(owner), "index.json"), "utf8")) as Meta[];
  } catch {
    return []; // a new owner
  }
}

/** Written to a temporary file and renamed into place, so a crash never leaves half an index. */
async function writeIndex(owner: string, metas: Meta[]) {
  await mkdir(dir(owner), { recursive: true });
  const tmp = join(dir(owner), `.index.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify(metas));
  await rename(tmp, join(dir(owner), "index.json"));
}

/** A project's versions in order; a line torn by a crash is skipped. */
async function readVersions(owner: string, id: string): Promise<Version[]> {
  let text = "";
  try {
    text = await readFile(file(owner, id), "utf8");
  } catch {
    return [];
  }
  const out: Version[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Version);
    } catch {
      // torn line
    }
  }
  return out;
}

const isVersion = (v: Partial<Version>) => typeof v === "object" && v !== null && Number.isInteger(v.n) && typeof v.at === "number" && typeof v.label === "string" && typeof v.doc === "object";

async function body<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  try {
    return await readJson<T>(req);
  } catch (err) {
    json(res, err instanceof HttpError ? err.status : 400, { error: err instanceof Error ? err.message : "bad body" });
  }
}

export function registerProjects(router: Router) {
  router.use("/api/projects", async (req, res) => {
    if (req.method !== "GET") return json(res, 405, { error: "GET only" });
    const owner = ownerOf(req, res)!;
    const metas = await readIndex(owner);
    // Each with its latest page, for the thumbnails.
    const projects = await Promise.all(metas.map(async (m) => ({ ...m, latest: (await readVersions(owner, m.id)).at(-1)?.doc })));
    json(res, 200, { projects: projects.sort((a, b) => b.updatedAt - a.updatedAt) });
  });

  router.use("/api/project", async (req, res) => {
    if (req.method !== "GET") return json(res, 405, { error: "GET only" });
    const owner = ownerOf(req, res)!;
    const id = new URL(req.url ?? "", "http://x").searchParams.get("id") ?? "";
    if (!PROJECT.test(id) || !(await readIndex(owner)).some((m) => m.id === id)) return json(res, 404, { error: "no such project" });
    json(res, 200, { versions: (await readVersions(owner, id)).slice(-VERSIONS_SENT) });
  });

  router.use("/api/project/save", async (req, res) => {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    const owner = ownerOf(req, res)!;
    const b = await body<{ id?: string; versions?: Version[]; meta?: { name?: string; named?: boolean; pages?: number } }>(req, res);
    if (!b) return;
    if (!PROJECT.test(b.id ?? "") || !Array.isArray(b.versions) || !b.versions.every(isVersion)) return json(res, 400, { error: "send id, versions and meta" });
    const id = b.id!;
    const versions = await serial(owner, async () => {
      const stored = await readVersions(owner, id);
      // Another tab may have saved the same numbers meanwhile: keep both, the newcomers after.
      let n = stored.at(-1)?.n ?? 0;
      const added = b.versions!.map((v) => (v.n > n ? ((n = v.n), v) : { ...v, n: ++n }));
      await mkdir(dir(owner), { recursive: true });
      if (added.length) await appendFile(file(owner, id), added.map((v) => JSON.stringify(v)).join("\n") + "\n");
      const all = [...stored, ...added];
      const metas = await readIndex(owner);
      const old = metas.find((m) => m.id === id);
      const now = Date.now();
      const meta: Meta = {
        id,
        name: old?.named ? old.name : String(b.meta?.name ?? old?.name ?? "Untitled").slice(0, 120),
        ...((old?.named || b.meta?.named) && { named: true }),
        createdAt: old?.createdAt ?? now,
        updatedAt: added.length || !old ? now : old.updatedAt,
        pages: Number(b.meta?.pages ?? old?.pages ?? 1),
        versions: all.length,
      };
      await writeIndex(owner, old ? metas.map((m) => (m.id === id ? meta : m)) : [...metas, meta]);
      return all;
    });
    json(res, 200, { versions: versions.slice(-VERSIONS_SENT) });
  });

  router.use("/api/project/rename", async (req, res) => {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    const owner = ownerOf(req, res)!;
    const b = await body<{ id?: string; name?: string }>(req, res);
    if (!b) return;
    const name = String(b.name ?? "").trim().slice(0, 120);
    if (!PROJECT.test(b.id ?? "") || !name) return json(res, 400, { error: "send id and name" });
    await serial(owner, async () => writeIndex(owner, (await readIndex(owner)).map((m) => (m.id === b.id ? { ...m, name, named: true } : m))));
    json(res, 200, { ok: true });
  });

  router.use("/api/project/delete", async (req, res) => {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    const owner = ownerOf(req, res)!;
    const b = await body<{ id?: string }>(req, res);
    if (!b) return;
    if (!PROJECT.test(b.id ?? "")) return json(res, 400, { error: "send id" });
    await serial(owner, async () => {
      await writeIndex(owner, (await readIndex(owner)).filter((m) => m.id !== b.id));
      await rm(file(owner, b.id!), { force: true });
    });
    json(res, 200, { ok: true });
  });

  // For testing from scratch in development; never in a hosted build.
  router.use("/api/projects/reset", async (req, res) => {
    if (req.method !== "POST" || process.env.NODE_ENV === "production") return json(res, 404, { error: "not here" });
    const owner = ownerOf(req);
    if (owner) await serial(owner, () => rm(dir(owner), { recursive: true, force: true }));
    json(res, 200, { ok: true });
  });
}
