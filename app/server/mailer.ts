// Mail, sent through the Apps Script web app in deploy/mailer.gs: it runs as the admin's
// Workspace account, so a waitlist sign-up reaches the admin's inbox and an invite reaches
// the person from the admin's own address, with no mail service or password in between.
// Only this server calls it, with the secret both sides hold (MAILER_SECRET).

/** `waitlisted`: they signed up on the waitlist, so the invite can say they asked for it. */
export type Mail = { action: "waitlist"; email: string; note: string } | { action: "invite"; email: string; link: string; waitlisted: boolean };
/** Sends one mail; throws if it didn't go. */
export type Mailer = (m: Mail) => Promise<void>;

export function appsScript(url: string, secret: string): Mailer {
  return async (m) => {
    // Plain text: Apps Script refuses anything that needs a preflight, and answers by redirecting to the result.
    const res = await fetch(url, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify({ secret, ...m }), redirect: "follow", signal: AbortSignal.timeout(20_000) });
    const out = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok?: boolean; error?: string };
    if (!out.ok) throw new Error(out.error || "the mailer didn't send it");
  };
}
