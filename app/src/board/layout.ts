// Where the pages sit on the canvas and how the arrows between them run: a
// left-to-right flowchart laid out by ELK (the Eclipse Layout Kernel, the engine
// behind mermaid's "elk" renderer), in a web worker. Each page goes in the column
// after the page whose button leads to it; arrows run from the button out of its
// page (by the side that draws least over it) and around the other pages with
// right-angle turns. Home stays at the origin; the rest flows around it.
// (v1's src/page/layout.ts, constants unchanged; tests hand it ELK's in-thread build.)
import ElkConstructor, { type ELK, type ElkExtendedEdge, type ElkNode, type ElkPoint, type ElkPort } from "elkjs/lib/elk-api.js";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { Box } from "../../../src/core/scene.ts";

export type PageSize = { id: string; w: number; h: number };

/** An arrow from a button on one page to another page. Without a button it only places the page (nothing is drawn). */
export type PageLink = {
  id: string;
  from: string;
  to: string;
  /** The button (or link item), and the other things on its page, relative to its page's top-left. */
  button?: Box;
  around?: Box[];
};

export type Layout = {
  at: Map<string, { x: number; y: number }>;
  /** Each arrow as an SVG path, and as the corner points it runs through. */
  arrows: { id: string; d: string; points: ElkPoint[] }[];
};

/** Knobs for trying the engine out (the layout lab): how arrows pick their way out, and ELK options on top of ours. */
export type LayoutOptions = { exits?: "least-over-page" | "right"; elk?: Record<string, string> };

/** Where arrows arrive on a page: just under its browser bar, one below the other when several arrive. */
const ENTRY_Y = 90;
const ENTRY_STEP = 24;
/** The gap between an arrow's start and its button. */
const GAP = 6;
const RADIUS = 14;

const OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  // Keep pages and arrows in the order they were made, so the layout doesn't reshuffle as the site grows.
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.spacing.nodeNodeBetweenLayers": "220",
  "elk.spacing.nodeNode": "140",
  "elk.spacing.edgeNode": "40",
  "elk.spacing.edgeEdge": "18",
  "elk.layered.spacing.edgeNodeBetweenLayers": "40",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "18",
};

let elk: ELK | undefined;
/** The ELK to lay out with (tests: elkjs/lib/elk.bundled.js, as there's no worker). */
export const setElk = (e: ELK) => void (elk = e);

const crosses = (a: ElkPoint, b: ElkPoint, r: Box) =>
  Math.min(a.x, b.x) < r.x + r.w && Math.max(a.x, b.x) > r.x && Math.min(a.y, b.y) < r.y + r.h && Math.max(a.y, b.y) > r.y;

/** What leaving a page costs, in px drawn over it: crossing something on the page, px outside it, a turn. */
const CROSSING = 1000;
const OUTSIDE = 0.3;
const BEND = 40;

/**
 * Which side of its page an arrow leaves by: the one that draws least over the page. Every side is
 * weighed by how far the arrow runs over the page to get out, what it crosses on the way, and (a
 * little) how far it then has to go around the page to head right, toward the page it leads to.
 */
function exit(b: Box, page: PageSize, around: Box[], sides = ["EAST", "NORTH", "SOUTH", "WEST"]): { side: string; port: ElkPoint; start: ElkPoint } {
  const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2];
  const ways = [
    { side: "EAST", start: { x: b.x + b.w + GAP, y: cy }, port: { x: page.w, y: cy }, inside: page.w - b.x - b.w, outside: 0, bends: 0 },
    { side: "NORTH", start: { x: cx, y: b.y - GAP }, port: { x: cx, y: 0 }, inside: b.y, outside: page.w - cx, bends: 1 },
    { side: "SOUTH", start: { x: cx, y: b.y + b.h + GAP }, port: { x: cx, y: page.h }, inside: page.h - b.y - b.h, outside: page.w - cx, bends: 1 },
    // Back around a corner and along the whole page.
    { side: "WEST", start: { x: b.x - GAP, y: cy }, port: { x: 0, y: cy }, inside: b.x, outside: page.w + Math.min(cy, page.h - cy), bends: 2 },
  ];
  const cost = (w: (typeof ways)[number]) =>
    around.filter((r) => crosses(w.start, w.port, r)).length * CROSSING + w.inside + w.outside * OUTSIDE + w.bends * BEND;
  return ways.filter((w) => sides.includes(w.side)).sort((a, b) => cost(a) - cost(b))[0];
}

/** Straight runs joined by rounded corners. */
function rounded(p: ElkPoint[]): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  const toward = (from: ElkPoint, to: ElkPoint, r: number): ElkPoint => {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: from.x + ((to.x - from.x) / len) * r, y: from.y + ((to.y - from.y) / len) * r };
  };
  let d = `M${f(p[0].x)} ${f(p[0].y)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [a, b, c] = [p[i - 1], p[i], p[i + 1]];
    const r = Math.min(RADIUS, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const [s, e] = [toward(b, a, r), toward(b, c, r)];
    d += ` L${f(s.x)} ${f(s.y)} Q${f(b.x)} ${f(b.y)} ${f(e.x)} ${f(e.y)}`;
  }
  const end = p.at(-1)!;
  return `${d} L${f(end.x)} ${f(end.y)}`;
}

/** Lays the pages out and routes the arrows; `home` ends up at (0, 0). */
export async function layoutPages(home: string, pages: PageSize[], links: PageLink[], opts: LayoutOptions = {}): Promise<Layout> {
  if (pages.length === 1) return { at: new Map([[pages[0].id, { x: 0, y: 0 }]]), arrows: [] };
  elk ??= new ElkConstructor({ workerUrl });
  const ports = new Map<string, ElkPort[]>(pages.map((p) => [p.id, []]));
  const size = new Map(pages.map((p) => [p.id, p]));
  const starts = new Map<string, ElkPoint>();
  const edges: ElkExtendedEdge[] = [];
  for (const l of links) {
    const [from, to] = [size.get(l.from), size.get(l.to)];
    if (!from || !to || l.from === l.to) continue;
    const arriving = ports.get(l.to)!.filter((p) => p.id.endsWith(">in")).length;
    const y = Math.min(ENTRY_Y + arriving * ENTRY_STEP, to.h - 12);
    const into: ElkPort = { id: `${l.id}>in`, x: 0, y, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } };
    ports.get(l.to)!.push(into);
    let source = l.from;
    if (l.button) {
      const way = opts.exits === "right" ? exit(l.button, from, [], ["EAST"]) : exit(l.button, from, l.around ?? [], ["EAST", "NORTH", "SOUTH"]);
      const out: ElkPort = { id: `${l.id}>out`, ...way.port, width: 0, height: 0, layoutOptions: { "elk.port.side": way.side } };
      ports.get(l.from)!.push(out);
      starts.set(l.id, way.start);
      source = out.id;
    }
    edges.push({ id: l.id, sources: [source], targets: [into.id] });
  }
  const graph: ElkNode = {
    id: "root",
    layoutOptions: { ...OPTIONS, ...opts.elk },
    children: pages.map((p) => ({ id: p.id, width: p.w, height: p.h, ports: ports.get(p.id), layoutOptions: { "elk.portConstraints": "FIXED_POS" } })),
    edges,
  };
  const out = await elk.layout(graph);
  const placed = new Map((out.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
  const origin = placed.get(home) ?? { x: 0, y: 0 };
  const shift = (p: ElkPoint) => ({ x: p.x - origin.x, y: p.y - origin.y });
  const at = new Map([...placed].map(([id, p]) => [id, shift(p)]));
  const arrows: Layout["arrows"] = [];
  for (const e of (out.edges ?? []) as ElkExtendedEdge[]) {
    const start = starts.get(e.id);
    const s = e.sections?.[0];
    const page = at.get(links.find((l) => l.id === e.id)?.from ?? "");
    if (!start || !s || !page) continue;
    const points = [{ x: page.x + start.x, y: page.y + start.y }, ...[s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(shift)];
    // Stop just short of the page, so the arrowhead touches its edge.
    points[points.length - 1] = { ...points[points.length - 1], x: points[points.length - 1].x - GAP };
    arrows.push({ id: e.id, d: rounded(points), points });
  }
  return { at, arrows };
}
