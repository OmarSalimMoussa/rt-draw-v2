// One send, from Enter to the last picture: the product's orchestration of a press
// of Enter, shared by the Drawing model playground and the eval's bridge
// (evals/bridge), so the eval measures exactly what the playground does. Product
// code: the loop may improve it (pipelining the resolver, pictures and drawing call).
import type { View } from "./board.ts";
import { type OpResult, type Prompt, type SendResult, buildPrompt, run } from "./draw.ts";
import type { Stroke } from "./ink.ts";
import type { Word } from "./link.ts";
import { pictureFiller } from "./picture.ts";
import type { Scene } from "./scene.ts";
import { type TraceContext, spanSync } from "./trace.ts";
import type { Tuning } from "./tuning.ts";

/** What the person gave this send: their ink, and their words spoken (timed) or typed (a string). */
export type SendInput = { strokes: Stroke[]; words: Word[] | string };

export type SendHooks = {
  /** The prompt is built and the drawing call is about to start. */
  onPrompt?: (p: Prompt) => void;
  /** After each op line lands, before the redraw. */
  onOp?: (r: OpResult) => void;
  /** The drawing model's reply is done; pictures may still be filling in. */
  onReply?: (r: SendResult) => void;
  /** Redraws the scene: after each op, as each picture fills in, and once at the end. */
  draw?: () => void;
  /** Moves the camera; camera(...) ops glide over camera.easeMs. */
  setView?: (v: View, ms?: number) => Promise<void>;
  signal?: AbortSignal;
  parent?: TraceContext;
};

export type Sent = { prompt: Prompt; result: SendResult; pics?: { drawn: number; failed: string[]; ms: number } };

/** Applies one send to `scene`: the prompt (marks, resolver, pictures, site map), the drawing call's ops as they land, the pictures they need. */
export async function send(scene: Scene, input: SendInput, t: Tuning, hooks: SendHooks = {}, camera?: View): Promise<Sent> {
  const { draw = () => {}, signal, parent } = hooks;
  // Made first, so the picture processes start while the prompt is built; each picture starts as its drawing() op lands.
  const pictures = t["draw.fillPictures"] ? pictureFiller(scene, t, draw, signal, parent) : undefined;
  const prompt = await buildPrompt(scene, input.strokes, input.words, t, parent, camera);
  hooks.onPrompt?.(prompt);
  let gliding: Promise<void> = Promise.resolve();
  const result = await run(scene, prompt, t, (r) => {
    hooks.onOp?.(r);
    if (r.camera && hooks.setView) gliding = hooks.setView(r.camera, t["camera.easeMs"]);
    draw();
    pictures?.kick();
  }, undefined, signal, parent);
  hooks.onReply?.(result);
  const pics = await pictures?.finish();
  spanSync("final redraw", parent, () => draw());
  // The send ends once the screen has arrived where the last camera op sent it.
  await gliding;
  return { prompt, result, pics };
}
