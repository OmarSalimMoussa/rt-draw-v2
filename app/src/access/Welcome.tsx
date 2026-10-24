// What a visitor without an invite sees: what imagine is, the tour, the waitlist, and how it got fast.
import { useEffect, useState } from "react";
import latencyChart from "../../../evals/case-study/latency-card.svg";
import qualityChart from "../../../evals/case-study/quality-card.svg";
import { Icon } from "../sketch/Icon.tsx";
import { Logo } from "../sketch/Logo.tsx";
import { joinWaitlist } from "./api.ts";
import { Doodles } from "./Doodles.tsx";
import "./access.css";

/** imagine's code, open on GitHub. */
const GITHUB = "https://github.com/OmarSalimMoussa/rt-draw-v2";
/** The case study of the eval loop that made it fast (evals/README.md). */
const EVALS = `${GITHUB}/blob/master/evals/README.md`;

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
      {/* As wide as the page's words: all of the screen on a computer (access.css), one column narrower than that. */}
      <Doodles column={innerWidth >= 1180 ? 1600 : 760} />
      <main className="ac ac-welcome">
        <header className="ac-top">
          <Wordmark />
          <a className="ac-gh" href={GITHUB} target="_blank" rel="noopener" aria-label="imagine's code on GitHub" title="imagine's code on GitHub">
            <span className="ac-gh-note">
              <span>Read the source code</span>
              {/* A pen arrow, with a loop in it, from the words to the mark. */}
              <svg viewBox="0 0 70 44" width="70" height="44">
                <path d="M2 30C12 34 22 30 26 22C30 12 20 8 18 16C16 26 36 30 64 16" />
                <path d="M54 15.5L64 16L58.5 24.4" />
              </svg>
            </span>
            <Icon name="github" />
          </a>
        </header>
        <div className="ac-intro">
          <h1>Prototyping at the speed of thought.</h1>
          <p className="ac-lede">
            We built imagine so an idea is on screen as fast as you can say it. Talk and draw, and it sketches whatever you have in mind: a website, a phone app, a desktop app, a whole macOS or Ubuntu desktop, a system diagram, or just a drawing. Say what you want, circle what should change, add screens and click through them. imagine is in early testing with a few people.
          </p>
        </div>
        <div className="ac-side">
          <video className="ac-video" src="/tutorial.mp4" poster="/tutorial.jpg" controls playsInline preload="metadata" aria-label="A 58-second narrated tour: a bakery site drawn from a typed request, a card circled and changed, a Menu page added and clicked through, then a phone app, a sketch and a system diagram" />
        </div>
        <div className="ac-cta">
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
              <div className="ac-fields">
                <div className="ac-field">
                  <label htmlFor="ac-email">Your email</label>
                  <input id="ac-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="ac-field ac-field-note">
                  <label htmlFor="ac-note">What would you make with it? <span className="muted">(optional)</span></label>
                  <textarea id="ac-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </div>
              {/* For bots only: people never see it, and a sign-up that fills it in is dropped. */}
              <input className="ac-trap" name="website" tabIndex={-1} autoComplete="off" aria-hidden value={website} onChange={(e) => setWebsite(e.target.value)} />
              {error && <p className="ac-error" role="alert">{error}</p>}
              <div className="ac-send">
                <button type="submit" className="ac-go" disabled={state === "busy"}>{state === "busy" ? "Joining…" : "Join the waitlist"}</button>
                <p className="ac-fine">We'll only use your email to send your invite.</p>
              </div>
            </form>
          )}
          <p className="ac-foot">Already invited? Open the link in your invite email.</p>
        </div>
        <section className="ac-story" aria-labelledby="ac-story-title">
          <h2 id="ac-story-title">How imagine got twice as fast</h2>
          <p>
            For 22 hours, a loop tried 112 changes to imagine, most of them its own ideas. It timed each one against the best version so far, had an AI judge compare the drawings, and kept only the changes that made imagine faster without making its drawings worse.
          </p>
          <div className="ac-charts">
            <img src={latencyChart} width={480} height={230} alt="Seconds until the first change appears: the original stays between 5.1 and 5.8 seconds, while the loop's best version falls from 5.4 to 2.4 seconds over 21 hours." />
            <img src={qualityChart} width={480} height={230} alt="How often the judge picked the new version: between 45% and 56% at every checkpoint, and every 90% interval includes 50%, a tie." />
          </div>
          <a href={EVALS} target="_blank" rel="noopener">Read how we did it</a>
        </section>
      </main>
    </>
  );
}
