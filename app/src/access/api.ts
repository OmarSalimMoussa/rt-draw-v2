// Who this browser is signed in as on the hosted app (app/server/access.ts), and the calls the
// access pages make: joining with an invite, the waitlist, signing out, and the admin's views.

export type Me = { email: string; admin: boolean };
export type Person = { id: string; email: string; admin?: boolean; invitedAt: number; linkAt: number; joinedAt?: number; lastSeen?: number; revokedAt?: number; projects: number; versions: number };
export type Waiting = { email: string; note: string; at: number; invitedAt?: number };
export type Invited = { link: string; mailed: boolean; mailError?: string };
export type Call = { at: string; from?: string; model?: string; ms?: number; costUsd?: number; images?: number; error?: string; user?: string; reply?: string };

let me: Me | null | undefined;

/** Who's signed in: a person, null for nobody, undefined where there are no invites (the dev server). */
export async function whoAmI(): Promise<Me | null | undefined> {
  const r = await fetch("/api/access/me");
  me = r.status === 404 ? undefined : ((await r.json()) as { person: Me | null }).person;
  return me;
}
export const currentMe = () => me;

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Something went wrong (HTTP ${r.status}).`);
  return out;
}

export const join = (token: string, email: string) => call<{ person: Me }>("/api/access/join", { token, email });
export const joinWaitlist = (email: string, note: string, website: string) => call<{ ok: true }>("/api/access/waitlist", { email, note, website });
export const signOut = () => call<{ ok: true }>("/api/access/signout", {});

export const overview = () => call<{ people: Person[]; waitlist: Waiting[] }>("/api/admin/overview");
export const invite = (email: string, send: boolean) => call<Invited>("/api/admin/invite", { email, send });
export const revoke = (email: string) => call<{ ok: true }>("/api/admin/revoke", { email });
export const theirProjects = (person: string) => call<{ projects: { id: string; name: string; pages: number; versions: number; updatedAt: number; latest?: unknown }[] }>(`/api/admin/projects?person=${person}`);
export const theirProject = (person: string, id: string) => call<{ versions: { n: number; at: number; label: string; doc: unknown }[] }>(`/api/admin/project?person=${person}&id=${id}`);
export const theirCalls = (person: string) => call<{ calls: Call[] }>(`/api/admin/calls?person=${person}`);
