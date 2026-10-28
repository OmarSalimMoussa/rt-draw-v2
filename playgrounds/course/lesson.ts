// The course both course players teach (fork/): its chapters and lines on the voice's timings, the words each line
// brings in, and the geometry for pointing at the stage drawings. The players differ in how they look and behave.
import "./fork/content.js";
import "./fork/chapters.js";
import "./fork/narration.js";
export { STAGE } from "./fork/stages.js";

export type Gloss = [group: string, term: string, line: string, plain: string, where: string, related: string[], chapter: string];
type Cap = [text: string, key?: string, pen?: string, also?: string[]];
type RawChapter = { id: string; part?: string; title: string; stage: string; terms: string[]; files?: string[]; caps: Cap[] };
declare global {
  interface Window {
    CHAPTERS: RawChapter[];
    NARRATION: Record<string, { duration: number; starts: number[] }>;
    GLOSSARY: Record<string, Gloss>;
    GLOSSARY_GROUPS: [string, string][];
  }
}
export type Line = { t: number; end: number; text: string; key?: string; pen?: string; also: string[] };
export type Chapter = RawChapter & { lines: Line[]; duration: number; reveal: Record<string, number> };
export type Box = { x: number; y: number; w: number; h: number };

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const fmtT = (s: number) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** This browser's memory for one player, under its own prefix; it may be unavailable. */
export function store(prefix: string) {
  return {
    get<T>(k: string, d: T): T { try { const v = localStorage.getItem(prefix + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k: string, v: unknown) { try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
}

export const G = window.GLOSSARY, GROUPS = window.GLOSSARY_GROUPS;
export const COURSE = "Eval Harness Course";
/** A line's key is pointed at, and its key and "also" keys revealed, this long after the line starts. */
export const POINT_DELAY = 0.3;
const WPS = 2.6; // a chapter without narration timings reads at about this many words a second

/* Lines start where the voice starts them. */
export const CH: Chapter[] = window.CHAPTERS.map((c) => {
  const n = window.NARRATION[c.id], voiced = !!n && n.starts.length === c.caps.length;
  let t = 0;
  const lines: Line[] = [], reveal: Record<string, number> = {};
  c.caps.forEach(([text, key, pen, also = []], j) => {
    if (voiced) t = n.starts[j];
    lines.push({ t, end: 0, text, key, pen, also });
    for (const k of key ? [key, ...also] : also) reveal[k] = t + POINT_DELAY;
    t += text.split(/\s+/).filter(Boolean).length / WPS + 0.4;
  });
  const duration = voiced ? n.duration : t + 0.8;
  lines.forEach((l, j) => { l.end = j + 1 < lines.length ? lines[j + 1].t : duration; });
  return { ...c, lines, duration, reveal };
});

/** A glossary word's names: "TTFD (time to first drawing)" goes by both. */
const namesOf = (k: string) => { const g = G[k]?.[1] ?? ""; return [g.replace(/\s*\(.*\)\s*/, ""), /\(([^)]+)\)/.exec(g)?.[1] ?? ""]; };

/** The line each of a chapter's words first comes up in: said by name, pointed at, or revealed. */
export function mentions(ch: Chapter): Record<string, number> {
  const first: Record<string, number> = {};
  const named = (text: string, k: string) => namesOf(k).some((n) => n.length >= 3 && text.toLowerCase().includes(n.toLowerCase()));
  ch.lines.forEach((l, j) => {
    for (const k of ch.terms) if (G[k] && !(k in first) && (l.key === k || l.also.includes(k) || named(l.text, k))) first[k] = j;
  });
  return first;
}

export const targetOf = (root: ParentNode, key?: string): HTMLElement | null => (key ? root.querySelector(`[data-k="${CSS.escape(key)}"]`) : null);
/** What a key's element is called on the stage: its bold title, else its label, else its first words. */
export function nameOf(root: ParentNode, key: string, max = 34): string {
  const el = targetOf(root, key);
  const s = (el?.querySelector("b")?.textContent || el?.querySelector(".lbl")?.textContent || el?.textContent || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 2).trimEnd() + "…" : s;
}
/** The line as HTML, with the words that name what it points at in <mark class="said">. */
export function saidHtml(line: Line, root: ParentNode): string {
  const text = line.text;
  if (!line.key) return esc(text);
  const lower = text.toLowerCase();
  for (const n of [nameOf(root, line.key), ...namesOf(line.key), line.pen ?? ""]) {
    const s = n.replace(/…$/, "").trim();
    const at = s.length >= 3 ? lower.indexOf(s.toLowerCase()) : -1;
    if (at >= 0) return esc(text.slice(0, at)) + `<mark class="said">${esc(text.slice(at, at + s.length))}</mark>` + esc(text.slice(at + s.length));
  }
  return esc(text);
}

/** An element's box in the stage's 960x600 units, `k` screen pixels to the unit. */
export function boxOf(el: Element, canvas: Element, k: number): Box {
  const cr = canvas.getBoundingClientRect(), r = el.getBoundingClientRect();
  return { x: (r.left - cr.left) / k, y: (r.top - cr.top) / k, w: r.width / k, h: r.height / k };
}

/* ---------- the red pen (forked from the course): a hand-drawn loop, and a label wherever it covers least ---------- */
function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function hash(s: string) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h; }
/** A loop around (cx, cy), a and b its half-width and half-height, going a little past where it started. */
export function loopPoints(cx: number, cy: number, a: number, b: number, seed: number): [number, number][] {
  const r = rng(seed), n = 70, turns = 1.1, start = -2.3 + r() * 0.5, e = 0.45, pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const th = start + (i / n) * turns * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th);
    const j = 1 + (r() - 0.5) * 0.03 + (i / n) * 0.05;
    pts.push([cx + a * j * Math.sign(c) * Math.abs(c) ** e, cy + b * j * Math.sign(s) * Math.abs(s) ** e]);
  }
  return pts;
}
export function loopPath(pts: [number, number][]) {
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  return d;
}
/** Where a pen label `tw` wide goes beside a loop: above, below, beside or at a corner, covering the least of the drawing. */
export function labelSpot(cx: number, cy: number, a: number, b: number, tw: number, target: Box, root: HTMLElement, canvas: Element, k: number): [number, number] {
  const cr = canvas.getBoundingClientRect();
  const box = (r: DOMRect) => [(r.left - cr.left) / k, (r.top - cr.top) / k, (r.right - cr.left) / k, (r.bottom - cr.top) / k];
  const ink: number[][] = [], range = document.createRange();
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.nodeValue?.trim()) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) ink.push(box(r));
  }
  root.querySelectorAll(".ink").forEach((el) => ink.push(box(el.getBoundingClientRect())));
  const hw = tw / 2, up = cy - b - 10, down = cy + b + 28, side = cy + 9;
  const spots = [[cx, up], [cx + a - hw, up], [cx - a + hw, up], [cx, down], [cx + a - hw, down], [cx - a + hw, down], [cx + a + 10 + hw, side], [cx - a - 10 - hw, side]];
  let best: [number, number, number] | null = null;
  spots.forEach(([sx, sy], i) => {
    sx = clamp(sx, hw + 6, 954 - hw); sy = clamp(sy, 28, 592);
    const L = [sx - hw, sy - 23, sx + hw, sy + 7];
    const over = (q: number[]) => Math.max(0, Math.min(L[2], q[2]) - Math.max(L[0], q[0])) * Math.max(0, Math.min(L[3], q[3]) - Math.max(L[1], q[1]));
    let cost = i * 4 + 0.5 * over([target.x, target.y, target.x + target.w, target.y + target.h]);
    for (const q of ink) cost += over(q);
    if (!best || cost < best[2]) best = [sx, sy, cost];
  });
  return [best![0], best![1]];
}
