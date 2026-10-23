// Who may use the hosted app (host.ts), and the admin's view of everyone.
//
// A person is an email the admin invited. Their invite link carries a random token, and
// opening it and typing that email signs the browser in for 90 days with a session cookie.
// Only hashes of tokens and sessions are kept, so the store alone signs nobody in. A new
// link replaces the old one; revoking someone ends all their sessions. Each person's
// projects live under their own owner id (projects.ts), so testers never see each other's
// work, while the admin sees everyone's, and every model call is logged for its person.
// Visitors without a link can join the waitlist, which mails the admin (mailer.ts; the first
// WAITLIST_MAILS_PER_DAY sign-ups a day, so invites keep the quota), and
// anyone signed in can send feedback, kept with the version of the project they were on
// for the admin's page (never mailed).
//
// Everything is one JSON file, <RT_DATA_DIR>/access/access.json, written whole and renamed
// into place, one change at a time; a write by another process (invite.ts) is read back.
// Feedback is appended to <RT_DATA_DIR>/access/feedback.jsonl.
//   GET  /api/access/me                         -> { person: { email, admin } | null }
//   POST /api/access/join      { token, email } -> signs this browser in
//   POST /api/access/waitlist  { email, note }  -> { ok }
//   POST /api/access/signout
//   POST /api/access/feedback  { text, project?, version? } -> { ok } (signed in; a project of theirs)
//   GET  /api/admin/overview                    -> { people (with their counts), waitlist }
//   POST /api/admin/invite     { email, send }  -> { link, mailed, mailError? }
//   POST /api/admin/revoke     { email }
//   GET  /api/admin/projects?person=            -> { projects }
//   GET  /api/admin/project?person=&id=         -> { versions }
//   GET  /api/admin/calls?person=               -> { calls } their latest model calls
//   GET  /api/admin/feedback?person=            -> { feedback } theirs, newest first
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { HttpError, json, readJson } from "./http.ts";
import type { Mailer } from "./mailer.ts";
import { listProjects, ownerOf, readIndex, readVersions } from "./projects.ts";

const COOKIE = "imagine_session";
const DAY_MS = 24 * 3600 * 1000;
const SESSION_MS = 90 * DAY_MS;
const EMAIL = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;
const PROJECT = /^[a-z0-9]{6,16}$/;
/** lastSeen is written at most this often per person. */
const SEEN_EVERY_MS = 60_000;
/** The model a tester draws with, as if it were the only one in the settings; the admin picks. Every other call is as the app makes it. */
const TESTER_DRAW_MODEL = "sonnet";
/** Per address and hour: waitlist sign-ups, join attempts that fail, and feedback sent. */
const WAITLIST_PER_HOUR = 5;
const BAD_JOINS_PER_HOUR = 20;
const FEEDBACK_PER_HOUR = 30;
/** Waitlist mails to the admin a day. Past it, sign-ups are only on the admin's page, and the mailer's daily quota is left for invites. */
const WAITLIST_MAILS_PER_DAY = 25;
/** The admin's view of someone's model calls: their newest, at most. */
const CALLS_SHOWN = 200;

export type Person = {
  id: string;
  email: string;
  /** Whose projects are theirs (projects.ts). */
  owner: string;
  admin?: boolean;
  invitedAt: number;
  /** When their current link was made. */
  linkAt: number;
  inviteHash: string;
  joinedAt?: number;
  lastSeen?: number;
  revokedAt?: number;
};
type Session = { hash: string; person: string; at: number; expires: number };
export type Waiting = { email: string; note: string; at: number; invitedAt?: number };
type Store = { people: Person[]; sessions: Session[]; waitlist: Waiting[] };
/** What someone wrote, and the project and version they were on when they did. */
export type Feedback = { at: number; person: string; text: string; project?: { id: string; name: string; version?: number } };

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const id = () => randomBytes(16).toString("hex");
export const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
const validEmail = (e: string) => e.length <= 200 && EMAIL.test(e);
/** A person as the admin's page shows them: no hashes. */
const shown = ({ inviteHash: _, ...p }: Person) => p;

/** The person a request was signed in as, once the gate has let it through. */
type Signed = IncomingMessage & { imaginePerson?: Person };
/** Whose projects a signed-in request works on (projects.ts' OwnerOf). */
export const ownerFrom = (req: IncomingMessage) => (req as Signed).imaginePerson?.owner;

const cookieOf = (req: IncomingMessage, name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1];
/** The visitor's address: Caddy, the only way in, sets X-Forwarded-For to it. */
const addressOf = (req: IncomingMessage) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
const baseOf = (req: IncomingMessage) => `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host}`;

export class Access {
  private store?: Store;
  private mtime = -1;
  private writing: Promise<unknown> = Promise.resolve();
  private hits = new Map<string, number[]>();
  /** When the waitlist mails of the last day went. */
  private waitlistMails: number[] = [];
  /** RT_DATA_DIR: the store goes in access/, and the model calls are read from model-calls.jsonl. */
  private root: string;
  private o: { mailer?: Mailer; publicUrl?: string; now?: () => number };

  // Plain fields, not parameter properties: the box runs this file with Node's type stripping.
  constructor(root: string, o: { mailer?: Mailer; publicUrl?: string; now?: () => number } = {}) {
    this.root = root;
    this.o = o;
  }

  private now = () => this.o.now?.() ?? Date.now();
  private get file() {
    return join(this.root, "access", "access.json");
  }

  private async load(): Promise<Store> {
    const m = await stat(this.file).then((s) => s.mtimeMs, () => 0);
    if (!this.store || m !== this.mtime) {
      try {
        this.store = JSON.parse(await readFile(this.file, "utf8")) as Store;
      } catch {
        this.store = { people: [], sessions: [], waitlist: [] };
      }
      this.mtime = m;
    }
    return this.store;
  }

  /** Changes the store and writes it whole, one change at a time; a change that throws writes nothing. */
  private change<T>(fn: (s: Store) => T): Promise<T> {
    const run = this.writing
      .catch(() => {})
      .then(async () => {
        const s = structuredClone(await this.load());
        const out = fn(s);
        await mkdir(join(this.root, "access"), { recursive: true });
        const tmp = join(this.root, "access", `.access.${randomBytes(4).toString("hex")}.tmp`);
        await writeFile(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
        await rename(tmp, this.file);
        this.store = s;
        this.mtime = (await stat(this.file)).mtimeMs;
        return out;
      });
    this.writing = run;
    return run;
  }

  /** A link for `email`, replacing any earlier one (and letting a revoked person back in). `base`: the site's address. `waitlisted`: they asked to try it. */
  invite(email: string, o: { admin?: boolean; base: string }) {
    const e = normEmail(email);
    if (!validEmail(e)) throw new HttpError(400, "That doesn't look like an email address.");
    const token = secret();
    return this.change((s) => {
      const now = this.now();
      let p = s.people.find((x) => x.email === e);
      if (!p) s.people.push((p = { id: id(), email: e, owner: id(), invitedAt: now, linkAt: now, inviteHash: "" }));
      p.inviteHash = hash(token);
      p.linkAt = now;
      delete p.revokedAt;
      if (o.admin) p.admin = true;
      const waiting = s.waitlist.filter((w) => w.email === e);
      for (const w of waiting) w.invitedAt = now;
      return { person: shown(p), link: `${(this.o.publicUrl ?? o.base).replace(/\/$/, "")}/join/${token}`, waitlisted: waiting.length > 0 };
    });
  }

  /** One piece of feedback, appended to the file. */
  private async keep(f: Feedback) {
    await mkdir(join(this.root, "access"), { recursive: true });
    await appendFile(join(this.root, "access", "feedback.jsonl"), `${JSON.stringify(f)}\n`, { mode: 0o600 });
  }

  /** Everyone's feedback, newest first (the admin's page shows each person theirs). */
  async feedback(): Promise<Feedback[]> {
    const text = await readFile(join(this.root, "access", "feedback.jsonl"), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Feedback)
      .reverse();
  }

  /** Signs a browser in with an invite link's token and the email it was sent to. `oldOwner`: an admin's projects from before invites. */
  join(token: string, email: string, oldOwner?: string) {
    const session = secret();
    return this.change((s) => {
      const now = this.now();
      const p = s.people.find((x) => x.inviteHash === hash(String(token)) && !x.revokedAt);
      if (!p) throw new HttpError(404, "This invite link doesn't work any more. Ask for a new one.");
      if (normEmail(email) !== p.email) throw new HttpError(403, "That isn't the email this invite was sent to.");
      if (!p.joinedAt) {
        p.joinedAt = now;
        if (p.admin && oldOwner) p.owner = oldOwner;
      }
      s.sessions = s.sessions.filter((x) => x.expires > now);
      s.sessions.push({ hash: hash(session), person: p.id, at: now, expires: now + SESSION_MS });
      return { person: shown(p), session };
    });
  }

  /** Who a request is signed in as. */
  async personOf(req: IncomingMessage): Promise<Person | undefined> {
    const t = cookieOf(req, COOKIE);
    if (!t) return;
    const s = await this.load();
    const session = s.sessions.find((x) => x.hash === hash(t) && x.expires > this.now());
    return session && s.people.find((p) => p.id === session.person && !p.revokedAt);
  }

  revoke(email: string) {
    return this.change((s) => {
      const p = s.people.find((x) => x.email === normEmail(email));
      if (!p) throw new HttpError(404, "Nobody with that email was invited.");
      p.revokedAt = this.now();
      s.sessions = s.sessions.filter((x) => x.person !== p.id);
    });
  }

  /** Adds an email to the waitlist; true if it wasn't on it. */
  wait(email: string, note: string) {
    return this.change((s) => {
      if (s.waitlist.some((w) => w.email === email)) return false;
      s.waitlist.push({ email, note, at: this.now() });
      return true;
    });
  }

  async overview() {
    const s = await this.load();
    const feedback = await this.feedback();
    const people = await Promise.all(
      s.people.map(async (p) => {
        const index = await readIndex(p.owner);
        return { ...shown(p), projects: index.length, versions: index.reduce((n, m) => n + m.versions, 0), feedback: feedback.filter((f) => f.person === p.id).length };
      }),
    );
    return { people, waitlist: s.waitlist };
  }

  /** A person's newest model calls, from the call log (dev/model-plugin.ts writes `who`). */
  async calls(person: string) {
    const text = await readFile(join(this.root, "model-calls.jsonl"), "utf8").catch(() => "");
    const out: unknown[] = [];
    for (const line of text.split("\n")) {
      if (!line.includes(person)) continue;
      try {
        const c = JSON.parse(line) as Record<string, unknown>;
        if (c.who !== person) continue;
        const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : v);
        out.push({ at: c.at, from: c.from, model: c.model, ms: c.ms, costUsd: c.costUsd, images: c.images, error: c.error, user: cut(c.user, 600), reply: cut(c.reply, 1200) });
      } catch {
        // torn line
      }
    }
    return out.slice(-CALLS_SHOWN).reverse();
  }

  /** Counts a hit against a per-address limit; false once it's over. */
  private allow(req: IncomingMessage, what: string, max: number) {
    const key = `${what} ${addressOf(req)}`;
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - 3600_000);
    recent.push(now);
    this.hits.set(key, recent);
    return recent.length <= max;
  }

  /** Whether another waitlist mail fits in WAITLIST_MAILS_PER_DAY; counts it if so. */
  private mailsLeftToday() {
    const now = this.now();
    this.waitlistMails = this.waitlistMails.filter((t) => t > now - 86_400_000);
    if (this.waitlistMails.length >= WAITLIST_MAILS_PER_DAY) return false;
    this.waitlistMails.push(now);
    return true;
  }

  private async touch(p: Person) {
    if (this.now() - (p.lastSeen ?? 0) < SEEN_EVERY_MS) return;
    await this.change((s) => {
      const q = s.people.find((x) => x.id === p.id);
      if (q) q.lastSeen = this.now();
    }).catch((err) => console.error("lastSeen", err));
  }

  /**
   * In front of everything (host.ts): answers the access and admin routes, and refuses every other API
   * route to a browser that isn't signed in. True if it answered; otherwise the request goes on, marked
   * with its person (ownerFrom, and X-Imagine-Person for the model call log), and a tester's
   * with the one model they draw with (X-Imagine-Draw-Model). Neither header is ever taken
   * from the page.
   */
  async gate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    delete req.headers["x-imagine-person"];
    delete req.headers["x-imagine-draw-model"];
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      const person = await this.personOf(req);
      if (url.pathname.startsWith("/api/access/")) await this.public(url, req, res, person);
      else if (!person) json(res, 401, { error: "Sign in with your invite link first." });
      else if (url.pathname.startsWith("/api/admin/")) {
        if (!person.admin) json(res, 403, { error: "Only the admin can see this." });
        else await this.admin(url, req, res);
      } else {
        void this.touch(person);
        (req as Signed).imaginePerson = person;
        req.headers["x-imagine-person"] = person.id;
        if (!person.admin) req.headers["x-imagine-draw-model"] = TESTER_DRAW_MODEL;
        return false;
      }
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (!res.headersSent) json(res, err instanceof HttpError ? err.status : 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  private cookie(req: IncomingMessage, value: string, maxAgeS: number) {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    // Lax, not Strict: the first visit from an invite email is a link from another site.
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`;
  }

  private async public(url: URL, req: IncomingMessage, res: ServerResponse, person?: Person) {
    const route = url.pathname.slice("/api/access/".length);
    if (route === "me") return json(res, 200, { person: person ? { email: person.email, admin: !!person.admin } : null });
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    if (route === "join") {
      const b = await readJson<{ token?: string; email?: string }>(req);
      try {
        const { person: p, session } = await this.join(String(b.token ?? ""), String(b.email ?? ""), ownerOf(req));
        res.setHeader("Set-Cookie", this.cookie(req, session, SESSION_MS / 1000));
        return json(res, 200, { person: { email: p.email, admin: !!p.admin } });
      } catch (err) {
        if (!this.allow(req, "join", BAD_JOINS_PER_HOUR)) throw new HttpError(429, "Too many tries. Wait an hour and use the link from your invite.");
        throw err;
      }
    }
    if (route === "signout") {
      const t = cookieOf(req, COOKIE);
      if (t) await this.change((s) => void (s.sessions = s.sessions.filter((x) => x.hash !== hash(t))));
      res.setHeader("Set-Cookie", this.cookie(req, "", 0));
      return json(res, 200, { ok: true });
    }
    if (route === "feedback") {
      if (!person) throw new HttpError(401, "Sign in with your invite link first.");
      if (!this.allow(req, "feedback", FEEDBACK_PER_HOUR)) throw new HttpError(429, "That's a lot of feedback at once. Try again in a little while.");
      const b = await readJson<{ text?: string; project?: string; version?: number }>(req, 20_000);
      const text = String(b.text ?? "").trim().slice(0, 4000);
      if (!text) throw new HttpError(400, "Write something first.");
      // A project is named only if it's one of theirs, and a version only if the project has it.
      const id = String(b.project ?? "");
      const meta = PROJECT.test(id) ? (await readIndex(person.owner)).find((m) => m.id === id) : undefined;
      const v = Number(b.version);
      const project = meta && { id: meta.id, name: meta.name, ...(Number.isInteger(v) && v >= 1 && v <= meta.versions && { version: v }) };
      await this.keep({ at: this.now(), person: person.id, text, ...(project && { project }) });
      return json(res, 200, { ok: true });
    }
    if (route === "waitlist") {
      if (!this.allow(req, "waitlist", WAITLIST_PER_HOUR)) throw new HttpError(429, "That's a lot of sign-ups from here. Try again in an hour.");
      const b = await readJson<{ email?: string; note?: string; website?: string }>(req, 20_000);
      // The field people never see: a bot that fills it in is told yes and kept nowhere.
      if (b.website) return json(res, 200, { ok: true });
      const email = normEmail(b.email);
      if (!validEmail(email)) throw new HttpError(400, "That doesn't look like an email address.");
      const note = String(b.note ?? "").trim().slice(0, 1000);
      if ((await this.wait(email, note)) && this.mailsLeftToday()) this.o.mailer?.({ action: "waitlist", email, note }).catch((err) => console.error("waitlist mail", err));
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "no such route" });
  }

  private async admin(url: URL, req: IncomingMessage, res: ServerResponse) {
    const route = url.pathname.slice("/api/admin/".length);
    const q = (k: string) => url.searchParams.get(k) ?? "";
    const ownerOfPerson = async () => {
      const p = (await this.load()).people.find((x) => x.id === q("person"));
      if (!p) throw new HttpError(404, "Nobody with that id.");
      return p.owner;
    };
    if (req.method === "GET") {
      if (route === "overview") return json(res, 200, await this.overview());
      if (route === "projects") return json(res, 200, { projects: await listProjects(await ownerOfPerson()) });
      if (route === "project") {
        const owner = await ownerOfPerson();
        if (!PROJECT.test(q("id")) || !(await readIndex(owner)).some((m) => m.id === q("id"))) throw new HttpError(404, "no such project");
        return json(res, 200, { versions: await readVersions(owner, q("id")) });
      }
      if (route === "calls") return json(res, 200, { calls: await this.calls(q("person")) });
      if (route === "feedback") return json(res, 200, { feedback: (await this.feedback()).filter((f) => f.person === q("person")) });
      return json(res, 404, { error: "no such route" });
    }
    if (req.method !== "POST") return json(res, 405, { error: "GET or POST" });
    const b = await readJson<{ email?: string; send?: boolean }>(req);
    if (route === "invite") {
      const { link, waitlisted } = await this.invite(String(b.email ?? ""), { base: baseOf(req) });
      if (!b.send) return json(res, 200, { link, mailed: false });
      if (!this.o.mailer) return json(res, 200, { link, mailed: false, mailError: "Mail isn't set up yet: copy the link and send it yourself." });
      try {
        await this.o.mailer({ action: "invite", email: normEmail(b.email), link, waitlisted });
        return json(res, 200, { link, mailed: true });
      } catch (err) {
        return json(res, 200, { link, mailed: false, mailError: err instanceof Error ? err.message : String(err) });
      }
    }
    if (route === "revoke") {
      await this.revoke(String(b.email ?? ""));
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "no such route" });
  }
}
