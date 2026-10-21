// The logo (logo.ts) on the page, boiling: its drawings flip every 0.15s, like the icons on hover.
import { LOGO_FRAMES, logoDrawing } from "./logo.ts";

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg className={className ? `logo ${className}` : "logo"} viewBox="-2 -2 68 68" width={size} height={size} aria-hidden>
      {Array.from({ length: LOGO_FRAMES }, (_, f) => {
        const d = logoDrawing(f);
        return (
          <g key={f} className="lf">
            {[d.cloud, ...d.dots].map((p, i) => <path key={i} d={p} />)}
          </g>
        );
      })}
    </svg>
  );
}
