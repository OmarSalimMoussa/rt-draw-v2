// What the app is doing, at a glance, top center: an animated pencil while it's
// drawing (sends running or queued, pictures still being drawn), a check when
// everything has landed, or a warning if a send failed. Nothing before the first send.
// (v1's StatusBadge.tsx, on the sender's status.)
import type { SendStatus } from "./board/sender.ts";
import { Icon } from "./sketch/Icon.tsx";

export function StatusBadge({ status: s }: { status: SendStatus }) {
  const drawing = s.running || s.queued > 0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (drawing) {
    const detail = s.settling ? `${plural(s.ops, "change")} · pictures` : s.running ? plural(s.ops, "change") : "";
    return (
      <div className="pg-state drawing" role="status" aria-live="polite">
        <Icon name="pencil" className="pg-pencil ic-boil" />
        <span>Drawing…</span>
        {(detail || s.queued > 0) && <span className="pg-state-detail">{[detail, s.queued > 0 && `${s.queued} queued`].filter(Boolean).join(" · ")}</span>}
      </div>
    );
  }
  if (s.error) {
    return (
      <div className="pg-state bad" role="status" aria-live="polite" title={s.error}>
        <Icon name="warn" />
        <span>Couldn't draw that</span>
      </div>
    );
  }
  if (!s.done) return null;
  return (
    <div className="pg-state done" role="status" aria-live="polite" title={s.rejected ? `${plural(s.rejected, "line")} of the reply weren't understood` : undefined}>
      <Icon name="check" />
      <span>Done</span>
    </div>
  );
}
