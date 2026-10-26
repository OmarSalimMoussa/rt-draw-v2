// Small hand-drawn charts for the progress page: rough.js lines at low roughness
// on an SVG drawn at its card's width (redrawn on resize, so text stays readable
// on a phone), Excalifont labels. Every mark carries data-* attributes saying
// what it shows, so the page's check can find it.
import rough from "roughjs";

const NS = "http://www.w3.org/2000/svg";
const FONT = "Excalifont, 'Comic Sans MS', cursive";
export const INK = "#1e1e1e";
const ROUGH = { roughness: 0.5, bowing: 0.4 };

export type XY = [x: number, y: number];
export type Dot = { x: number; y: number; id: string; hollow?: boolean };
export type Frame = ReturnType<typeof frame>;

const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const tag = (g: Element, data: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries(data)) g.setAttribute(`data-${k}`, v);
  return g;
};

/** About n round values across [lo, hi]. */
export function niceTicks(lo: number, hi: number, n = 4): number[] {
  const step0 = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}
const logTicks = (lo: number, hi: number) => [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].filter((v) => v >= lo && v <= hi);

/**
 * A plotting frame in the host: x and y in data units (y on a log scale when asked, a
 * second y axis on the right when y2 is given), axes, ticks and a title, then marks.
 */
export function frame(host: HTMLElement, o: { title: string; height: number; x: [number, number]; y: [number, number]; log?: boolean; y2?: [number, number];
  xTicks: { at: number; label: string }[]; yFormat: (v: number) => string; y2Format?: (v: number) => string }) {
  // The title is HTML, so it wraps on a phone.
  const title = document.createElement("h2");
  title.textContent = o.title;
  host.append(title);
  const w = Math.max(280, host.clientWidth);
  const h = o.height;
  const pad = { l: 46, r: o.y2 ? 46 : 12, t: 14, b: 30 };
  const svg = el("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, "font-family": FONT, "font-size": 12 });
  svg.style.display = "block";
  host.append(svg);
  const rc = rough.svg(svg);
  let seed = 1;
  const opts = (more: Record<string, unknown>) => ({ ...ROUGH, seed: seed++, ...more });
  const sx = (v: number) => pad.l + ((v - o.x[0]) / (o.x[1] - o.x[0] || 1)) * (w - pad.l - pad.r);
  const ly = (v: number) => (o.log ? Math.log(Math.max(v, 1)) : v);
  const sy = (v: number) => h - pad.b - ((ly(v) - ly(o.y[0])) / (ly(o.y[1]) - ly(o.y[0]) || 1)) * (h - pad.t - pad.b);
  const y2 = o.y2 ?? o.y;
  const sy2 = (v: number) => h - pad.b - ((v - y2[0]) / (y2[1] - y2[0] || 1)) * (h - pad.t - pad.b);
  const text = (x: number, y: number, s: string, more: Record<string, string | number> = {}) => {
    const t = el("text", { x, y, fill: INK, ...more });
    t.textContent = s;
    svg.append(t);
    return t;
  };
  const back = el("g"); // bands and areas sit behind lines
  svg.append(back);
  const put = (g: SVGGElement, data?: Record<string, string>, behind = false) => ((behind ? back : svg).append(tag(g, data)), g);

  put(rc.line(pad.l, h - pad.b, w - pad.r, h - pad.b, opts({ stroke: INK, strokeWidth: 1 })));
  put(rc.line(pad.l, pad.t, pad.l, h - pad.b, opts({ stroke: INK, strokeWidth: 1 })));
  for (const v of o.log ? logTicks(o.y[0], o.y[1]) : niceTicks(o.y[0], o.y[1])) {
    text(pad.l - 6, sy(v) + 4, o.yFormat(v), { "text-anchor": "end", "font-size": 11 });
    svg.append(el("line", { x1: pad.l, x2: w - pad.r, y1: sy(v), y2: sy(v), stroke: "#dcd8cf", "stroke-width": 0.6 }));
  }
  if (o.y2) for (const v of niceTicks(o.y2[0], o.y2[1])) text(w - pad.r + 6, sy2(v) + 4, (o.y2Format ?? String)(v), { "font-size": 11, fill: "#6c6a64" });
  // Thin out the x labels to what fits.
  const every = Math.max(1, Math.ceil((o.xTicks.length * 34) / (w - pad.l - pad.r)));
  o.xTicks.forEach((t, i) => i % every === 0 && text(sx(t.at), h - pad.b + 14, t.label, { "text-anchor": "middle", "font-size": 11 }));

  return {
    svg, w, h, x: sx, y: sy, y2: sy2,
    /** A line through the points; `ids` are the points it joins (a hollow point is never one of them). */
    line(pts: XY[], s: { color: string; width?: number; dash?: boolean; faint?: boolean; right?: boolean; ids?: string[]; data?: Record<string, string> }) {
      if (pts.length < 2) return;
      const y = s.right ? sy2 : sy;
      const g = rc.linearPath(pts.map(([a, b]) => [sx(a), y(b)]), opts({ stroke: s.color, strokeWidth: s.width ?? 2, ...(s.dash ? { strokeLineDash: [6, 5] } : {}) }));
      if (s.faint) g.setAttribute("opacity", "0.35");
      put(g, { ...s.data, ids: (s.ids ?? []).join(" ") });
    },
    /** Points: solid for trusted ones, hollow (amber outline) for those kept out of trend lines. */
    dots(ds: Dot[], color: string, right = false) {
      const y = right ? sy2 : sy;
      for (const d of ds) {
        const g = rc.circle(sx(d.x), y(d.y), d.hollow ? 10 : 8, opts(d.hollow ? { stroke: "#f08c00", strokeWidth: 2, fill: "none" } : { stroke: color, fill: color, fillStyle: "solid" }));
        put(g, { id: d.id, ...(d.hollow ? { hollow: "1" } : { point: "1" }) });
      }
    },
    /** The shaded interval between two lines (a 90% band). */
    area(upper: XY[], lower: XY[], color: string, data: Record<string, string> = {}) {
      if (upper.length < 2) return;
      const pts = [...upper, ...lower.slice().reverse()].map(([a, b]) => [sx(a), sy(b)] as [number, number]);
      const g = rc.polygon(pts, opts({ stroke: "none", fill: color, fillStyle: "solid", roughness: 0.3 }));
      g.setAttribute("opacity", "0.16");
      put(g, data, true);
    },
    /** A horizontal strip over a y range across the whole chart (v1's band). */
    yband(y0: number, y1: number, label: string, color: string, data: Record<string, string>) {
      const g = rc.rectangle(pad.l, sy(y1), w - pad.l - pad.r, Math.max(3, sy(y0) - sy(y1)), opts({ stroke: "none", fill: color, fillStyle: "solid", roughness: 0.3 }));
      g.setAttribute("opacity", "0.22");
      put(g, data, true);
      text(w - pad.r - 4, sy(y1) - 4, label, { "text-anchor": "end", "font-size": 11, fill: color });
    },
    /** A dotted reference line with a label. */
    hline(y: number, label: string, data: Record<string, string> = {}, right = false) {
      const yy = (right ? sy2 : sy)(y);
      put(rc.line(pad.l, yy, w - pad.r, yy, opts({ stroke: "#6c6a64", strokeWidth: 1, strokeLineDash: [3, 4], roughness: 0.2 })), data);
      text(pad.l + 4, yy - 4, label, { "font-size": 11, fill: "#6c6a64" });
    },
    /** A single labelled reference point at x (the doc as written). */
    point(x: number, y: number, label: string, data: Record<string, string>) {
      put(rc.rectangle(sx(x) - 5, sy(y) - 5, 10, 10, opts({ stroke: INK, fill: "#ffd43b", fillStyle: "solid" })), data);
      text(sx(x) + 9, sy(y) + 4, label, { "font-size": 11 });
    },
    /**
     * A ring around a point with a short label under it, on the side that has room, the full
     * story on hover (a checkpoint surely slower than A0).
     */
    ring(x: number, y: number, label: string, full: string, color: string, data: Record<string, string>, right = false) {
      const [cx, cy] = [sx(x), (right ? sy2 : sy)(y)];
      const g = rc.circle(cx, cy, 22, opts({ stroke: color, strokeWidth: 2.5, fill: "none" }));
      const title = el("title");
      title.textContent = full;
      g.append(title);
      put(g, data);
      const left = cx > w / 2;
      text(cx + (left ? -10 : 10), cy + 24, label, { "font-size": 11, fill: color, "text-anchor": left ? "end" : "start" });
    },
    /** A labelled vertical step on a line at x: an owner step into his checkpoint. */
    step(x: number, from: number, to: number, label: string, kind: string, right = false) {
      const y = right ? sy2 : sy;
      put(rc.line(sx(x), y(from), sx(x), y(to), opts({ stroke: "#5f3dc4", strokeWidth: 1.5, strokeLineDash: [4, 3] })), { step: kind });
      text(sx(x) + 4, Math.min(y(from), y(to)) - 4, label, { "font-size": 11, fill: "#5f3dc4" });
    },
    /** A marker tick on the x axis (a harness tag, a served model, an era, an A/A…) with a one-letter glyph, its full label on hover. */
    tick(x: number, label: string, kind: string, glyph = "·") {
      const g = rc.line(sx(x), h - pad.b - 7, sx(x), h - pad.b + 3, opts({ stroke: "#e8590c", strokeWidth: 2 }));
      const title = el("title");
      title.textContent = label;
      g.append(title);
      put(g, { tick: kind });
      text(sx(x), h - pad.b - 10, glyph, { "text-anchor": "middle", "font-size": 10, fill: "#e8590c" });
    },
    /** One bar segment from y0 to y1 at x, about `frac` of an x step wide. */
    bar(x: number, y0: number, y1: number, color: string, frac: number, data: Record<string, string>) {
      const bw = Math.max(3, ((w - pad.l - pad.r) / (o.x[1] - o.x[0])) * frac);
      put(rc.rectangle(sx(x) - bw / 2, sy(y1), bw, Math.max(1, sy(y0) - sy(y1)), opts({ stroke: INK, strokeWidth: 0.6, fill: color, fillStyle: "solid", roughness: 0.3 })), data);
    },
  };
}

/** A one-line legend under a chart. */
export function legend(host: HTMLElement, items: [label: string, color: string, dash?: boolean][]) {
  const div = document.createElement("div");
  div.className = "stat legend";
  div.innerHTML = items.map(([l, c, d]) => `<span><i style="border-top:2.5px ${d ? "dashed" : "solid"} ${c}"></i>${l}</span>`).join("");
  host.append(div);
}
