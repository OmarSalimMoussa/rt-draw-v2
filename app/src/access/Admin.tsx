// The admin's page (/admin): invite people, the waitlist, everyone invited and how far they got, and
// each person's work: their feedback (each opens the drawing it was sent on), their projects, every
// version they made, and their model calls with any errors.
import { type FormEvent, useEffect, useState } from "react";
import type { SceneJSON } from "../../../src/core/scene.ts";
import { Thumb } from "../projects/ProjectsPage.tsx";
import { ago } from "../projects/storage.ts";
import { type Call, type Feedback, type Invited, type Me, type Person, type Waiting, invite, overview, revoke, theirCalls, theirFeedback, theirProject, theirProjects } from "./api.ts";
import { Wordmark } from "./Welcome.tsx";
import "./access.css";

const when = (t: number) => (ago(t) === "now" ? "just now" : `${ago(t)} ago`);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function Admin({ me }: { me?: Me | null }) {
  const [data, setData] = useState<{ people: Person[]; waitlist: Waiting[] }>();
  const [error, setError] = useState("");
  const [made, setMade] = useState<Invited & { email: string; send: boolean }>();
  const [open, setOpen] = useState<string>();
  const refresh = () => overview().then(setData, (e: Error) => setError(e.message));
  useEffect(() => {
    document.title = "People · imagine";
    if (me?.admin) void refresh();
  }, []);

  if (!me?.admin)
    return (
      <main className="ac">
        <Wordmark />
        <p>This page is only for the admin. <a href="/">Back to imagine</a></p>
      </main>
    );

  const send = async (email: string, mail: boolean) => {
    setError("");
    try {
      setMade({ ...(await invite(email, mail)), email, send: mail });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main className="ad">
      <header className="ad-top">
        <Wordmark />
        <span className="muted">{me.email} · <a href="/">Back to drawing</a></span>
      </header>

      <InviteForm onInvite={send} />
      {made && <MadeLink made={made} />}
      {error && <p className="ac-error" role="alert">{error}</p>}

      {!!data?.waitlist.length && (
        <section className="ad-section">
          <h2>Waitlist</h2>
          <ul className="ad-rows">
            {[...data.waitlist].reverse().map((w) => (
              <li key={w.email} data-waiting>
                <span className="ad-email">{w.email}</span>
                <span className="ad-note">{w.note || <span className="muted">no note</span>}</span>
                <span className="muted">{when(w.at)}</span>
                {w.invitedAt ? <span className="ad-done">invited {when(w.invitedAt)}</span> : <button type="button" onClick={() => send(w.email, true)}>Invite</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ad-section">
        <h2>People</h2>
        {data && !data.people.length && <p className="muted">Nobody yet. Invite someone above.</p>}
        <ul className="ad-rows">
          {data?.people.map((p) => (
            <PersonRow key={p.id} p={p} open={open === p.id} onOpen={() => setOpen(open === p.id ? undefined : p.id)} onLink={() => send(p.email, false)} onRevoked={refresh} />
          ))}
        </ul>
      </section>
    </main>
  );
}

function InviteForm({ onInvite }: { onInvite: (email: string, send: boolean) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent, mail: boolean) => {
    e.preventDefault();
    setBusy(true);
    await onInvite(email, mail);
    setBusy(false);
    setEmail("");
  };
  return (
    <form className="ad-invite" onSubmit={(e) => go(e, true)}>
      <label htmlFor="ad-email">Invite someone</label>
      <input id="ad-email" type="email" required placeholder="their@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button type="submit" className="ac-go" disabled={busy}>Invite and email them</button>
      <button type="button" disabled={busy || !email} onClick={(e) => go(e, false)}>Just make a link</button>
    </form>
  );
}

function MadeLink({ made }: { made: Invited & { email: string; send: boolean } }) {
  const [copied, setCopied] = useState(false);
  const status = made.mailed ? `Emailed to ${made.email}.` : made.mailError ? made.mailError : `Send this link to ${made.email} yourself.`;
  return (
    <div className="ad-link" aria-live="polite">
      <input readOnly value={made.link} aria-label={`Invite link for ${made.email}`} onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        onClick={() =>
          navigator.clipboard.writeText(made.link).then(
            () => setCopied(true),
            () => {},
          )
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <span className={made.send && !made.mailed ? "ac-error" : "muted"}>{status} It replaces any link they had; anyone already signed in stays signed in.</span>
    </div>
  );
}

function PersonRow({ p, open, onOpen, onLink, onRevoked }: { p: Person; open: boolean; onOpen(): void; onLink(): void; onRevoked(): void }) {
  const [asking, setAsking] = useState(false);
  const status = p.revokedAt ? `revoked ${when(p.revokedAt)}` : p.joinedAt ? `joined ${when(p.joinedAt)}` : `invited ${when(p.linkAt)}, hasn't joined`;
  return (
    <li data-person={p.id} className={p.revokedAt ? "ad-person off" : "ad-person"}>
      <div className="ad-line">
        <span className="ad-email">
          {p.email}
          {p.admin && <em className="ad-chip">admin</em>}
        </span>
        <span>{status}</span>
        <span className="muted">{p.lastSeen ? `active ${when(p.lastSeen)}` : ""}</span>
        <span>{plural(p.projects, "project")} · {plural(p.versions, "send")}</span>
        {p.feedback > 0 && <span className="ad-fb">{p.feedback} feedback</span>}
        <span className="ad-actions">
          <button type="button" className="ad-open" onClick={onOpen} aria-expanded={open}>{open ? "Close" : "Their work"}</button>
          <button type="button" className="ad-relink" onClick={onLink}>New link</button>
          {!p.revokedAt &&
            (asking ? (
              <>
                <button
                  type="button"
                  className="ad-danger"
                  onClick={async () => {
                    await revoke(p.email);
                    setAsking(false);
                    onRevoked();
                  }}
                >
                  Revoke access
                </button>
                <button type="button" onClick={() => setAsking(false)}>Keep</button>
              </>
            ) : (
              <button type="button" className="ad-revoke" onClick={() => setAsking(true)}>Revoke</button>
            ))}
        </span>
      </div>
      {open && <Work person={p.id} />}
    </li>
  );
}

type Project = Awaited<ReturnType<typeof theirProjects>>["projects"][number];
type Version = Awaited<ReturnType<typeof theirProject>>["versions"][number];

/** One person's feedback, projects and model calls; a project opens on its versions, newest first, or on the one a piece of feedback was sent on. */
function Work({ person }: { person: string }) {
  const [projects, setProjects] = useState<Project[]>();
  const [calls, setCalls] = useState<Call[]>();
  const [feedback, setFeedback] = useState<Feedback[]>();
  const [picked, setPicked] = useState<{ id: string; versions: Version[]; at: number }>();
  useEffect(() => {
    theirProjects(person).then((r) => setProjects(r.projects), () => setProjects([]));
    theirCalls(person).then((r) => setCalls(r.calls), () => setCalls([]));
    theirFeedback(person).then((r) => setFeedback(r.feedback), () => setFeedback([]));
  }, [person]);
  const pick = async (id: string, n?: number) => {
    const { versions } = await theirProject(person, id);
    const at = versions.findIndex((v) => v.n === n);
    setPicked({ id, versions, at: at >= 0 ? at : versions.length - 1 });
  };
  const shown = picked?.versions[picked.at];

  return (
    <div className="ad-work">
      {!!feedback?.length && (
        <>
          <h3>Feedback</h3>
          <ul className="ad-feedback">
            {feedback.map((f, i) => (
              <li key={i}>
                <p>{f.text}</p>
                <span className="muted">{when(f.at)}</span>
                {f.project && (
                  <button type="button" onClick={() => pick(f.project!.id, f.project!.version)}>
                    {f.project.name}
                    {f.project.version ? ` · V${f.project.version}` : ""}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Projects</h3>
      {projects && !projects.length && <p className="muted">No projects yet.</p>}
      <ul className="ad-projects">
        {projects?.map((pr) => (
          <li key={pr.id}>
            <button type="button" className={picked?.id === pr.id ? "ad-project on" : "ad-project"} onClick={() => pick(pr.id)}>
              {!!pr.latest && <Thumb doc={pr.latest as SceneJSON} />}
              <strong>{pr.name}</strong>
              <span className="muted">{plural(pr.pages, "page")} · {plural(pr.versions, "version")} · {when(pr.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
      {picked && shown && (
        <div className="ad-versions">
          <div className="ad-big">
            <Thumb doc={shown.doc as SceneJSON} />
          </div>
          <ol reversed>
            {[...picked.versions].reverse().map((v) => {
              const i = picked.versions.indexOf(v);
              return (
                <li key={v.n}>
                  <button type="button" className={i === picked.at ? "on" : undefined} onClick={() => setPicked({ ...picked, at: i })}>
                    <span>V{v.n}</span> {v.label} <span className="muted">{when(v.at)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <h3>Model calls</h3>
      {calls && !calls.length && <p className="muted">No model calls yet.</p>}
      <ul className="ad-calls">
        {calls?.map((c, i) => (
          <li key={i} className={c.error ? "ad-call bad" : "ad-call"}>
            <span className="muted">{new Date(c.at).toLocaleString()}</span> <strong>{c.from ?? "call"}</strong> {c.model} {c.ms !== undefined && `${(c.ms / 1000).toFixed(1)} s`}
            {c.error && <div className="ad-err">{c.error}</div>}
            {c.user && (
              <details>
                <summary>{c.user.split("\n").find((l) => l.startsWith("Request:"))?.slice(9) || c.user.slice(0, 80)}</summary>
                <pre>{c.user}</pre>
                {c.reply && <pre>{c.reply}</pre>}
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
