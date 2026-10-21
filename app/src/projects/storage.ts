// Projects, kept on the server (server/projects.ts) and never in browser storage:
// nothing of a person's work stays on their device. A tab loads the projects index,
// and each project it opens, into memory, so reading is synchronous; saves go to the
// server one after another, retried until they land, and other tabs hear about them
// over a BroadcastChannel and fetch the new state. The tab's project is in its URL
// (?p=<id>), so tabs can work on different boards side by side. Shared by the editor
// (board/board.ts) and the projects page (ProjectsPage.tsx). (v1's storage.ts: a
// version's doc is a v2 board, Scene.toJSON(), whose pictures are inside it.)
import { asPage } from "../../../src/core/board.ts";
import { runScript } from "../../../src/core/ops.ts";
import { Scene, type SceneJSON } from "../../../src/core/scene.ts";
import type { Version } from "../board/history.ts";
import { pageRows, siteName } from "../board/pages.ts";

export type { Version };

/** A new project's board: one blank Home page, the eval's blank start. */
export const blankBoard = (): SceneJSON => runScript(asPage("", "page", "Home")).scene.toJSON();

export type ProjectMeta = {
  id: string;
  name: string;
  /** Set once the user names it; until then the name follows the site's title. */
  named?: boolean;
  createdAt: number;
  updatedAt: number;
  pages: number;
  versions: number;
};

type Listed = ProjectMeta & { latest?: SceneJSON };

/** Versions kept in memory per project (the server keeps them all). */
const KEPT = 200;
const RETRY_MAX_MS = 30_000;

const index = new Map<string, Listed>();
const versions = new Map<string, Version[]>();
/** The newest version the server has confirmed, per project: only newer ones are sent. */
const confirmed = new Map<string, number>();

/**
 * Tells this tab's pages that a project changed: `detail.project`.
 * Other tabs get the same over the channel, after fetching the new state.
 */
export const SAVED_EVENT = "rt-draw:saved";
type Saved = { project?: string };
export const savedFor = (e: Event, id: string) => (e as CustomEvent<Saved>).detail?.project === id;

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("rt-draw-app.projects") : undefined;
const announce = (detail: Saved, otherTabs: boolean) => {
  dispatchEvent(new CustomEvent(SAVED_EVENT, { detail }));
  if (otherTabs) channel?.postMessage(detail);
};
if (channel) {
  channel.onmessage = async (e: MessageEvent<Saved>) => {
    const d = e.data;
    try {
      if (d.project) {
        await loadIndex();
        // With writes of its own on the way, this tab's next save answer brings the other tab's versions.
        if (versions.has(d.project) && !pending.has(d.project)) await loadProject(d.project);
      }
    } catch {
      // the next save or reload catches up
    }
    announce(d, false);
  };
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit | undefined = body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function loadIndex() {
  const { projects } = await api<{ projects: Listed[] }>("/api/projects");
  // Projects with writes still on their way keep this tab's view of them.
  const mine = new Map([...index].filter(([id]) => pending.has(id)));
  index.clear();
  for (const p of projects) index.set(p.id, p);
  for (const [id, p] of mine) index.set(id, p);
}

async function loadProject(id: string) {
  const { versions: vs } = await api<{ versions: Version[] }>(`/api/project?id=${encodeURIComponent(id)}`);
  versions.set(id, vs);
  confirmed.set(id, vs.at(-1)?.n ?? 0);
}

/** Loads a project's versions if this tab doesn't have them yet (before the editor or preview shows it). */
export async function ensureProject(id: string) {
  if (!versions.has(id) && index.has(id)) await loadProject(id);
}

/** What a page needs before it shows: the projects, and the one in the URL. */
export async function ready() {
  await loadIndex();
  await ensureProject(currentProjectId());
}

export const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

/** Every project, most recently changed first. */
export function listProjects(): ProjectMeta[] {
  return [...index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadVersions(id: string): Version[] {
  return versions.get(id) ?? [];
}

export const latestDoc = (id: string): SceneJSON => versions.get(id)?.at(-1)?.doc ?? index.get(id)?.latest ?? blankBoard();

// ---- saving -----------------------------------------------------------------------------

const queues = new Map<string, Promise<void>>();
/** Writes not yet on the server, per project. */
const pending = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a project's server writes one after another; each is retried, waiting longer each time, until it lands. */
function enqueue(id: string, job: () => Promise<void>) {
  const run = async () => {
    for (let wait = 1000; ; wait = Math.min(RETRY_MAX_MS, wait * 2)) {
      try {
        return await job();
      } catch {
        await sleep(wait);
      }
    }
  };
  pending.set(id, (pending.get(id) ?? 0) + 1);
  const done = () => {
    const n = (pending.get(id) ?? 1) - 1;
    if (n > 0) pending.set(id, n);
    else pending.delete(id);
  };
  queues.set(id, (queues.get(id) ?? Promise.resolve()).then(run).finally(done));
}

function metaFor(id: string, kept: Version[]): Listed {
  const doc = kept.at(-1)?.doc ?? blankBoard();
  const scene = Scene.fromJSON(doc);
  const old = index.get(id);
  const now = Date.now();
  return {
    id,
    name: old?.named ? old.name : siteName(scene),
    ...(old?.named && { named: true }),
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
    pages: pageRows(scene).length,
    versions: kept.length,
    latest: doc,
  };
}

/** Saves a project's versions: in this tab at once, on the server in order. The server's numbering wins if another tab saved meanwhile. */
export function saveVersions(id: string, vs: Version[]) {
  const kept = vs.slice(-KEPT);
  versions.set(id, kept);
  const meta = metaFor(id, kept);
  index.set(id, meta);
  announce({ project: id }, false);
  enqueue(id, async () => {
    const fresh = (versions.get(id) ?? []).filter((v) => v.n > (confirmed.get(id) ?? 0));
    const sent = fresh.at(-1)?.n ?? confirmed.get(id) ?? 0;
    const { versions: stored } = await api<{ versions: Version[] }>("/api/project/save", { id, versions: fresh, meta: { name: meta.name, named: meta.named, pages: meta.pages } });
    const last = stored.at(-1)?.n ?? 0;
    confirmed.set(id, last);
    // The server renumbered a clash with another tab: take its history. Versions made while this save was on
    // its way aren't in it yet; they stay on top (the next save sends them).
    if (last !== sent) {
      const later = (versions.get(id) ?? []).filter((v) => v.n > sent).map((v, i) => ({ ...v, n: last + 1 + i }));
      versions.set(id, [...stored, ...later].slice(-KEPT));
    }
    announce({ project: id }, true);
  });
}

export function createProject(): ProjectMeta {
  const id = newId();
  versions.set(id, []);
  const meta = metaFor(id, []);
  index.set(id, meta);
  enqueue(id, async () => {
    await api("/api/project/save", { id, versions: [], meta: { name: meta.name, pages: meta.pages } });
    announce({ project: id }, true);
  });
  return meta;
}

export function renameProject(id: string, name: string) {
  const clean = name.trim();
  const m = index.get(id);
  if (!m || !clean) return;
  index.set(id, { ...m, name: clean, named: true });
  announce({ project: id }, false);
  enqueue(id, async () => {
    await api("/api/project/rename", { id, name: clean });
    announce({ project: id }, true);
  });
}

export function deleteProject(id: string) {
  index.delete(id);
  versions.delete(id);
  announce({ project: id }, false);
  enqueue(id, async () => {
    await api("/api/project/delete", { id });
    announce({ project: id }, true);
  });
}

/** The project a tab works on: the one in its URL, else the latest, else a new one. */
export function currentProjectId(): string {
  const wanted = new URLSearchParams(location.search).get("p");
  return (wanted && index.has(wanted) ? wanted : undefined) ?? listProjects()[0]?.id ?? createProject().id;
}

/** For starting from scratch in development: deletes this browser's projects on the server. */
export async function deleteAllProjects() {
  await fetch("/api/projects/reset", { method: "POST" });
}

/** How long ago, briefly: "now", "5m", "2h", "3d". */
export function ago(at: number): string {
  const s = (Date.now() - at) / 1000;
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
