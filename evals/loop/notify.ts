// The owner's mail when the loop needs them, and only then: a stop that's theirs to look at, a decision held for them,
// the loop's unit failing past its restarts. It goes through imagine's own mailer (deploy/mailer.gs, action "notice"),
// to the admin's inbox, with the harness's words and ids only: never a tester's, never an error's text.
// The mailer's address and secret are in ~/.config/rt-eval/notify.env (mode 600, outside every repo):
//   MAILER_URL=https://script.google.com/macros/s/…/exec   MAILER_SECRET=<its NOTICE_SECRET, which sends notices only>
//   HQ_URL=http://<the PGX>:5181/evals/progress/
// Without the file a notice is the log line alone.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const notifyFile = () => process.env.RT_NOTIFY_ENV || join(homedir(), ".config", "rt-eval", "notify.env");

/** The mailer's settings, or why there are none. A file others can read is refused: it holds the mailer's secret. */
export function mailerOf(file = notifyFile()): { url: string; secret: string; hq?: string } | { none: string } {
  if (!existsSync(file)) return { none: `no ${file}` };
  if ((statSync(file).mode & 0o077) !== 0) return { none: `${file} must be mode 600` };
  const env = parseEnv(readFileSync(file, "utf8"));
  if (!env.MAILER_URL || !env.MAILER_SECRET) return { none: `${file} needs MAILER_URL and MAILER_SECRET` };
  return { url: env.MAILER_URL, secret: env.MAILER_SECRET, hq: env.HQ_URL };
}

/** One notice to the owner: always the log; mailed when notify.env is set. Never throws: a notice stops nothing. */
export async function tellOwner(log: { say(line: string): void }, subject: string, lines: string[]) {
  const m = mailerOf();
  if ("none" in m) return log.say(`notice: ${subject} (not mailed: ${m.none})`);
  const text = [...lines, ...(m.hq ? ["", m.hq] : [])].join("\n");
  try {
    // Plain text: Apps Script refuses anything that needs a preflight, and answers by redirecting to the result.
    const res = await fetch(m.url, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify({ secret: m.secret, action: "notice", subject, text }), redirect: "follow", signal: AbortSignal.timeout(20_000) });
    const out = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok?: boolean; error?: string };
    log.say(out.ok ? `notice: ${subject} (mailed)` : `notice: ${subject} (not mailed: ${out.error ?? "the mailer refused it"})`);
  } catch (err) {
    log.say(`notice: ${subject} (not mailed: ${err instanceof Error ? err.message : String(err)})`);
  }
}
