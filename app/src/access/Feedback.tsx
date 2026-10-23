// The Feedback button at the top right of the editor, for anyone signed in: a box to tell Omar what
// worked and what didn't. It goes with the project and version they're on, and waits for him on the
// admin's page under their name, next to that drawing (app/server/access.ts). Until they start
// drawing, a hand-drawn arrow points at the button and asks.
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Icon } from "../sketch/Icon.tsx";
import { sendFeedback } from "./api.ts";
import "./access.css";

export function FeedbackButton({ beg, project, version }: { beg: boolean; project: string; version: number }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("pointerdown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("pointerdown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setState("busy");
    setError("");
    try {
      await sendFeedback(text.trim(), project, version);
      setText("");
      setState("sent");
    } catch (err) {
      setError((err as Error).message);
      setState("idle");
    }
  };

  return (
    <div className="fb" ref={root}>
      <button
        type="button"
        className={open ? "fb-go on" : "fb-go"}
        onClick={() => {
          setOpen(!open);
          if (state === "sent") setState("idle");
        }}
        aria-expanded={open}
        title="Tell Omar what you think"
      >
        <Icon name="feedback" size={18} />
        <span>Feedback</span>
      </button>
      {beg && !open && (
        <div className="fb-beg" aria-hidden="true">
          {/* A quick pen arrow from the words up to the button. */}
          <svg viewBox="0 0 120 90" width="120" height="90">
            <path d="M14 82 C 22 52, 52 30, 98 14" />
            <path d="M82 10 L 99 13 L 89 28" />
          </svg>
          <span>Tell Omar what you think!</span>
        </div>
      )}
      {open && (
        <div className="st-menu fb-menu" role="dialog" aria-label="Feedback">
          {state === "sent" ? (
            <p className="fb-thanks" aria-live="polite">Thanks! Omar reads every one.</p>
          ) : (
            <form onSubmit={send}>
              <label htmlFor="fb-text" className="st-title">What do you think?</label>
              <textarea id="fb-text" rows={5} maxLength={4000} autoFocus placeholder="What worked? What broke? What did you wish it did?" value={text} onChange={(e) => setText(e.target.value)} />
              <p className="st-note">It goes to Omar with the drawing you're on, so he can see what you mean.</p>
              {error && <p className="ac-error" role="alert">{error}</p>}
              <button type="submit" className="ac-go" disabled={state === "busy" || !text.trim()}>{state === "busy" ? "Sending…" : "Send"}</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
