// The camera on request: "zoom out", "go to the shop page", "a little to the
// left". A model gets where the camera is, the site map, and pictures if the
// knobs say so, and answers with one camera(...) line: a rectangle of the board
// or the ids to frame. Cases (src/fixtures/camera-cases.json) score it.
import { ASPECT, SCREEN, type View, boardBounds, centerOf, fitView, insideShare, norm, pagesOf, pageTop, siteMap, union } from "./board.ts";
import { type ModelStats, callModel, modelOf } from "./model.ts";
import type { Scene } from "./scene.ts";
import { takeShot } from "./shot.ts";
import { type TraceContext, span } from "./trace.ts";
import { DEFAULTS, type Tuning, tune } from "./tuning.ts";

export const CAMERA_SYSTEM = `You move the camera over an infinite board of web pages (frames) for the person using it. The screen is {W}×{H}; whatever you show is widened to fill it. Positions are board pixels: x right, y down. A smaller view is more zoomed in.

Reply with exactly one line and nothing else:
camera(x y w h)            show this rectangle of the board
camera(id)                 frame this shape or page, with a small margin
camera(id, id2, ...)       frame all of these

Move as much as a person would mean: "a bit" or "a little" is about a quarter of the screen, "pan right" about half, "zoom in" or "out" about twice. "Everything" or "all the way out" frames every page.`;

const r = (n: number) => Math.round(n);
const fmt = (v: View) => `${r(v.x)} ${r(v.y)} ${r(v.w)} ${r(v.h)}`;

export type CameraPrompt = { system: string; user: string; images: string[] };

export async function cameraPrompt(said: string, current: View, scene: Scene, t: Tuning = DEFAULTS, parent?: TraceContext): Promise<CameraPrompt> {
  return span("camera prompt", parent, async () => {
    const parts = [`The camera shows ${fmt(current)} (x y w h), so its centre is ${r(current.x + current.w / 2)},${r(current.y + current.h / 2)}.`];
    const images: string[] = [];
    const noTags = tune({ "shot.tagPx": 0 }, t);
    const [view, overview] = await Promise.all([
      t["camera.sendView"] ? takeShot(scene, [], t, { view: current, width: t["board.viewWidthPx"] }) : undefined,
      t["camera.sendOverview"] ? takeShot(scene, [], noTags, { view: fitView(union(pagesOf(scene).map((p) => p.box)), 0.03), width: t["board.overviewWidthPx"] }) : undefined,
    ]);
    if (view) {
      images.push(view.dataUrl);
      parts.push(`Picture ${images.length}: what the camera shows now, with shape ids.`);
    }
    if (overview) {
      images.push(overview.dataUrl);
      parts.push(`Picture ${images.length}: the whole board.`);
    }
    if (t["camera.sendMap"]) parts.push(`Site map:\n${siteMap(scene, t)}`);
    parts.push(`They said: "${said}"`);
    return { system: CAMERA_SYSTEM.replace("{W}", String(SCREEN.w)).replace("{H}", String(SCREEN.h)), user: parts.join("\n\n"), images };
  });
}

/** The model's line as a view of the screen's shape, kept between camera.minViewPx and a few times the board across. */
export function parseCamera(reply: string, scene: Scene, t: Tuning = DEFAULTS): { view: View; how: string } {
  const m = /camera\(([^)]*)\)/.exec(reply);
  if (!m) throw new Error(`no camera(...) line in "${reply.trim().slice(0, 80)}"`);
  const args = m[1].split(/[,\s]+/).map((a) => a.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  let view: View;
  let how: string;
  if (args.length === 4 && args.every((a) => Number.isFinite(Number(a)))) {
    const [x, y, w, h] = args.map(Number);
    view = fitView({ x, y, w, h }, 0);
    how = `rectangle ${args.join(" ")}`;
  } else {
    const shapes = args.map((id) => scene.get(id));
    const missing = args.filter((_, i) => !shapes[i]);
    if (missing.length) throw new Error(`no shape ${missing.join(", ")}`);
    view = fitView(union(shapes.map((s) => s!.box)), t["camera.padFrac"]);
    how = `framing ${args.join(", ")}`;
  }
  const maxW = Math.max(boardBounds(scene).w, boardBounds(scene).h * ASPECT) * 3;
  const w = Math.max(t["camera.minViewPx"], Math.min(maxW, view.w));
  const [cx, cy] = centerOf(view);
  return { view: { x: cx - w / 2, y: cy - w / ASPECT / 2, w, h: w / ASPECT }, how };
}

export type CameraMove = { view: View; how: string; reply: string; prompt: CameraPrompt; stats: ModelStats };

export async function moveCamera(said: string, current: View, scene: Scene, t: Tuning = DEFAULTS, parent?: TraceContext): Promise<CameraMove> {
  return span("move the camera", parent, async (ctx) => {
    const prompt = await cameraPrompt(said, current, scene, t, ctx);
    const { text, stats } = await callModel({ model: modelOf(t["camera.model"]), system: prompt.system, user: prompt.user, images: prompt.images, from: "camera" }, undefined, undefined, ctx);
    return { ...parseCamera(text, scene, t), reply: text, prompt, stats };
  });
}

/** A hand-written case: where the camera starts, what they say, what a right answer looks like. */
export type CameraCase = {
  said: string;
  /** A page id (its top, full width), "all" (every page), or a rectangle [x, y, w, h]. */
  from: string | number[];
  expect: {
    zoom?: "in" | "out" | "same";
    /** At most this many times wider than before (for "a little"). */
    maxOut?: number;
    direction?: "left" | "right" | "up" | "down";
    /** Shown whole: at least 80% of each inside. */
    shows?: string[];
    /** Shown whole and big: its larger side at least 35% of the view's. */
    focus?: string;
    /** Shown, and near the middle. */
    centerOn?: string;
    /** On this page: the view's middle is on it and it's at least half the view across. */
    page?: string;
  };
};

/** Where a case starts. */
export function startView(c: { from: CameraCase["from"] }, scene: Scene): View {
  if (Array.isArray(c.from)) return { x: c.from[0], y: c.from[1], w: c.from[2], h: c.from[2] / ASPECT };
  if (c.from === "all") return fitView(union(pagesOf(scene).map((p) => p.box)), 0.03);
  const p = scene.get(c.from);
  if (!p) throw new Error(`no page ${c.from}`);
  return pageTop(p);
}

/** Whether a view answers the case, with each check's verdict. */
export function scoreCamera(c: CameraCase, from: View, to: View, scene: Scene): { ok: boolean; checks: string[] } {
  const e = c.expect;
  const checks: string[] = [];
  const say = (ok: boolean, what: string) => (checks.push(`${ok ? "✓" : "✗"} ${what}`), ok);
  let ok = true;
  const ratio = to.w / from.w;
  if (e.zoom === "in") ok = say(ratio < 0.8, `zoomed in (×${ratio.toFixed(2)} as wide)`) && ok;
  if (e.zoom === "out") ok = say(ratio > 1.25, `zoomed out (×${ratio.toFixed(2)} as wide)`) && ok;
  if (e.zoom === "same") ok = say(ratio >= 0.8 && ratio <= 1.25, `same zoom (×${ratio.toFixed(2)})`) && ok;
  if (e.maxOut) ok = say(ratio <= e.maxOut, `not too far out (×${ratio.toFixed(2)} ≤ ${e.maxOut})`) && ok;
  if (e.direction) {
    const [fx, fy] = centerOf(from);
    const [tx, ty] = centerOf(to);
    const dx = (tx - fx) / from.w;
    const dy = (ty - fy) / from.h;
    const along = { right: dx, left: -dx, down: dy, up: -dy }[e.direction];
    const across = e.direction === "left" || e.direction === "right" ? Math.abs(dy) : Math.abs(dx);
    ok = say(along >= 0.1 && across <= 0.15, `moved ${e.direction} (${Math.round(along * 100)}% of the screen, ${Math.round(across * 100)}% sideways)`) && ok;
  }
  const shape = (id: string) => scene.get(id)!;
  for (const id of e.shows ?? []) ok = say(insideShare(shape(id).box, to) >= 0.8, `shows ${id} (${Math.round(insideShare(shape(id).box, to) * 100)}%)`) && ok;
  if (e.focus) {
    const b = norm(shape(e.focus).box);
    const big = Math.max(b.w / to.w, b.h / to.h);
    ok = say(insideShare(b, to) >= 0.8 && big >= 0.35, `close on ${e.focus} (${Math.round(insideShare(b, to) * 100)}% shown, ${Math.round(big * 100)}% of the view)`) && ok;
  }
  if (e.centerOn) {
    const b = norm(shape(e.centerOn).box);
    const [bx, by] = centerOf(b);
    const [tx, ty] = centerOf(to);
    const off = Math.hypot(bx - tx, by - ty) / to.w;
    ok = say(insideShare(b, to) >= 0.8 && off <= 0.15, `centred on ${e.centerOn} (${Math.round(off * 100)}% off centre)`) && ok;
  }
  if (e.page) {
    const p = shape(e.page).box;
    const [tx, ty] = centerOf(to);
    const on = tx >= p.x && tx <= p.x + p.w && ty >= p.y && ty <= p.y + p.h;
    ok = say(on && p.w >= to.w * 0.5, `on page ${e.page} (${Math.round((p.w / to.w) * 100)}% of the view across)`) && ok;
  }
  return { ok, checks };
}
