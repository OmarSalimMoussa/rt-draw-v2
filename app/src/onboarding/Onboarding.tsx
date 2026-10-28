// The editor's onboarding (tips.ts): the tour over an empty board the first time, the first
// drawings one tap away under it, and a speech bubble over the bar with the next move to try.
import { useEffect } from "react";
import { Icon } from "../sketch/Icon.tsx";
import { STARTERS, type TIPS } from "./tips.ts";
import "./onboarding.css";

/** The narrated tour that Welcome shows, for the people who came in with an invite and never saw Welcome. */
export function Tour({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="ob-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="ob-tour" role="dialog" aria-modal="true" aria-labelledby="ob-tour-title">
        <h2 id="ob-tour-title">See how far you can push it</h2>
        <p>
          A minute-long tour: a website from one sentence, a card circled and changed, a page added and clicked through, then a phone app, a drawing and a system diagram.
        </p>
        <video className="ob-video" src="/tutorial.mp4" poster="/tutorial.jpg" controls playsInline preload="metadata" aria-label="A 58-second narrated tour of imagine" />
        <div className="ob-go">
          <span className="muted">You can watch it again from the settings.</span>
          <button type="button" className="ob-start" onClick={onClose} autoFocus>Start drawing</button>
        </div>
      </section>
    </div>
  );
}

/** First drawings to pick from on an empty board: one tap sends it. */
export function Starters({ onPick }: { onPick(prompt: string): void }) {
  return (
    <div className="ob-starters" role="group" aria-label="Start from an idea">
      <span className="ob-try">Try one:</span>
      {STARTERS.map((s) => (
        <button key={s.label} type="button" className="ob-starter" onClick={() => onPick(s.prompt)} title={s.prompt}>
          <img src={`/doodles/${s.doodle}.svg`} alt="" width={22} height={22} />
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** The next move to try, in a bubble over the bar; × skips it. */
export function Tip({ tip, onSkip }: { tip: (typeof TIPS)[number]; onSkip(): void }) {
  return (
    <div className="ob-tip" role="note">
      <span><b>Try this:</b> {tip.text}</span>
      <button type="button" onClick={onSkip} aria-label="Skip this tip" title="Skip this tip"><Icon name="close" /></button>
    </div>
  );
}
