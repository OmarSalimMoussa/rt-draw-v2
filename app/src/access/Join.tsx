// An invite link (/join/<token>): type the email it was sent to, and this browser is signed in.
import { useEffect, useState } from "react";
import { join } from "./api.ts";
import { Wordmark } from "./Welcome.tsx";
import "./access.css";

export function Join({ token }: { token: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => void (document.title = "Join imagine"), []);

  return (
    <main className="ac">
      <Wordmark />
      <form
        className="ac-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await join(token, email);
            location.replace("/");
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <h1>You're invited</h1>
        <p>Type the email this invite was sent to. This browser then stays signed in for 90 days.</p>
        <label htmlFor="ac-email">Your email</label>
        <input id="ac-email" type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        {error && <p className="ac-error" role="alert">{error}</p>}
        <button type="submit" className="ac-go" disabled={busy}>{busy ? "Signing in…" : "Start drawing"}</button>
        <p className="ac-small">Your drawings are visible only to you and to Omar, who runs imagine, so he can see what works and what doesn't.</p>
      </form>
    </main>
  );
}
