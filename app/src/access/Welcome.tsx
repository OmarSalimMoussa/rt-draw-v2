// What a visitor without an invite sees: what imagine is, the tour, and the waitlist.
import { useEffect, useState } from "react";
import { Logo } from "../sketch/Logo.tsx";
import { joinWaitlist } from "./api.ts";
import { Doodles } from "./Doodles.tsx";
import "./access.css";

/** imagine's code, open on GitHub. */
const GITHUB = "https://github.com/OmarSalimMoussa/rt-draw-v2";
/** The case study of the eval loop that made it fast (evals/README.md). */
const EVALS = `${GITHUB}/blob/master/evals/README.md`;

/** GitHub's mark (Octicons' mark-github, MIT), in the page's ink. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

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
  useEffect(() => void (document.title = "imagine: prototyping at the speed of thought"), []);

  return (
    <>
      <Doodles />
      <main className="ac">
        <Wordmark />
        <div className="ac-head">
          <h1>Prototyping at the speed of thought.</h1>
          <a className="ac-gh" href={GITHUB} target="_blank" rel="noopener" aria-label="imagine's code on GitHub" title="imagine's code on GitHub">
            <GitHubMark />
          </a>
        </div>
        <p className="ac-lede">
          We built imagine so an idea is on screen as fast as you can say it. Talk and draw, and it sketches whatever you have in mind: a website, a phone app, a desktop app, a whole macOS or Ubuntu desktop, a system diagram, or just a drawing. Say what you want, circle what should change, add screens and click through them. imagine is in early testing with a few people.
        </p>
        <p className="ac-story">
          How did imagine get twice as fast without drawing any worse? It tested itself: a loop tried 112 changes, timed and judged each one, and kept the winners.{" "}
          <a href={EVALS} target="_blank" rel="noopener">Read how we did it</a>
        </p>
        <video className="ac-video" src="/tutorial.mp4" poster="/tutorial.jpg" controls playsInline preload="metadata" aria-label="A 58-second narrated tour: a bakery site drawn from a typed request, a card circled and changed, a Menu page added and clicked through, then a phone app, a sketch and a system diagram" />
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
            <p className="ac-fine">We'll only use your email to send your invite.</p>
          </form>
        )}
        <p className="ac-foot">Already invited? Open the link in your invite email.</p>
      </main>
    </>
  );
}
