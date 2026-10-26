// The real-use loop's steps (evals/real/README.md), run by `rte real <step>`: testers' sends become sessions
// (ingest), each send's boards become images (render, 0 calls), Opus reads each session for what landed
// (triage) and draws what each clear miss should have made (gold), the owner looks over gold (review), and
// the approved cases become the frozen bench R1 (freeze). Testers' words and drawings stay in
// $RT_EVAL_HOME/real/ on this machine: the repo and its eval/history branch are public, so history gets
// only R1's hash and counts, never a case.
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { SCREEN, type View } from "../../src/core/board.ts";
import { changeFrame } from "../core/diff.ts";
import { type Page, capture } from "../loop/chrome.ts";
import type { Shot } from "../loop/human.ts";
import { ask } from "../loop/client.ts";
import { historyWrite } from "../loop/history.ts";
import { paths } from "../loop/paths.ts";
import type { CaseInput, Meant, SceneJSON } from "../loop/types.ts";
import { type Check, runChecks } from "./checks.ts";
import { type Gold, applyGold, boardOps, ownChecks, readGold } from "./gold.ts";
import { GOLD_SYSTEM, TRIAGE_SYSTEM, goldUser, triageTurns } from "./prompts.ts";
import { type RealSend, type Session, afterOf, beforeOf, ingest } from "./sessions.ts";
import { reviewPage } from "./review.ts";

/** Triage and gold. Gold is the ideal the product aims at with cheap, fast models: no product limit applies to it. */
export const OPUS = { model: "opus", effort: "high" } as const;
/** Sends judged per triage call: two images each. */
const TRIAGE_WINDOW = 11;
const ASPECT = SCREEN.w / SCREEN.h;
/** R-hold's share of cases: a whole person is in one split, as a cluster (splitByPerson). */
const HOLD_SHARE = 1 / 3;

export type TriageRow = { n: number; meant: string; landed: "yes" | "partly" | "no"; categories: string[]; evidence: string; gold: boolean };
export type Triage = { prompt: string; keys: string; at: string; sends: TriageRow[] };
export type GoldCase = {
  key: string; session: string; n: number; batch: number; at: string; prompt: string;
  meant: string; categories: string[]; evidence: string;
  gold?: Gold; error?: string; problems: string[];
  /** The send gold was drawn for (sendHash): a later pull that moves a send under the same key can't pass this gold off as its own. */
  sendHash?: string;
  /** The free checks on the app's result and on gold's (gold should pass all of its own). */
  appChecks: { check: Check; pass: boolean; why: string }[]; goldChecks: { check: Check; pass: boolean; why: string }[];
};
export type Verdict = { key: string; verdict: "approve" | "reject"; note?: string; at: string };
/** review/verdicts.jsonl: a verdict (with the note as it was), or a note saved on its own as it's typed. */
type ReviewRow = { key: string; verdict?: Verdict["verdict"]; note?: string; at: string };

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
/** An image file as the gateway takes it. */
const dataUrl = (f: string) => `data:image/jpeg;base64,${readFileSync(f).toString("base64")}`;
const js = JSON.stringify;
const json = <T>(f: string): T => JSON.parse(readFileSync(f, "utf8"));
const maybe = <T>(f: string): T | undefined => (existsSync(f) ? json<T>(f) : undefined);
const put = (f: string, v: unknown) => {
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, `${JSON.stringify(v, null, 1)}\n`);
};

export const realHome = () => join(paths().home, "real");
const sessionsDir = () => join(realHome(), "sessions");
const goldDir = () => join(realHome(), "gold");
const goldCaseDir = (key: string) => join(goldDir(), key.replace("#", "-"));
const verdictsFile = () => join(realHome(), "review", "verdicts.jsonl");

export function readSessions(): { dir: string; s: Session }[] {
  const root = sessionsDir();
  return (existsSync(root) ? readdirSync(root) : []).sort().flatMap((id) => {
    const s = maybe<Session>(join(root, id, "session.json"));
    return s ? [{ dir: join(root, id), s }] : [];
  });
}

// ---- ingest

/** The latest pull (evals/real/pull.sh), or `stamp`, as sessions. */
export function ingestStep(stamp?: string): string[] {
  const raw = join(realHome(), "raw", stamp ?? readFileSync(join(realHome(), "raw", "latest"), "utf8").trim());
  if (!existsSync(raw)) throw new Error(`no pull at ${raw}: run evals/real/pull.sh on the laptop first`);
  const out: string[] = [];
  for (const src of ["live", "local"] as const) {
    if (!existsSync(join(raw, src))) continue;
    const ss = ingest(join(raw, src), src, sessionsDir());
    const sends = ss.reduce((n, s) => n + s.sends.length, 0);
    out.push(`${src}: ${ss.length} sessions, ${sends} sends (${ss.filter((s) => !s.admin).length} sessions by testers)`);
  }
  return out;
}

/** Sessions worth triage: every live one, and local (the owner's dev server) ones since `since`. */
export function chosen(since: string, only?: string): { dir: string; s: Session }[] {
  return readSessions().filter(({ s }) => s.sends.length && (only ? s.id === only : s.source === "live" || s.sends[0].at >= since));
}

// ---- render

const unite = (a: View, b: View): View => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const fit = (v: View, pad = 0): View => {
  let { x, y, w, h } = { x: v.x - pad, y: v.y - pad, w: v.w + 2 * pad, h: v.h + 2 * pad };
  if (w / h < ASPECT) [x, w] = [x - (h * ASPECT - w) / 2, h * ASPECT];
  else [y, h] = [y - (w / ASPECT - h) / 2, w / ASPECT];
  return { x, y, w, h };
};
/** The whole board: its pages, else every shape, else the first screen. */
function boundsOf(j: SceneJSON): View {
  const boxes = (j.shapes.some((s) => s.kind === "frame") ? j.shapes.filter((s) => s.kind === "frame") : j.shapes).map((s) => s.box);
  return boxes.length ? fit(boxes.reduce(unite), 40) : { x: 0, y: 0, ...SCREEN };
}
const meets = (a: View, b: View, gap = 0) => a.x - gap < b.x + b.w && b.x - gap < a.x + a.w && a.y - gap < b.y + b.h && b.y - gap < a.y + a.h;
/** Pages this close to what a send touched are shown with it ("an iPad screen next to it"). */
const NEAR_PX = 400;
/**
 * Where a send is looked at, before and after alike: what it changed and the ink, with every page near them or on
 * the person's screen. The screen alone when none of that exists (it may show only empty board: a person scrolled
 * above the page still sends).
 */
export function frameOf(before: SceneJSON, after: SceneJSON, camera: View, strokes: RealSend["strokes"] = []): View {
  const ch = changeFrame(before, [after], ASPECT, 0);
  const pts = strokes.flatMap((s) => s.points);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const ink = pts.length ? { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } : undefined;
  const focus = [ch, ink].filter((b): b is View => !!b);
  const pages = [...before.shapes, ...after.shapes].filter((s) => s.kind === "frame").map((s) => s.box);
  const near = pages.filter((p) => focus.some((f) => meets(p, f, NEAR_PX)) || meets(p, camera));
  const all = [...focus, ...near];
  return all.length ? fit(all.reduce(unite), 40) : camera;
}
export const cameraOf = (x: RealSend, before: SceneJSON): View => (x.camera ? fit(x.camera) : boundsOf(before));

/** Real-use images are shot at the stage's own width: Opus reads pictures' detail that 640 px loses. */
export const REAL_PX = 1280;
/** A Shot on a bridge page at REAL_PX (human.ts' pageShot, wider). */
export const realShot = (page: Page): Shot => async (scene, view, strokes) => {
  await page.reload();
  await page.eval("new Promise((r) => { const t = () => (window.rtEval ? r() : setTimeout(t, 20)); t(); })");
  await page.eval(`rtEval.load(${js({ scene, camera: view })})`);
  await page.eval(`rtEval.showInk(${js(strokes)}, { numbers: true })`);
  return capture(page, { width: REAL_PX, quality: 0.85 });
};

type Images = Record<string, { before: string; after: string }>;
const imagesOf = (dir: string) => maybe<Images>(join(dir, "img", "index.json")) ?? {};

/** Each send's before (with the person's ink) and after, on one frame (frameOf), as JPEGs; ones already shot are kept. */
export async function renderSession(dir: string, s: Session, shot: Shot): Promise<number> {
  const index: Images = {};
  let made = 0;
  const shoot = async (scene: SceneJSON, view: View, strokes: RealSend["strokes"]) => {
    const name = `${sha(js([scene, view, strokes])).slice(0, 16)}.jpg`;
    const f = join(dir, "img", name);
    if (!existsSync(f)) {
      mkdirSync(join(dir, "img"), { recursive: true });
      writeFileSync(f, await shot(scene, view, strokes));
      made++;
    }
    return name;
  };
  for (const x of s.sends) {
    const before = beforeOf(dir, x), after = afterOf(dir, x);
    const frame = frameOf(before, after, cameraOf(x, before), x.strokes);
    index[x.key] = { before: await shoot(before, frame, x.strokes), after: await shoot(after, frame, []) };
  }
  put(join(dir, "img", "index.json"), index);
  return made;
}

// ---- triage

const jsonIn = (text: string) => {
  const m = /\{[\s\S]*\}/.exec(text);
  try {
    return m ? JSON.parse(m[0]) : undefined;
  } catch {
    return undefined;
  }
};
const keysOf = (s: Session) => sha(js(s.sends.map((x) => [x.key, x.label, x.before, x.after])));
export const triageOf = (dir: string) => maybe<Triage>(join(dir, "triage.json"));
/** Whether a session's triage is current: same prompt, same sends. */
const triaged = (dir: string, s: Session) => {
  const t = triageOf(dir);
  return !!t && t.prompt === sha(TRIAGE_SYSTEM) && t.keys === keysOf(s);
};

/** One session's triage: Opus, a window of sends per call, with the whole session's words as context. */
export async function triageSession(dir: string, s: Session, run: string): Promise<Triage | "kept"> {
  if (triaged(dir, s)) return "kept";
  const img = imagesOf(dir);
  const rows: TriageRow[] = [];
  for (let from = 0; from < s.sends.length; from += TRIAGE_WINDOW) {
    const win = s.sends.slice(from, from + TRIAGE_WINDOW);
    const images = win.flatMap((x) => {
      if (!img[x.key]) throw new Error(`${x.key} has no images: run rte real render first`);
      return [dataUrl(join(dir, "img", img[x.key].before)), dataUrl(join(dir, "img", img[x.key].after))];
    });
    const { text } = await ask({ role: "real-triage", ...OPUS, system: TRIAGE_SYSTEM, turns: triageTurns(s, from, win.length), images, run, case: s.id });
    const got = (jsonIn(text)?.sends ?? []) as Partial<TriageRow>[];
    for (let i = 0; i < win.length; i++) {
      const r = got.find((g) => Number(g.n) === from + i + 1);
      // Never the reply itself in the message: it quotes the tester, and errors reach logs/.
      if (!r) throw new Error(`triage of ${s.id} left out send ${from + i + 1} (${text.length} characters of reply)`);
      const landed = (["yes", "partly", "no"] as const).find((l) => l === r.landed) ?? "no";
      rows.push({ n: from + i + 1, meant: String(r.meant ?? ""), landed, categories: Array.isArray(r.categories) ? r.categories.map(String) : [], evidence: String(r.evidence ?? ""), gold: r.gold === true && landed !== "yes" });
    }
  }
  const t: Triage = { prompt: sha(TRIAGE_SYSTEM), keys: keysOf(s), at: new Date().toISOString(), sends: rows };
  put(join(dir, "triage.json"), t);
  return t;
}

// ---- gold

export const goldOf = (key: string) => maybe<GoldCase>(join(goldCaseDir(key), "gold.json"));
/** The next gold run's batch number: the owner approves batch 1; later batches go in unless rejected. */
export const nextBatch = () => {
  const dir = goldDir();
  const batches = (existsSync(dir) ? readdirSync(dir) : []).map((k) => maybe<GoldCase>(join(dir, k, "gold.json"))?.batch ?? 0);
  return Math.max(0, ...batches) + 1;
};

/** What identifies a send beyond its position: its words, ink and time. */
const sendHash = (x: RealSend) => sha(js([x.words, x.strokes, x.at]));

/**
 * Every triaged send that wants gold and has none (or only a failed one). A send whose ink is lost is left out: it
 * can't replay, so it can't enter R1. Gold isn't redrawn when a prompt changes (the product's draw manual is part of
 * gold's, and the loop changes it): `regold` redraws every unreviewed one, as the owner asks.
 */
export function wantGold(since: string, only?: string, regold = false): { dir: string; s: Session; x: RealSend; n: number; t: TriageRow }[] {
  const seen = reviewed();
  return chosen(since, only).flatMap(({ dir, s }) => {
    const tr = triageOf(dir);
    if (!tr || tr.keys !== keysOf(s)) return [];
    return tr.sends.filter((t) => t.gold).flatMap((t) => {
      const x = s.sends[t.n - 1];
      const had = goldOf(x.key);
      // Failed gold is drawn again, whatever was said of it: there was nothing to approve.
      return x.replay === "ink" || (had && !had.error && (seen.has(x.key) || !regold)) ? [] : [{ dir, s, x, n: t.n, t }];
    });
  });
}

/** One send's gold: Opus writes the ops and draws the pictures; the gold board is built and checked (shootGold takes its image). */
export async function goldSend(c: ReturnType<typeof wantGold>[number], run: string, batch: number): Promise<GoldCase> {
  const { dir, s, x, n, t } = c;
  const img = imagesOf(dir)[x.key];
  if (!img) throw new Error(`${x.key} has no images: run rte real render first`);
  const before = beforeOf(dir, x), after = afterOf(dir, x);
  const out = goldCaseDir(x.key);
  mkdirSync(out, { recursive: true });
  // A redrawn gold keeps its batch: batch 1's still waits for the owner. Failed gold had nothing to show, so its retry is this run's.
  const had = goldOf(x.key);
  const base = { key: x.key, session: s.id, n, batch: had?.gold ? had.batch : batch, at: new Date().toISOString(), prompt: sha(GOLD_SYSTEM()), sendHash: sendHash(x), meant: t.meant, categories: t.categories, evidence: t.evidence };
  const { text } = await ask({
    role: "real-gold", ...OPUS, system: GOLD_SYSTEM(), user: goldUser(s, x, n, t, boardOps(before)),
    images: [dataUrl(join(dir, "img", img.before)), dataUrl(join(dir, "img", img.after))], run, case: x.key,
  });
  writeFileSync(join(out, "reply.txt"), text);
  rmSync(join(out, "gold.jpg"), { force: true });
  const g = readGold(text);
  if ("error" in g) {
    const gc: GoldCase = { ...base, error: g.error, problems: [], appChecks: [], goldChecks: [] };
    put(join(out, "gold.json"), gc);
    return gc;
  }
  const built = applyGold(before, g);
  put(join(out, "gold.scene.json"), built.after);
  const own = ownChecks(g, built.after, before);
  const kept = { ...g, checks: own.checks };
  const on = (scene: SceneJSON) => runChecks(kept.checks, scene, before);
  const gc: GoldCase = { ...base, gold: kept, problems: [...built.problems, ...own.dropped], appChecks: on(after), goldChecks: on(built.after) };
  put(join(out, "gold.json"), gc);
  return gc;
}

/**
 * Every gold case rebuilt from its saved reply (0 calls), so a change to gold.ts reaches the cases already drawn; a
 * board that came out different loses its image.
 */
export function rebuildGold(): number {
  const sessions = new Map(readSessions().map((x) => [x.s.id, x]));
  let changed = 0;
  for (const g of goldCases()) {
    const out = goldCaseDir(g.key);
    const ss = sessions.get(g.session);
    const x = ss?.s.sends[g.n - 1];
    if (!ss || !x || !existsSync(join(out, "reply.txt"))) continue;
    const read = readGold(readFileSync(join(out, "reply.txt"), "utf8"));
    if ("error" in read) continue;
    const before = beforeOf(ss.dir, x);
    const built = applyGold(before, read);
    const own = ownChecks(read, built.after, before);
    const kept = { ...read, checks: own.checks };
    const on = (scene: SceneJSON) => runChecks(kept.checks, scene, before);
    const { verdict: _, note: __, ...stored } = g;
    put(join(out, "gold.json"), { ...stored, gold: kept, problems: [...built.problems, ...own.dropped], appChecks: on(afterOf(ss.dir, x)), goldChecks: on(built.after) } satisfies GoldCase);
    if (js(maybe(join(out, "gold.scene.json"))) !== js(built.after)) {
      put(join(out, "gold.scene.json"), built.after);
      rmSync(join(out, "gold.jpg"), { force: true });
      changed++;
    }
  }
  return changed;
}

/** Gold boards without an image yet, shot framed as the app's result is. */
export async function shootGold(shot: Shot): Promise<number> {
  const sessions = new Map(readSessions().map((x) => [x.s.id, x]));
  let made = 0;
  for (const g of goldCases()) {
    const out = goldCaseDir(g.key);
    const ss = sessions.get(g.session);
    const x = ss?.s.sends[g.n - 1];
    if (!g.gold || !ss || !x || existsSync(join(out, "gold.jpg")) || !existsSync(join(out, "gold.scene.json"))) continue;
    const before = beforeOf(ss.dir, x), after = json<SceneJSON>(join(out, "gold.scene.json"));
    // Gold on the app's result's frame, widened if gold reached further.
    const app = frameOf(before, afterOf(ss.dir, x), cameraOf(x, before), x.strokes);
    try {
      writeFileSync(join(out, "gold.jpg"), await shot(after, fit(unite(app, frameOf(before, after, cameraOf(x, before), x.strokes))), []));
      made++;
    } catch (e) {
      put(join(out, "gold.json"), { ...json<GoldCase>(join(out, "gold.json")), problems: [...g.problems, `the bridge couldn't draw gold: ${(e as Error).message.split("\n")[0]}`] });
    }
  }
  return made;
}

// ---- review

/** Every gold case with its latest verdict on the gold drawn now (one given before a retry was of the failed gold). */
export function goldCases(): (GoldCase & { verdict?: Verdict; note?: string })[] {
  const dir = goldDir();
  const verdicts = new Map<string, Verdict>();
  const notes = new Map<string, string>();
  if (existsSync(verdictsFile())) for (const l of readFileSync(verdictsFile(), "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l) as ReviewRow;
    if (r.verdict) verdicts.set(r.key, { key: r.key, verdict: r.verdict, at: r.at, ...(r.note !== undefined ? { note: r.note } : {}) });
    // The latest note wins, sent with a verdict or on its own; a verdict sent without one leaves it.
    if (r.note !== undefined) notes.set(r.key, r.note);
  }
  return (existsSync(dir) ? readdirSync(dir) : []).sort().flatMap((k) => {
    const g = maybe<GoldCase>(join(dir, k, "gold.json"));
    const v = g && verdicts.get(g.key);
    return g ? [{ ...g, verdict: v && v.at >= g.at ? v : undefined, note: notes.get(g.key) }] : [];
  });
}
/** Keys the owner has looked at: gold for them is never drawn again, whatever the prompt became. */
const reviewed = () => new Set(goldCases().filter((g) => g.verdict).map((g) => g.key));

/** Whether a gold case goes into R1: the first batch only on the owner's approval, later ones unless rejected. */
export const accepted = (g: GoldCase & { verdict?: Verdict }) => !!g.gold && !g.error && (g.verdict ? g.verdict.verdict === "approve" : g.batch > 1);

const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".html": "text/html; charset=utf-8", ".json": "application/json" };

/** The review page and its images, on host:port (this machine's Tailscale address: never a public one). */
export function serveReview(host: string, port: number): Promise<string> {
  const root = realHome();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      if (req.method === "POST" && url.pathname === "/api/verdict") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const v = JSON.parse(body) as Partial<Verdict>;
        if (typeof v.key !== "string" || !goldOf(v.key) || (v.verdict !== "approve" && v.verdict !== "reject")) return send(400, TYPES[".json"], js({ error: "a verdict needs a gold key and approve or reject" }));
        const row: ReviewRow = { key: v.key, verdict: v.verdict, ...(v.note ? { note: String(v.note).slice(0, 2000) } : {}), at: new Date().toISOString() };
        mkdirSync(join(root, "review"), { recursive: true });
        appendFileSync(verdictsFile(), `${js(row)}\n`);
        return send(200, TYPES[".json"], js(row));
      }
      if (req.method === "POST" && url.pathname === "/api/note") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const v = JSON.parse(body) as Partial<ReviewRow>;
        if (typeof v.key !== "string" || !goldOf(v.key) || typeof v.note !== "string") return send(400, TYPES[".json"], js({ error: "a note needs a gold key and its text" }));
        const row: ReviewRow = { key: v.key, note: v.note.slice(0, 2000), at: new Date().toISOString() };
        mkdirSync(join(root, "review"), { recursive: true });
        appendFileSync(verdictsFile(), `${js(row)}\n`);
        return send(200, TYPES[".json"], js(row));
      }
      if (req.method !== "GET") return send(405, "text/plain", "GET, or POST /api/verdict or /api/note");
      if (url.pathname === "/") return send(200, TYPES[".html"], reviewPage(goldCases(), (key) => readSessions().find(({ s }) => s.sends.some((x) => x.key === key))));
      // Images only, from sessions/<id>/img/ and gold/<key>/.
      const rel = normalize(decodeURIComponent(url.pathname.slice(1)));
      const f = join(root, rel);
      if (!f.startsWith(root + sep) || extname(f) !== ".jpg" || !/^(sessions\/[^/]+\/img|gold\/[^/]+)\/[^/]+\.jpg$/.test(rel) || !existsSync(f)) return send(404, "text/plain", "not found");
      return send(200, TYPES[".jpg"], readFileSync(f));
    } catch (e) {
      return send(500, "text/plain", (e as Error).message);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(`http://${host}:${port}/`));
  });
}

// ---- freeze

const benchDir = () => join(realHome(), "bench", "R1");
/** Who made a send, for R1's split and clusters: the owner is one person wherever they worked (live or local). */
const whoOf = (s: Session) => (s.admin ? "owner" : s.person);
/** A send's input with its board, for merging duplicates: the same words and ink on the same board ask the same thing. */
const inputKey = (x: RealSend, before: SceneJSON) =>
  sha(js([typeof x.words === "string" ? x.words : x.words.map((w) => w.word).join(" "), x.strokes.map((k) => k.points), before.shapes]));

/**
 * R1's split by person (LOOP-V2.md A5), so no one is on both sides: the owner's sends tune (there are many, and the
 * owner can make more), and testers go to R-hold until it holds HOLD_SHARE of the cases, in a fixed order (by the hash
 * of their pseudonym), each to whichever side is further below its share. R-hold is then people the loop never tuned on.
 */
function splitByPerson(counts: Map<string, number>): Map<string, "tune" | "hold"> {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const out = new Map<string, "tune" | "hold">();
  let hold = 0, tune = counts.get("owner") ?? 0;
  if (counts.has("owner")) out.set("owner", "tune");
  const testers = [...counts.keys()].filter((k) => k !== "owner").sort((a, b) => sha(`R1|${a}`).localeCompare(sha(`R1|${b}`)));
  for (const t of testers) {
    const n = counts.get(t)!;
    const side = hold / (HOLD_SHARE * total) <= tune / ((1 - HOLD_SHARE) * total) ? "hold" : "tune";
    out.set(t, side);
    side === "hold" ? (hold += n) : (tune += n);
  }
  return out;
}

/** R1's files by sha256 and the hash over them, as checkpoint.ts' manifests are made. */
function manifest(root: string) {
  const files: Record<string, string> = {};
  for (const id of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort())
    for (const f of readdirSync(join(root, id)).sort()) files[`${id}/${f}`] = sha(readFileSync(join(root, id, f)));
  return { version: "R1", files, hash: sha(Object.entries(files).map(([f, h]) => `${f} ${h}`).join("\n")) };
}

/**
 * R1 from every accepted gold case that replays (from the send log, or typed words; a send whose ink is lost
 * waits for synthesized ink): real/bench/R1/<case>/, rebuilt whole each time. A send that repeats an earlier one
 * (the same words and ink on the same board) is merged into it. Cases split by person (splitByPerson) and cluster
 * by person (case.json's originSession is the person): one person's sends move together. History gets R1.json:
 * the hash, the counts and the case ids, nothing a tester said or drew.
 */
export function freezeReal(): { cases: number; tune: number; hold: number; inkWaiting: number; merged: number; moved: number; people: { tune: number; hold: number }; hash: string } {
  if (existsSync(paths().lock)) throw new Error(`${paths().lock} is held: a loop is running (or stopped mid-way: loop --resume first); R1 can't change under it`);
  // Built aside and swapped in whole: a freeze that fails half way leaves the last R1 as it was.
  const root = benchDir(), next = `${root}.next`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  const sessions = new Map(readSessions().map((x) => [x.s.id, x]));
  let inkWaiting = 0, merged = 0, moved = 0;
  const seen = new Set<string>();
  const picked: { g: GoldCase; ss: { dir: string; s: Session }; x: RealSend; before: SceneJSON; who: string }[] = [];
  for (const g of goldCases().filter(accepted).sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const ss = sessions.get(g.session);
    const x = ss?.s.sends[g.n - 1];
    if (!ss || !x) continue;
    // Gold drawn for another send that a later pull moved to this key (older gold has no sendHash).
    if (g.sendHash && g.sendHash !== sendHash(x)) {
      moved++;
      continue;
    }
    if (x.replay === "ink") {
      inkWaiting++;
      continue;
    }
    const before = beforeOf(ss.dir, x);
    const k = inputKey(x, before);
    if (seen.has(k)) {
      merged++;
      continue;
    }
    seen.add(k);
    picked.push({ g, ss, x, before, who: whoOf(ss.s) });
  }
  const counts = new Map<string, number>();
  for (const c of picked) counts.set(c.who, (counts.get(c.who) ?? 0) + 1);
  const sides = splitByPerson(counts);
  const ids: Record<string, string> = {};
  for (const { g, ss, x, before, who } of picked) {
    const id = g.key.replace("#", "-");
    const d = join(next, id);
    const camera = cameraOf(x, before);
    const split = sides.get(who)!;
    put(join(d, "case.json"), { id, set: "real", split, originSession: who, session: ss.s.id, send: g.n, recordedAt: x.at, replay: x.replay, source: ss.s.source, admin: ss.s.admin, categories: g.categories, hedged: false, beatDone: false });
    put(join(d, "input.json"), { camera, words: x.words, strokes: x.strokes, enterAtMs: x.enterAtMs, inputHash: sha(js([camera, x.words, x.strokes])) } satisfies CaseInput);
    put(join(d, "before.scene.json"), before);
    put(join(d, "meant.json"), { meant: g.meant, hedged: false } satisfies Meant);
    put(join(d, "rubric.json"), g.gold!.rubric);
    put(join(d, "checks.json"), g.gold!.checks);
    copyFileSync(join(ss.dir, "img", imagesOf(ss.dir)[x.key].before), join(d, "before-ink.jpg"));
    ids[id] = split;
  }
  const m = manifest(next);
  put(join(next, "manifest.json"), m);
  rmSync(root, { recursive: true, force: true });
  renameSync(next, root);
  const tune = Object.values(ids).filter((s) => s === "tune").length;
  const people = { tune: [...sides.values()].filter((s) => s === "tune").length, hold: [...sides.values()].filter((s) => s === "hold").length };
  const r = { cases: Object.keys(ids).length, tune, hold: Object.keys(ids).length - tune, inkWaiting, merged, moved, people, hash: m.hash };
  historyWrite("bench/R1.json", { ...r, at: new Date().toISOString(), splits: ids });
  return r;
}
