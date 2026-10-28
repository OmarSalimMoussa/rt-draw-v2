// How intake (evals/real/intake.ts, evals/real/README.md) labels testers' sends: their projects become sessions
// (ingest), each send's boards become images (render, 0 calls), Opus reads each new send in its session for what the
// person meant and whether it landed (triage), and draws what each clear miss should have made (gold). What becomes of a
// labeled send (a proposed case, the owner's verdict, the bank, R1) is cases.ts'. Testers' words and drawings stay in
// $RT_EVAL_HOME/real/ on this machine: nothing here writes outside it, and logs get keys and counts only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCREEN, type View } from "../../src/core/board.ts";
import { changeFrame } from "../core/diff.ts";
import { type Page, capture } from "../loop/chrome.ts";
import { ask } from "../loop/client.ts";
import type { Shot } from "../loop/human.ts";
import { paths } from "../loop/paths.ts";
import type { SceneJSON } from "../loop/types.ts";
import { type Check, runChecks } from "./checks.ts";
import { type Gold, applyGold, boardOps, ownChecks, readGold } from "./gold.ts";
import { GOLD_SYSTEM, TRIAGE_SYSTEM, goldUser, triageTurns } from "./prompts.ts";
import { type RealSend, type Session, type Source, afterOf, beforeOf, ingest } from "./sessions.ts";

/** Triage and gold. Gold is the ideal the product aims at with cheap, fast models: no product limit applies to it. */
export const OPUS = { model: "opus", effort: "high" } as const;
/** Sends judged per triage call: two images each. */
const TRIAGE_WINDOW = 11;
/** Gold drawn this many times at most: a tune card whose gold stays unreadable is proposed with a drafted expectation, an R-hold card skipped. */
export const GOLD_TRIES = 2;
/** Tries at a send's images, or at gold's, before the send is skipped as one whose boards can't be drawn. */
export const SHOT_TRIES = 3;
/**
 * A session's sends are triaged once its last send is this old: what the person did next is triage's best evidence of
 * what they meant, and a send is judged only once.
 */
export const TRIAGE_SETTLE_MS = 60 * 60_000;
/** Local (the owner's dev server) sessions before this aren't labeled: the hosted app's testers started then. */
export const REAL_SINCE = "2026-10-22";
const ASPECT = SCREEN.w / SCREEN.h;

/** What paid calls wait on: the budget's gate (ab.ts budgetGate), before each one. */
export type Gate = () => Promise<unknown>;
export type TriageRow = {
  key: string;
  /** The triage prompt that judged it (sha256 of TRIAGE_SYSTEM, 12): a new prompt judges new sends only. */
  prompt: string;
  at: string;
  meant: string;
  landed: "yes" | "partly" | "no";
  categories: string[];
  evidence: string;
  gold: boolean;
  /** Whether they asked for something drawn or changed (absent in rows judged before 2026-10-28: taken as yes). */
  drawing?: boolean;
};
export type GoldCase = {
  key: string; session: string; at: string; prompt: string;
  /** How many times gold was drawn for the send (GOLD_TRIES at most). */
  attempts: number;
  /** Tries at the gold board's image that failed (SHOT_TRIES at most); a rebuilt board starts again. */
  shotTries?: number;
  /** When the owner's look window opened, for a send in no bank case (an R-hold person's): cases.ts. */
  proposedAt?: string;
  meant: string; categories: string[]; evidence: string;
  gold?: Gold; error?: string; problems: string[];
  /** The free checks on the app's result and on gold's (gold passes all of its own). */
  appChecks: { check: Check; pass: boolean; why: string }[]; goldChecks: { check: Check; pass: boolean; why: string }[];
};

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const sha12 = (s: string) => sha(s).slice(0, 12);
/** An image file as the gateway takes it. */
const dataUrl = (f: string) => `data:image/jpeg;base64,${readFileSync(f).toString("base64")}`;
const js = JSON.stringify;
export const json = <T>(f: string): T => JSON.parse(readFileSync(f, "utf8"));
export const maybe = <T>(f: string): T | undefined => (existsSync(f) ? json<T>(f) : undefined);
/** Written aside and renamed over: Eval HQ reads these files while intake writes them. */
export const put = (f: string, v: unknown) => {
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(`${f}.tmp`, `${JSON.stringify(v, null, 1)}\n`);
  renameSync(`${f}.tmp`, f);
};

export const realHome = () => join(paths().home, "real");
/** Intake's last pass (real/intake.json, intake.ts): when, what failed, and how many passes in a row had a failure. */
export type IntakePass = { at: string; failed: number; failedPasses: number; ended?: "week" | "stop" };
export const passFile = () => join(realHome(), "intake.json");
/** `rte intake --regold` while the loop runs: the loop's next intake redraws gold (real/regold.request). */
export const regoldFile = () => join(realHome(), "regold.request");
const sessionsDir = () => join(realHome(), "sessions");
const goldDir = () => join(realHome(), "gold");
/** A send's gold folder: its key with "#" as "-". */
export const goldCaseDir = (key: string) => join(goldDir(), key.replace("#", "-"));

export type Labeled = { dir: string; s: Session };
export function readSessions(): Labeled[] {
  const root = sessionsDir();
  return (existsSync(root) ? readdirSync(root) : []).sort().flatMap((id) => {
    const s = maybe<Session>(join(root, id, "session.json"));
    return s ? [{ dir: join(root, id), s }] : [];
  });
}
/** Sessions intake labels: every live one, and the owner's local ones since REAL_SINCE. */
export const chosen = (): Labeled[] => readSessions().filter(({ s }) => s.sends.length && (s.source === "live" || s.sends[0].at >= REAL_SINCE));

// ---- ingest

/** A source's latest snapshot (evals/real/pull.sh): real/raw/<source>/<stamp>/, named in real/raw/<source>/latest. */
export function snapshot(src: Source): string | undefined {
  const f = join(realHome(), "raw", src, "latest");
  const dir = existsSync(f) ? join(realHome(), "raw", src, readFileSync(f, "utf8").trim()) : undefined;
  return dir && existsSync(dir) ? dir : undefined;
}

/** Each source's latest snapshot as sessions; a session a snapshot no longer has stays as it was. */
export function ingestAll(): { source: Source; sessions: number; sends: number }[] {
  return (["live", "local"] as const).flatMap((src) => {
    const raw = snapshot(src);
    if (!raw) return [];
    const ss = ingest(raw, src, sessionsDir());
    return [{ source: src, sessions: ss.length, sends: ss.reduce((n, s) => n + s.sends.length, 0) }];
  });
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
export const imagesOf = (dir: string) => maybe<Images>(join(dir, "img", "index.json")) ?? {};
/** Failed tries at each send's images (img/failed.json): SHOT_TRIES of them, and the send is skipped. */
export const renderFailures = (dir: string) => maybe<Record<string, number>>(join(dir, "img", "failed.json")) ?? {};
/** Whether every send of a session has its images, or has failed at them SHOT_TRIES times. */
export const rendered = ({ dir, s }: Labeled) => {
  const img = imagesOf(dir), failed = renderFailures(dir);
  return s.sends.every((x) => img[x.key] || (failed[x.key] ?? 0) >= SHOT_TRIES);
};

/**
 * Each send's before (with the person's ink) and after, on one frame (frameOf), as JPEGs named by what they show; ones
 * already shot are kept. A send whose boards can't be built or drawn is counted and left (the rest go on), `failed`
 * hearing its key and error; the next pass tries it again.
 */
export async function renderSession({ dir, s }: Labeled, shot: Shot, failed: (key: string, err: unknown) => void = () => {}): Promise<number> {
  const index: Images = {}, fails = renderFailures(dir);
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
    if ((fails[x.key] ?? 0) >= SHOT_TRIES) continue;
    try {
      const before = beforeOf(dir, x), after = afterOf(dir, x);
      const frame = frameOf(before, after, cameraOf(x, before), x.strokes);
      index[x.key] = { before: await shoot(before, frame, x.strokes), after: await shoot(after, frame, []) };
      delete fails[x.key];
    } catch (err) {
      fails[x.key] = (fails[x.key] ?? 0) + 1;
      failed(x.key, err);
    }
  }
  put(join(dir, "img", "index.json"), index);
  put(join(dir, "img", "failed.json"), fails);
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
/** A session's triage rows by send key (triage.json). */
export const triageOf = (dir: string) => new Map((maybe<{ sends: TriageRow[] }>(join(dir, "triage.json"))?.sends ?? []).map((r) => [r.key, r]));
/**
 * Triage of a session's sends at `keys` that have images and no row: Opus, a window of them per call, with every send
 * of the session as context. A send judged once keeps its row (a new prompt judges new sends only). Returns how many it
 * judged.
 */
export async function triageSession({ dir, s }: Labeled, keys: string[], run: string, gate: Gate): Promise<number> {
  const rows = triageOf(dir);
  const img = imagesOf(dir);
  const todo = s.sends.flatMap((x, i) => (keys.includes(x.key) && !rows.has(x.key) && img[x.key] ? [i] : []));
  for (let k = 0; k < todo.length; k += TRIAGE_WINDOW) {
    const win = todo.slice(k, k + TRIAGE_WINDOW);
    const images = win.flatMap((i) => [dataUrl(join(dir, "img", img[s.sends[i].key].before)), dataUrl(join(dir, "img", img[s.sends[i].key].after))]);
    await gate();
    const { text } = await ask({ role: "real-triage", ...OPUS, system: TRIAGE_SYSTEM, turns: triageTurns(s, win), images, run, case: s.id });
    const got = (jsonIn(text)?.sends ?? []) as Partial<TriageRow & { n: number }>[];
    const at = new Date().toISOString();
    for (const i of win) {
      const r = got.find((g) => Number(g.n) === i + 1);
      // Never the reply itself in the message: it quotes the tester, and errors reach logs/.
      if (!r) throw new Error(`triage of ${s.id} left out send ${i + 1} (${text.length} characters of reply)`);
      const landed = (["yes", "partly", "no"] as const).find((l) => l === r.landed) ?? "no";
      const x = s.sends[i];
      rows.set(x.key, { key: x.key, prompt: sha12(TRIAGE_SYSTEM), at, meant: String(r.meant ?? ""), landed, categories: Array.isArray(r.categories) ? r.categories.map(String) : [], evidence: String(r.evidence ?? ""), gold: r.gold === true && landed !== "yes", drawing: r.drawing !== false });
    }
    // After each window: a later window's failure keeps what this one paid for.
    put(join(dir, "triage.json"), { sends: s.sends.flatMap((x) => rows.get(x.key) ?? []) });
  }
  return todo.length;
}

// ---- gold

export const goldOf = (key: string) => maybe<GoldCase>(join(goldCaseDir(key), "gold.json"));
export type GoldTodo = Labeled & { x: RealSend; n: number; t: TriageRow };

/**
 * Every triaged send that wants gold and has none: never drawn, or unreadable fewer than GOLD_TRIES times. A send whose
 * ink is lost is left out (it can't replay). Gold isn't redrawn when a prompt changes (the product's draw manual is part
 * of gold's, and the loop changes it); `regold` redraws every one the owner hasn't given a verdict on.
 */
export function wantGold(o: { regold?: boolean; judged?: Set<string> } = {}): GoldTodo[] {
  return chosen().flatMap(({ dir, s }) => {
    const rows = triageOf(dir);
    return s.sends.flatMap((x, i) => {
      const t = rows.get(x.key);
      if (!t?.gold || x.replay === "ink") return [];
      const had = goldOf(x.key);
      const want = !had || (had.error ? had.attempts < GOLD_TRIES : !!o.regold && !o.judged?.has(x.key));
      return want ? [{ dir, s, x, n: i + 1, t }] : [];
    });
  });
}

/** Gold's parts checked on the before board: the board built, its own failing checks left out, every check on both results. */
function built(g: Gold, before: SceneJSON, after: SceneJSON) {
  const b = applyGold(before, g);
  const own = ownChecks(g, b.after, before);
  const kept = { ...g, checks: own.checks };
  const on = (scene: SceneJSON) => runChecks(kept.checks, scene, before);
  return { board: b.after, gold: kept, problems: [...b.problems, ...own.dropped], appChecks: on(after), goldChecks: on(b.after) };
}

/** One send's gold: Opus writes the ops and draws the pictures; the gold board is built and checked (shootGold takes its image). */
export async function goldSend(c: GoldTodo, run: string, gate: Gate): Promise<GoldCase> {
  const { dir, s, x, n, t } = c;
  const img = imagesOf(dir)[x.key];
  if (!img) throw new Error(`${x.key} has no images yet`);
  const before = beforeOf(dir, x), after = afterOf(dir, x);
  const out = goldCaseDir(x.key);
  const had = goldOf(x.key);
  const base = { key: x.key, session: s.id, at: new Date().toISOString(), prompt: sha12(GOLD_SYSTEM()), attempts: (had?.error ? had.attempts : 0) + 1, proposedAt: had?.proposedAt, meant: t.meant, categories: t.categories, evidence: t.evidence };
  await gate();
  const { text } = await ask({
    role: "real-gold", ...OPUS, system: GOLD_SYSTEM(), user: goldUser(s, x, n, t, boardOps(before)),
    images: [dataUrl(join(dir, "img", img.before)), dataUrl(join(dir, "img", img.after))], run, case: x.key,
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "reply.txt"), text);
  rmSync(join(out, "gold.jpg"), { force: true });
  const g = readGold(text);
  if ("error" in g) {
    const gc: GoldCase = { ...base, error: g.error, problems: [], appChecks: [], goldChecks: [] };
    put(join(out, "gold.json"), gc);
    return gc;
  }
  const b = built(g, before, after);
  put(join(out, "gold.scene.json"), b.board);
  const gc: GoldCase = { ...base, gold: b.gold, problems: b.problems, appChecks: b.appChecks, goldChecks: b.goldChecks };
  put(join(out, "gold.json"), gc);
  return gc;
}

/** Every gold case with its session and send: one whose session or send is gone (it can't be) is left out. */
export function goldCases(): (GoldCase & { ss: Labeled; x: RealSend })[] {
  const sessions = new Map(readSessions().map((l) => [l.s.id, l]));
  const dir = goldDir();
  return (existsSync(dir) ? readdirSync(dir) : []).sort().flatMap((k) => {
    const g = maybe<GoldCase>(join(dir, k, "gold.json"));
    const ss = g && sessions.get(g.session);
    const x = ss?.s.sends.find((y) => y.key === g!.key);
    return g && ss && x ? [{ ...g, ss, x }] : [];
  });
}

/**
 * Every gold case rebuilt from its saved reply (0 calls), so a change to gold.ts reaches the cases already drawn; a
 * board that came out different loses its image.
 */
export function rebuildGold(): number {
  let changed = 0;
  for (const { ss, x, ...g } of goldCases()) {
    const out = goldCaseDir(g.key);
    if (!existsSync(join(out, "reply.txt"))) continue;
    const read = readGold(readFileSync(join(out, "reply.txt"), "utf8"));
    if ("error" in read) continue;
    const b = built(read, beforeOf(ss.dir, x), afterOf(ss.dir, x));
    const moved = js(maybe(join(out, "gold.scene.json"))) !== js(b.board);
    const now: GoldCase = { ...g, gold: b.gold, problems: b.problems, appChecks: b.appChecks, goldChecks: b.goldChecks, ...(moved ? { shotTries: 0 } : {}) };
    if (js(now) !== js(g)) put(join(out, "gold.json"), now);
    if (moved) {
      put(join(out, "gold.scene.json"), b.board);
      rmSync(join(out, "gold.jpg"), { force: true });
      changed++;
    }
  }
  return changed;
}

/** Gold boards without an image that are still worth a try (SHOT_TRIES), each the app's result's frame widened to what gold reached. */
export const unshotGold = () => goldCases().filter((g) => g.gold && (g.shotTries ?? 0) < SHOT_TRIES && !existsSync(join(goldCaseDir(g.key), "gold.jpg")) && existsSync(join(goldCaseDir(g.key), "gold.scene.json")));
/** Each unshot gold board's image; a board the bridge can't draw is counted (shotTries) and left. Returns the images made. */
export async function shootGold(shot: Shot, failed: (key: string, err: unknown) => void = () => {}): Promise<number> {
  let made = 0;
  for (const g of unshotGold()) {
    const { ss, x } = g;
    const out = goldCaseDir(g.key);
    const before = beforeOf(ss.dir, x), after = json<SceneJSON>(join(out, "gold.scene.json"));
    const app = frameOf(before, afterOf(ss.dir, x), cameraOf(x, before), x.strokes);
    try {
      writeFileSync(join(out, "gold.jpg"), await shot(after, fit(unite(app, frameOf(before, after, cameraOf(x, before), x.strokes))), []));
      made++;
    } catch (err) {
      const { ss: _, x: __, ...stored } = g;
      put(join(out, "gold.json"), { ...stored, shotTries: (g.shotTries ?? 0) + 1 } satisfies GoldCase);
      failed(g.key, err);
    }
  }
  return made;
}
