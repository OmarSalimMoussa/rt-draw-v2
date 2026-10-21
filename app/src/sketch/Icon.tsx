// A hand-drawn icon (icons.ts), sized to the text around it. It holds a few
// drawings of itself; hovering its button or link flips through them (styles.css),
// so it jitters like a hand-drawn animation.
import { ICON_FRAMES, type IconName, iconPaths } from "./icons.ts";

export function Icon({ name, size = "1.1em", className }: { name: IconName; size?: number | string; className?: string }) {
  return (
    <svg className={className ? `ic ${className}` : "ic"} viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      {Array.from({ length: ICON_FRAMES }, (_, f) => (
        <g key={f} className="ic-frame">
          {iconPaths(name, f).map((d, i) => <path key={i} d={d} />)}
        </g>
      ))}
    </svg>
  );
}
