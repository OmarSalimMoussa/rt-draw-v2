// What a visitor without an invite sees: what imagine is, the tour, and the waitlist.
import { useEffect, useState } from "react";
import { Logo } from "../sketch/Logo.tsx";
import { joinWaitlist } from "./api.ts";
import "./access.css";

export function Wordmark() {
  return (
    <div className="ac-mark">
      <Logo size={34} />
      <span>imagine</span>
    </div>
  );
}

export function Welcome() {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");
  useEffect(() => void (document.title = "imagine"), []);

  return (
    <main className="ac">
      <Wordmark />
      <h1>Prototyping at the speed of thought.</h1>
      <p className="ac-lede">
        We built imagine so an idea for a website is on screen as fast as you can say it. Sketch it by talking and drawing: say what you want, circle what should change, add pages and click through them. imagine is in early testing with a few people.
      </p>
      <video className="ac-video" src="/tutorial.mp4" poster="/tutorial.jpg" controls playsInline preload="metadata" aria-label="A 44-second narrated tour: a bakery site drawn from a typed request, a card circled and changed, a Menu page added, then clicked through" />
      {state === "done" ? (
        <section className="ac-card" aria-live="polite">
          <h2>You're on the list.</h2>
          <p>You'll get an email with your own invite link when there's room.</p>
        </section>
      ) : (
        <form
          className="ac-card"
          onSubmit={async (e) => {
            e.preventDefault();
            setState("busy");
            setError("");
            try {
              await joinWaitlist(email, note, website);
              setState("done");
            } catch (err) {
              setError((err as Error).message);
              setState("idle");
            }
          }}
        >
          <h2>Join the waitlist</h2>
          <label htmlFor="ac-email">Your email</label>
          <input id="ac-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label htmlFor="ac-note">What would you make with it? <span className="muted">(optional)</span></label>
          <textarea id="ac-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          {/* For bots only: people never see it, and a sign-up that fills it in is dropped. */}
          <input className="ac-trap" name="website" tabIndex={-1} autoComplete="off" aria-hidden value={website} onChange={(e) => setWebsite(e.target.value)} />
          {error && <p className="ac-error" role="alert">{error}</p>}
          <button type="submit" className="ac-go" disabled={state === "busy"}>{state === "busy" ? "Joining…" : "Join the waitlist"}</button>
        </form>
      )}
      <p className="ac-foot">Already invited? Open the link in your invite email.</p>
    </main>
  );
}
