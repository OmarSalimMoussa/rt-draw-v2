// The canvas: free-form shapes stacked in layers, like a slide. Nothing lays
// anything out; a shape is drawn exactly where its box says.

import type { El } from "./picture.ts";
export type Box = { x: number; y: number; w: number; h: number };
/** "frame" is a page (or app screen) on the board: its text is its name, shown above it, and the shapes inside it are its content. */
export type Kind = "rect" | "round" | "circle" | "pill" | "line" | "arrow" | "frame";
export const KINDS: Kind[] = ["rect", "round", "circle", "pill", "line", "arrow", "frame"];

export type Style = {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** 0-1 for the whole shape. */
  opacity?: number;
  /** 0-1: washes out and dims the picture inside, not the box. */
  fade?: number;
  roughness?: number;
  fillStyle?: "solid" | "hachure" | "cross-hatch" | "zigzag" | "dots";
};

export type TextStyle = {
  words: string;
  size?: number;
  color?: string;
  align?: "left" | "center" | "right";
  weight?: "normal" | "bold";
};

export type Shape = {
  id: string;
  kind: Kind;
  box: Box;
  /**
   * What this shape is and what it's for, in full: "round photo of the owner, a smiling Black
   * man dressed as a clown, top of the main column; the headline sits over it". Required:
   * it's how words like "the photo of me" find this shape.
   */
  description: string;
  style: Style;
  text?: TextStyle;
  /** What the picture inside shows; drawn later by the picture model. */
  drawing?: string;
  /** The doodle the picture model drew for a `drawing`, in its own w × h space (shown scaled to fit). Stale once `drawing` changes. */
  picture?: { subject: string; w: number; h: number; els: El[]; done: boolean };
};

export class Scene {
  readonly width: number;
  readonly height: number;
  shapes = new Map<string, Shape>();
  /** Back to front. */
  order: string[] = [];
  groups = new Map<string, string[]>();

  constructor(width = 1280, height = 800) {
    this.width = width;
    this.height = height;
  }

  get(id: string) {
    return this.shapes.get(id);
  }

  /** Shapes back to front. */
  stacked(): Shape[] {
    return this.order.map((id) => this.shapes.get(id)!);
  }

  add(shape: Shape) {
    this.shapes.set(shape.id, shape);
    this.order.push(shape.id);
  }

  remove(id: string) {
    for (const member of this.groups.get(id) ?? []) this.remove(member);
    this.groups.delete(id);
    this.shapes.delete(id);
    this.order = this.order.filter((o) => o !== id);
    for (const [g, members] of this.groups) this.groups.set(g, members.filter((m) => m !== id));
  }

  /** Front, back, or right above / below another shape. */
  layer(id: string, where: "front" | "back" | { above: string } | { below: string }) {
    const rest = this.order.filter((o) => o !== id);
    if (where === "front") rest.push(id);
    else if (where === "back") rest.unshift(id);
    else {
      const other = "above" in where ? where.above : where.below;
      const i = rest.indexOf(other);
      if (i < 0) throw new Error(`no shape ${other}`);
      rest.splice("above" in where ? i + 1 : i, 0, id);
    }
    this.order = rest;
  }

  /** Moves a shape, or a group by the same offset for all its members. */
  move(id: string, box: Partial<Box>) {
    const members = this.groups.get(id);
    if (!members) {
      const s = this.shapes.get(id);
      if (!s) throw new Error(`no shape ${id}`);
      s.box = { ...s.box, ...box };
      return;
    }
    const b = this.groupBox(id);
    const dx = (box.x ?? b.x) - b.x;
    const dy = (box.y ?? b.y) - b.y;
    for (const m of members) {
      const s = this.shapes.get(m);
      if (s) s.box = { ...s.box, x: s.box.x + dx, y: s.box.y + dy };
    }
  }

  groupBox(id: string): Box {
    const boxes = (this.groups.get(id) ?? []).map((m) => this.shapes.get(m)?.box).filter((b): b is Box => !!b);
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
  }

  /** v: the format, so a saved scene (the eval's banked before-scenes) is never read by a scene.ts that means something else by it. */
  toJSON(): SceneJSON {
    return { v: 1, width: this.width, height: this.height, shapes: this.stacked(), groups: Object.fromEntries(this.groups) };
  }

  /** The scene toJSON() saved, doodles and groups included. */
  static fromJSON(j: SceneJSON): Scene {
    if (j.v !== 1) throw new Error(`not a scene this code can read (v ${j.v})`);
    const scene = new Scene(j.width, j.height);
    for (const s of structuredClone(j.shapes)) scene.add(s);
    for (const [g, members] of Object.entries(j.groups)) scene.groups.set(g, [...members]);
    return scene;
  }
}

export type SceneJSON = { v: 1; width: number; height: number; shapes: Shape[]; groups: Record<string, string[]> };
