// The model's language: one op per line, each a visible change.
//   shape(id, kind?, box?, "description", style...)
//                                      add, or change only what's given; a new shape
//                                      needs a full description (what it is, what it's for);
//                                      link:<page id> | link:none and button:yes | button:no
//                                      say what a visitor can click and where it goes
//   text(id, "words", style...)        the text inside a shape
//   drawing(id, "what it shows")       a picture inside a shape
//   illustration(id, box, "what it shows")
//                                      a picture as a shape of its own: no box drawn around it
//   layer(id, front | back | above:other | below:other)
//   move(id, box)                      a shape, or a group by the same offset
//   group(id, [a, b, ...])
//   remove(id)
//   camera(x y w h) | camera(id, ...)  moves the screen on a board (the caller does it, not the scene)
// A box is pixels "x y w h" or grid cells "C2-J7" (columns A, B, ... rows 1, 2, ...).
// Style args are key:value (fill:#fde, stroke:none, opacity:0.6, size:xl, color:white).
// An op naming a shape a later line makes waits for that line (ops.waitForShape).
import { type Box, KINDS, type Kind, NoShape, Scene, type Shape, type Style, type TextStyle } from "./scene.ts";
import { DEFAULTS, type Tuning } from "./tuning.ts";

export type Arg = { key?: string; value: string; quoted: boolean; list?: string[] };
export type Op = { name: string; args: Arg[]; line: string };
export type Parsed = { ok: true; op: Op } | { ok: false; line: string; error: string } | { ok: "skip" };

export const NAMES = ["shape", "text", "drawing", "illustration", "layer", "move", "group", "remove", "camera"];
export const DEFAULT_CELL = DEFAULTS["ops.cellPx"];

/**
 * A description shorter than ops.minDescriptionWords says too little to find the shape by later.
 * It never costs the shape: a new shape keeps it (better than none), an edit keeps the one it had.
 */
const isShort = (d: string, t: Tuning) => d.trim().split(/\s+/).filter(Boolean).length < t["ops.minDescriptionWords"];

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
      // \n is a line break (the model writes one so); any other escaped character is itself (\" \\).
      if (c === "\\" && i + 1 < s.length) cur += s[++i] === "n" ? "\n" : s[i];
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
  /** The line still being written. */
  pending(): string {
    return this.buf;
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

/** Exactly a box: four numbers ("x y w h") or a cell range ("C2-J7"). */
export const looksLikeBox = (s: string) => /^\s*-?\d+(\.\d+)?(\s+-?\d+(\.\d+)?){3}\s*$/.test(s) || /^\s*[A-Za-z]+\d+\s*-\s*[A-Za-z]+\d+\s*$/.test(s);

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

/** link: and button:, checked before anything changes; undefined where the line doesn't say. */
function clickFrom(args: Arg[]): { link?: string | null; button?: boolean } {
  const out: { link?: string | null; button?: boolean } = {};
  for (const a of args) {
    if (a.key === "link") out.link = a.value === "none" ? null : a.value;
    else if (a.key === "button") {
      if (a.value !== "yes" && a.value !== "no") throw new Error(`button takes yes or no, not "${a.value}"`);
      out.button = a.value === "yes";
    }
  }
  return out;
}

function setClick(s: Shape, c: { link?: string | null; button?: boolean }) {
  if (c.link === null) delete s.link;
  else if (c.link !== undefined) s.link = c.link;
  if (c.button !== undefined) s.button = c.button;
}

const need = (scene: Scene, id: string) => {
  const s = scene.get(id);
  if (!s) throw new NoShape(id);
  return s;
};

/**
 * The model sometimes writes a page's name where its id goes ("Home" for the page with id page):
 * an id that is no shape or group but is a page's name, in any case, means that page. Not for a
 * shape() of another kind, which makes a new shape of that id.
 */
function idOf(scene: Scene, op: Op, id: string) {
  if (scene.get(id) || scene.groups.has(id)) return id;
  if (op.name === "shape" && op.args.some((a) => !a.key && !a.quoted && KINDS.includes(a.value as Kind) && a.value !== "frame")) return id;
  // An illustration is never a page: a new one named like a page ("cart" on the Cart page) is a new shape.
  if (op.name === "illustration") return id;
  const name = id.toLowerCase();
  return scene.stacked().find((s) => s.kind === "frame" && s.text?.words.trim().toLowerCase() === name)?.id ?? id;
}

/**
 * A shape() line still being written whose id, kind, box and styles are complete and whose description quote is open
 * (ops.earlyShape), as an op with the id for a stand-in description. Only a shape the line would add: an existing id,
 * a group or a page's name gives nothing, since those can't be taken back by removing the shape.
 */
export function earlyShape(scene: Scene, pending: string, atBox = false, own?: string): Op | undefined {
  let inner: string | undefined;
  if (atBox) {
    // ops.earlyAtBox: everything up to the last comma outside quotes is closed args; the open one after it is left out.
    const head = /^\s*shape\s*\(/.exec(pending);
    if (!head) return undefined;
    let inQuote = false;
    let last = -1;
    for (let i = head[0].length; i < pending.length; i++) {
      const c = pending[i];
      if (inQuote) {
        if (c === "\\") i++;
        else if (c === '"') inQuote = false;
      } else if (c === '"') inQuote = true;
      else if (c === ",") last = i;
      else if (c === ")") return undefined;
    }
    if (last < 0) return undefined;
    inner = pending.slice(head[0].length, last);
  } else inner = /^\s*shape\s*\(([^"]*),\s*"[^"]*$/.exec(pending)?.[1];
  if (inner === undefined) return undefined;
  let args: Arg[];
  try {
    args = splitArgs(inner);
  } catch {
    return undefined;
  }
  const pos = args.filter((a) => !a.key);
  const [id, ...rest] = pos.map((a) => a.value);
  if (!id || (scene.get(id) && id !== own) || scene.groups.has(id)) return undefined;
  if (!rest.some((v) => KINDS.includes(v as Kind)) || !rest.some(looksLikeBox)) return undefined;
  const op: Op = { name: "shape", args: [...args, { value: id, quoted: true }], line: atBox ? `shape(${inner})` : pending };
  return idOf(scene, op, id) === id ? op : undefined;
}

/** Applies one op. Throws with a short reason when it can't. */
export function applyOp(scene: Scene, op: Op, t: Tuning = DEFAULTS) {
  const cell = t["ops.cellPx"];
  if (op.name === "camera") throw new Error("camera(...) moves the screen: only a send on a board can");
  const pos = op.args.filter((a) => !a.key);
  const id = pos[0]?.value && idOf(scene, op, pos[0].value);
  if (!id) throw new Error("missing id");
  switch (op.name) {
    case "shape": {
      const rest = pos.slice(1);
      // A box written in quotes ("35 550 130 130") is still the box: no description looks like one.
      const descArg = rest.find((a) => a.quoted && !looksLikeBox(a.value));
      const kindArg = rest.find((a) => !a.quoted && KINDS.includes(a.value as Kind));
      const boxArg = rest.find((a) => a !== kindArg && a !== descArg && (!a.quoted || looksLikeBox(a.value)));
      const existing = scene.get(id);
      // Read before the style: styleFrom ignores keys it doesn't know.
      const click = clickFrom(op.args);
      if (!existing) {
        if (!boxArg) throw new Error(`new shape "${id}" needs a box`);
        if (!descArg) throw new Error(`new shape "${id}" needs a "description" of what it is and what it's for`);
        const shape: Shape = { id, kind: (kindArg?.value as Kind) ?? "rect", box: parseBox(boxArg.value, cell), description: descArg.value.trim(), style: {} };
        styleFrom(op.args, shape.style);
        setClick(shape, click);
        if (shape.kind === "frame" && !scene.stacked().some((s) => s.kind === "frame")) scene.home = id;
        scene.add(shape);
      } else {
        // Check everything before changing anything, so a rejected line leaves the shape as it was.
        const description = descArg && !isShort(descArg.value, t) ? descArg.value.trim() : undefined;
        const box = boxArg ? parseBox(boxArg.value, cell) : undefined;
        if (kindArg) existing.kind = kindArg.value as Kind;
        if (box) existing.box = box;
        if (description) existing.description = description;
        styleFrom(op.args, existing.style);
        setClick(existing, click);
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
    case "illustration": {
      // One line for a picture that is its own shape: what it shows is both its description and its picture, and
      // its box is never drawn (no stroke, no fill), whatever render.pictureBox says. On an existing shape it becomes
      // one: a styled card turned illustration loses its box. A kind written out of shape() habit is ignored.
      const descArg = pos.slice(1).find((a) => a.quoted && !looksLikeBox(a.value));
      const boxArg = pos.slice(1).find((a) => a !== descArg && looksLikeBox(a.value));
      if (!descArg?.value.trim()) throw new Error(`illustration "${id}" needs a "description" of what it shows`);
      const existing = scene.get(id);
      if (existing?.kind === "frame") throw new Error(`"${id}" is a page: an illustration goes on it, under its own id`);
      const box = boxArg ? parseBox(boxArg.value, cell) : existing?.box;
      if (!box) throw new Error(`new illustration "${id}" needs a box`);
      const what = descArg.value.trim();
      if (existing) {
        Object.assign(existing, { kind: "rect", box, drawing: what, ...(isShort(what, t) ? {} : { description: what }) });
        existing.style.stroke = "transparent";
        delete existing.style.fill;
      } else scene.add({ id, kind: "rect", box, description: what, drawing: what, style: { stroke: "transparent" } });
      styleFrom(op.args, scene.get(id)!.style);
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

/**
 * Op lines naming a shape the reply hasn't made yet (ops.waitForShape). The model writes a text() or layer() before
 * the shape() it's about; dropped, that change was lost. Each waits for its shape and lands right after the line that
 * makes it; what still waits when the reply ends fails then. A remove() never waits: it would delete the shape when
 * it came.
 */
export class Waiting {
  private held: { op: Op; id: string }[] = [];
  private on: boolean;
  constructor(on: boolean) {
    this.on = on;
  }

  /** Applies the op, or holds it. Returns every op that landed or failed now, in order: this one, then those it freed. */
  apply(scene: Scene, op: Op, t: Tuning): { op: Op; error?: string }[] {
    const out: { op: Op; error?: string }[] = [];
    // A held move() may wait for a group, not a shape.
    const made = (id: string) => !!scene.get(id) || scene.groups.has(id);
    const run = (o: Op) => {
      try {
        applyOp(scene, o, t);
        out.push({ op: o });
        return true;
      } catch (e) {
        if (this.on && e instanceof NoShape && o.name !== "remove" && !made(e.id)) this.held.push({ op: o, id: e.id });
        else out.push({ op: o, error: (e as Error).message });
        return false;
      }
    };
    // A freed op may make a shape another one waits for.
    const queue = [op];
    while (queue.length) {
      if (!run(queue.shift()!)) continue;
      const ready = this.held.filter((h) => made(h.id));
      this.held = this.held.filter((h) => !ready.includes(h));
      queue.push(...ready.map((h) => h.op));
    }
    return out;
  }

  /** The reply ended: what still waits fails. */
  end(): { op: Op; error: string }[] {
    const out = this.held.map((h) => ({ op: h.op, error: `no shape "${h.id}"` }));
    this.held = [];
    return out;
  }
}

/** Runs a whole script; returns the scene and any lines that failed. */
export function runScript(script: string, scene = new Scene(), t: Tuning = DEFAULTS) {
  const errors: { line: string; error: string }[] = [];
  const s = new OpStream();
  const waiting = new Waiting(!!t["ops.waitForShape"]);
  for (const p of [...s.push(script), ...s.end()]) {
    if (p.ok === "skip") continue;
    if (!p.ok) errors.push({ line: p.line, error: p.error });
    else for (const a of waiting.apply(scene, p.op, t)) if (a.error) errors.push({ line: a.op.line, error: a.error });
  }
  for (const a of waiting.end()) errors.push({ line: a.op.line, error: a.error });
  return { scene, errors };
}
