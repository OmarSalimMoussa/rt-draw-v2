// The model's language: one op per line, each a visible change.
//   shape(id, kind?, box?, "description", style...)
//                                      add, or change only what's given; a new shape
//                                      needs a full description (what it is, what it's for)
//   text(id, "words", style...)        the text inside a shape
//   drawing(id, "what it shows")       a picture inside a shape
//   layer(id, front | back | above:other | below:other)
//   move(id, box)                      a shape, or a group by the same offset
//   group(id, [a, b, ...])
//   remove(id)
// A box is pixels "x y w h" or grid cells "C2-J7" (columns A, B, ... rows 1, 2, ...).
// Style args are key:value (fill:#fde, stroke:none, opacity:0.6, size:xl, color:white).
import { type Box, KINDS, type Kind, Scene, type Style, type TextStyle } from "./scene.ts";

export type Arg = { key?: string; value: string; quoted: boolean; list?: string[] };
export type Op = { name: string; args: Arg[]; line: string };
export type Parsed = { ok: true; op: Op } | { ok: false; line: string; error: string } | { ok: "skip" };

export const NAMES = ["shape", "text", "drawing", "layer", "move", "group", "remove"];
export const DEFAULT_CELL = 40;
/** A description shorter than this says too little to find the shape by later. */
export const MIN_DESCRIPTION_WORDS = 6;

function checkDescription(d: string) {
  const words = d.trim().split(/\s+/).filter(Boolean).length;
  if (words < MIN_DESCRIPTION_WORDS) throw new Error(`description too short (${words} words, need ${MIN_DESCRIPTION_WORDS}+): say what it is and what it's for`);
  return d.trim();
}

/** Splits "a, \"b, c\", [d, e], key:val" at top-level commas. */
function splitArgs(s: string): Arg[] {
  const args: Arg[] = [];
  let cur = "";
  let quoted = false;
  let key: string | undefined;
  let inQuote = false;
  let depth = 0;
  const flush = () => {
    if (quoted) args.push({ key, value: cur, quoted: true });
    else if (cur.trim()) args.push(toArg(cur.trim()));
    cur = "";
    quoted = false;
    key = undefined;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === "\\" && i + 1 < s.length) cur += s[++i];
      else if (c === '"') inQuote = false;
      else cur += c;
    } else if (c === '"') {
      inQuote = true;
      quoted = true;
      // A quoted arg may follow a key (color:"#fff"); colons inside the quotes are just words.
      const k = /^([a-zA-Z][\w-]*):$/.exec(cur.trim());
      key = k?.[1];
      cur = "";
    } else if (c === "[") {
      depth++;
      cur += c;
    } else if (c === "]") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) flush();
    else cur += c;
  }
  if (inQuote) throw new Error("unclosed quote");
  flush();
  return args;
}

/** An unquoted arg: a [list], key:value, or a bare value (an id, a kind, a box, a color). */
function toArg(raw: string): Arg {
  if (raw.startsWith("[") && raw.endsWith("]")) return { value: raw, quoted: false, list: raw.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean) };
  const m = /^([a-zA-Z][\w-]*):(.*)$/s.exec(raw);
  if (m) return { key: m[1], value: m[2].trim(), quoted: false };
  return { value: raw, quoted: false };
}

export function parseLine(raw: string): Parsed {
  const line = raw.trim();
  if (!line || line.startsWith("#") || line.startsWith("//")) return { ok: "skip" };
  const m = /^([a-z]+)\s*\((.*)\)\s*;?$/s.exec(line);
  if (!m) return { ok: false, line, error: "not an op: expected name(args)" };
  if (!NAMES.includes(m[1])) return { ok: false, line, error: `unknown op "${m[1]}"` };
  try {
    return { ok: true, op: { name: m[1], args: splitArgs(m[2]), line } };
  } catch (e) {
    return { ok: false, line, error: (e as Error).message };
  }
}

/** Feeds model text in any size of chunks and hands back each op as soon as its line is complete. */
export class OpStream {
  private buf = "";
  push(chunk: string): Parsed[] {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    return lines.map(parseLine).filter((p) => p.ok !== "skip");
  }
  /** The last line, if the reply ended without a newline. A cut-off line comes back as an error. */
  end(): Parsed[] {
    const rest = this.buf;
    this.buf = "";
    const p = parseLine(rest);
    return p.ok === "skip" ? [] : [p];
  }
}

const colIndex = (letters: string) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
export const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

export function parseBox(s: string, cell = DEFAULT_CELL): Box {
  const cells = /^([A-Za-z]+)(\d+)\s*-\s*([A-Za-z]+)(\d+)$/.exec(s.trim());
  if (cells) {
    const [c1, c2] = [colIndex(cells[1]), colIndex(cells[3])].sort((a, b) => a - b);
    const [r1, r2] = [Number(cells[2]) - 1, Number(cells[4]) - 1].sort((a, b) => a - b);
    return { x: c1 * cell, y: r1 * cell, w: (c2 - c1 + 1) * cell, h: (r2 - r1 + 1) * cell };
  }
  const n = s.trim().split(/\s+/).map(Number);
  if (n.length === 4 && n.every(Number.isFinite)) return { x: n[0], y: n[1], w: n[2], h: n[3] };
  throw new Error(`bad box "${s}": use "x y w h" or cells like C2-J7`);
}

const SIZES: Record<string, number> = { xs: 12, s: 16, m: 20, l: 28, xl: 40, xxl: 56 };
const COLORS: Record<string, string> = { white: "#ffffff", black: "#1e1e1e", none: "transparent" };
const color = (v: string) => COLORS[v] ?? v;

function styleFrom(args: Arg[], into: Style) {
  for (const a of args) {
    if (!a.key) continue;
    const v = a.value;
    switch (a.key) {
      case "fill": into.fill = color(v); break;
      case "stroke": into.stroke = color(v); break;
      case "strokeWidth": into.strokeWidth = Number(v); break;
      case "opacity": into.opacity = Number(v); break;
      case "fade": into.fade = Number(v); break;
      case "roughness": into.roughness = Number(v); break;
      case "fillStyle": into.fillStyle = v as Style["fillStyle"]; break;
    }
  }
}

function textFrom(args: Arg[], into: TextStyle) {
  for (const a of args) {
    if (!a.key) continue;
    if (a.key === "size") into.size = SIZES[a.value] ?? Number(a.value);
    else if (a.key === "color") into.color = color(a.value);
    else if (a.key === "align") into.align = a.value as TextStyle["align"];
    else if (a.key === "weight") into.weight = a.value as TextStyle["weight"];
  }
}

const need = (scene: Scene, id: string) => {
  const s = scene.get(id);
  if (!s) throw new Error(`no shape "${id}"`);
  return s;
};

/** Applies one op. Throws with a short reason when it can't. */
export function applyOp(scene: Scene, op: Op, cell = DEFAULT_CELL) {
  const pos = op.args.filter((a) => !a.key);
  const id = pos[0]?.value;
  if (!id) throw new Error("missing id");
  switch (op.name) {
    case "shape": {
      const rest = pos.slice(1);
      const descArg = rest.find((a) => a.quoted);
      const kindArg = rest.find((a) => !a.quoted && KINDS.includes(a.value as Kind));
      const boxArg = rest.find((a) => !a.quoted && a !== kindArg);
      const existing = scene.get(id);
      if (!existing) {
        if (!boxArg) throw new Error(`new shape "${id}" needs a box`);
        if (!descArg) throw new Error(`new shape "${id}" needs a "description" of what it is and what it's for`);
        const shape = { id, kind: (kindArg?.value as Kind) ?? "rect", box: parseBox(boxArg.value, cell), description: checkDescription(descArg.value), style: {} };
        styleFrom(op.args, shape.style);
        scene.add(shape);
      } else {
        // Check everything before changing anything, so a rejected line leaves the shape as it was.
        const description = descArg ? checkDescription(descArg.value) : undefined;
        const box = boxArg ? parseBox(boxArg.value, cell) : undefined;
        if (kindArg) existing.kind = kindArg.value as Kind;
        if (box) existing.box = box;
        if (description) existing.description = description;
        styleFrom(op.args, existing.style);
      }
      return;
    }
    case "text": {
      const s = need(scene, id);
      const words = pos[1];
      s.text = { ...(s.text ?? { words: "" }), ...(words ? { words: words.value } : {}) };
      textFrom(op.args, s.text);
      return;
    }
    case "drawing": {
      const s = need(scene, id);
      if (!pos[1]) throw new Error("drawing needs a description");
      s.drawing = pos[1].value;
      styleFrom(op.args, s.style);
      return;
    }
    case "layer": {
      need(scene, id);
      const where = op.args[1];
      if (!where) throw new Error("layer needs front, back, above:id or below:id");
      if (where.key === "above") return scene.layer(id, { above: where.value });
      if (where.key === "below") return scene.layer(id, { below: where.value });
      if (where.value === "front" || where.value === "back") return scene.layer(id, where.value);
      throw new Error(`bad layer "${where.value}"`);
    }
    case "move": {
      if (!scene.groups.has(id)) need(scene, id);
      if (!pos[1]) throw new Error("move needs a box");
      return scene.move(id, parseBox(pos[1].value, cell));
    }
    case "group": {
      const list = op.args.find((a) => a.list)?.list;
      if (!list?.length) throw new Error("group needs [ids]");
      for (const m of list) need(scene, m);
      scene.groups.set(id, list);
      return;
    }
    case "remove": {
      if (!scene.groups.has(id)) need(scene, id);
      return scene.remove(id);
    }
  }
}

/** Runs a whole script; returns the scene and any lines that failed. */
export function runScript(script: string, scene = new Scene(), cell = DEFAULT_CELL) {
  const errors: { line: string; error: string }[] = [];
  const s = new OpStream();
  for (const p of [...s.push(script), ...s.end()]) {
    if (p.ok === "skip") continue;
    if (!p.ok) errors.push({ line: p.line, error: p.error });
    else {
      try {
        applyOp(scene, p.op, cell);
      } catch (e) {
        errors.push({ line: p.op.line, error: (e as Error).message });
      }
    }
  }
  return { scene, errors };
}
