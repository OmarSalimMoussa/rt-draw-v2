// The arrows between pages, drawn by the app from the board's links (place.ts),
// never by the model: in their own <svg> over the board, with the board's viewBox,
// pencil-drawn in orange as v1 drew them. They carry no data-id, so the eval's
// clock never sees them, and they're not in the model's pictures (it reads the
// links in the site map). An arrow shows only while its element and pages are
// where it was routed for: it goes as soon as one of them changes, and comes back,
// fading in, once the board has placed its pages again. A version looked at in
// History shows its own arrows.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { type View, boardRect } from "../canvas/view.ts";
import { seedOf, sketchArrow } from "../sketch/rough.ts";
import type { Board } from "./board.ts";
import { type Placement, shownArrows } from "./place.ts";

/** v1's arrow colour, set on the paths (not in CSS) so captures keep it. */
const ARROW = "#f08c00";
/** On screen at any zoom. */
const STROKE_PX = 2.5;
const HEAD_PX = 13;

type Props = { board: Board; view: View; size: { width: number; height: number } };

export function BoardArrows({ board, view, size }: Props) {
  useSyncExternalStore(board.subscribe, board.getVersion);
  const looking = board.history.looking;
  const [old, setOld] = useState<{ n: number; p: Placement }>();
  useEffect(() => {
    if (looking === undefined) return;
    let live = true;
    void board.placementFor(looking).then((p) => live && setOld({ n: looking, p }));
    return () => void (live = false);
  }, [board, looking]);
  const placement = looking === undefined ? board.placement : old?.n === looking ? old.p : undefined;
  const arrows = board.gliding ? [] : shownArrows(board.shown(), placement);
  const k = 1 / view.zoom;
  const ids = arrows.map((a) => a.id + a.key).join("\n");
  const drawn = useMemo(
    () => arrows.map((a) => ({ a, strokes: sketchArrow(a.d, a.points, { seed: seedOf(`arrow:${a.id}`), stroke: ARROW, strokeWidth: STROKE_PX, head: HEAD_PX * k, scale: k }) })),
    [ids, k],
  );
  const b = boardRect(view, size);
  return (
    <svg className="bd-arrows" viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} aria-hidden>
      {drawn.map(({ a, strokes }) => (
        // Keyed by what it was routed for: rerouted, it fades in again. data-d: its clean route, for checks.
        <g key={`${a.id}|${a.key}`} data-link={a.id} data-d={a.d}>
          {strokes.map((p, i) => (
            <path key={i} d={p.d} fill="none" stroke={p.stroke} strokeWidth={p.strokeWidth} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      ))}
    </svg>
  );
}
