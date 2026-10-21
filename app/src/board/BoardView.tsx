// v2's board on the canvas: one screen-sized <svg> that v2's renderer redraws
// (render.ts), at most once per animation frame (Board.draw), with no id tags, as
// the eval's bridge draws it. Its background is let go, so v1's paper shows around
// the pages. Moving the view only moves the viewBox, as boardStage does: the shapes
// are untouched, so the eval's clock (which hashes each g[data-id]) sees no change.
import { useLayoutEffect, useRef } from "react";
import { render } from "../../../src/core/render.ts";
import { type View, boardRect } from "../canvas/view.ts";
import type { Board } from "./board.ts";

type Props = { board: Board; view: View; size: { width: number; height: number }; onSvg?(svg: SVGSVGElement): void };

/** The board's own background rect (render() puts it first, after <defs>): sized to the view, and not filled. */
function frameBackground(svg: SVGSVGElement, b: { x: number; y: number; w: number; h: number }) {
  const bg = svg.querySelector(":scope > rect");
  if (!bg) return;
  for (const [k, v] of Object.entries({ x: b.x, y: b.y, width: b.w, height: b.h })) bg.setAttribute(k, String(v));
  bg.setAttribute("fill", "none");
}

export function BoardView({ board, view, size, onSvg }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const latest = useRef({ view, size });
  latest.current = { view, size };

  useLayoutEffect(() => {
    const svg = ref.current!;
    const paint = () => {
      const b = boardRect(latest.current.view, latest.current.size);
      render(svg, board.shown(), { tuning: board.tuning, view: b });
      frameBackground(svg, b);
    };
    onSvg?.(svg);
    paint();
    return board.onPaint(paint);
  }, [board]);

  useLayoutEffect(() => {
    const svg = ref.current!;
    const b = boardRect(view, size);
    svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`);
    frameBackground(svg, b);
  }, [view, size.width, size.height]);

  return <svg ref={ref} className="bd" aria-hidden />;
}
