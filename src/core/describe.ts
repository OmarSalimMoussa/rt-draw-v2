// The detailed id map: a small vision model looks at each shape's crop (and the
// whole page, for context) and writes what it is, what it's for and where it
// sits. Words like "the photo of me" find shapes through these descriptions,
// so they're refreshed in the background whenever a shape changes.
import { type ModelStats, callModel, modelOf } from "./model.ts";
import type { Scene } from "./scene.ts";
import { promptOf } from "./prompts.ts";
import { takeShot } from "./shot.ts";
import { DEFAULTS, type Tuning, tune } from "./tuning.ts";

export type Crop = { id: string; dataUrl: string; w: number; h: number };
export type Described = {
  id: string;
  /** The model's description, or "" when it gave none. */
  text: string;
  words: number;
  ok: boolean;
  why: string;
  features: Record<string, number | string | boolean>;
};
export type DescribeRun = { results: Described[]; calls: ModelStats[]; ms: number; crops: Crop[]; contextBytes: number };

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const fill = (system: string, t: Tuning) => system.replace("{min}", String(t["describe.minWords"])).replace("{max}", String(t["describe.maxWords"]));

const loadImage = async (url: string) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
};

/**
 * The whole page (with id tags, for context) and one crop per shape, padded by
 * describe.cropPadPx and scaled down so the longer side is at most describe.cropMaxPx.
 */
export async function cropShapes(scene: Scene, t: Tuning = DEFAULTS): Promise<{ context: string; crops: Crop[] }> {
  const context = (await takeShot(scene, [], tune({ "shot.gridCellPx": 0 }, t), { inkNumbers: false })).dataUrl;
  // Crops come from a clean full-size picture: no tags, no grid, lossless.
  const full = await loadImage((await takeShot(scene, [], tune({ "shot.scale": 1, "shot.tagPx": 0, "shot.gridCellPx": 0, "shot.jpegQuality": 1 }, t), { inkNumbers: false })).dataUrl);
  const pad = t["describe.cropPadPx"];
  const max = t["describe.cropMaxPx"];
  const crops = scene.stacked().map((s) => {
    const x = Math.max(0, Math.floor(s.box.x - pad));
    const y = Math.max(0, Math.floor(s.box.y - pad));
    const w = Math.min(scene.width, Math.ceil(s.box.x + s.box.w + pad)) - x;
    const h = Math.min(scene.height, Math.ceil(s.box.y + s.box.h + pad)) - y;
    const k = Math.min(1, max / Math.max(w, h, 1));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext("2d")!.drawImage(full, x, y, w, h, 0, 0, c.width, c.height);
    return { id: s.id, dataUrl: c.toDataURL("image/jpeg", 0.85), w: c.width, h: c.height };
  });
  return { context, crops };
}

/** The first JSON object in a reply, forgiving code fences and chatter around it. */
export function parseMap(reply: string): Record<string, string> {
  const a = reply.indexOf("{");
  const b = reply.lastIndexOf("}");
  if (a < 0 || b <= a) return {};
  try {
    const o = JSON.parse(reply.slice(a, b + 1)) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, (v as string).trim()]));
  } catch {
    return {};
  }
}

/** Checks one description against the word limits; the counts go in features for logs and tuning. */
export function check(id: string, text: string | undefined, t: Tuning): Described {
  const n = text ? words(text) : 0;
  const min = t["describe.minWords"];
  const max = t["describe.maxWords"];
  const why = !text ? "no description for this id" : n < min ? `too short (${n} < ${min} words)` : n > max ? `too long (${n} > ${max} words)` : "within limits";
  return { id, text: text ?? "", words: n, ok: !!text && n >= min && n <= max, why, features: { words: n, missing: !text, tooShort: !!text && n < min, tooLong: n > max, min, max } };
}

/**
 * Describes every shape: one call with all crops (describe.batch = 1) or one per
 * shape. onCall reports each finished call; onText streams the current reply.
 */
export async function describeAll(scene: Scene, t: Tuning, on: { onCall?: (s: ModelStats) => void; onText?: (soFar: string) => void } = {}): Promise<DescribeRun> {
  const t0 = performance.now();
  const model = modelOf(t["describe.model"]);
  const { context, crops } = await cropShapes(scene, t);
  const prompt = promptOf("describe", t);
  const calls: ModelStats[] = [];
  const got: Record<string, string> = {};
  const run = async (system: string, user: string, images: string[]) => {
    const { text, stats } = await callModel({ model, system, user, images, from: "describe" }, (_, soFar) => on.onText?.(soFar));
    calls.push(stats);
    on.onCall?.(stats);
    Object.assign(got, parseMap(text));
  };
  if (t["describe.batch"] >= 1) {
    const lines = crops.map((c, i) => `Image ${i + 2}: crop ${i + 1}, id ${c.id}`);
    await run(fill(prompt.batch, t), `Image 1 is the whole page.\n${lines.join("\n")}\n\nIds to describe: ${crops.map((c) => c.id).join(", ")}`, [context, ...crops.map((c) => c.dataUrl)]);
  } else {
    for (const c of crops) await run(fill(prompt.one, t), `Image 1 is the whole page; image 2 is the crop of the shape with id ${c.id}. Describe ${c.id}.`, [context, c.dataUrl]);
  }
  return { results: crops.map((c) => check(c.id, got[c.id], t)), calls, ms: Math.round(performance.now() - t0), crops, contextBytes: context.length };
}
