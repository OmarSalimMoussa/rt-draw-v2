// The reply cache and in-case sharing (spec §7.3, F15, N2). A reply is stored once
// per request hash (model, system, user, images, effort, thinking) with the time
// each chunk arrived, so it can be replayed on its own clock; request images are
// stored once as blobs. Driver and judge replies are kept per run: reused on a
// resume, never served to another run.
//
// Sharing: when both arms of a case send a byte-identical request, one real call
// is made for whichever asked first, and the other gets each chunk at its own
// request time plus the offset the leader saw. A follower never joins a stream
// mid-flight: a late joiner would hide any slowdown before its call.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Paths, isRealCase, underReal } from "./paths.ts";
import type { RecordedReply } from "./types.ts";

/** What a request is, for its hash: images by blob hash. */
export type Req = { model: string; system: string; user: string | string[]; images: string[]; effort: string; thinking: string };
export type Chunk = { ms: number; text: string };
export type Reply = { reqHash: string; run: string; role: string; at: string; request: Req; text: string; chunks: Chunk[]; doneMs: number; stats: Record<string, unknown> };

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
export const reqHash = (r: Req) => sha256(JSON.stringify([r.model, r.system, r.user, r.images, r.effort, r.thinking]));

/** Writes each data: URL's bytes once as cache/blobs/<sha256>.jpg (a real run's or real send's under real/); returns the hashes. */
export function storeImages(p: Paths, urls: string[], run = "-", caseId?: string): string[] {
  return urls.map((url) => {
    const bytes = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    const sha = sha256(bytes);
    const file = p.blob(sha, underReal(run, caseId));
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    return sha;
  });
}

/** Eval calls' replies are per run (a resume reuses them; another run never sees them); product replies are per request. */
const nameOf = (hash: string, run: string, perRun: boolean) => (perRun ? sha256(`${run}\n${hash}`) : hash);
export const replyName = (hash: string, run: string, perRun: boolean) => `${nameOf(hash, run, perRun)}.json`;

export function readReply(p: Paths, hash: string, run: string, perRun: boolean, caseId?: string): Reply | undefined {
  const file = p.reply(nameOf(hash, run, perRun), underReal(run, caseId));
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Reply) : undefined;
}

/** Stores a reply (the first one for its name stays: it's the one the bank recorded). Returns its file name, a real run's whole path. */
export function writeReply(p: Paths, r: Reply, perRun: boolean, caseId?: string): string {
  const name = nameOf(r.reqHash, r.run, perRun), real = underReal(r.run, caseId);
  const file = p.reply(name, real);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(r));
  }
  return real ? file : `${name}.json`;
}

const sleepUntil = (t: number) => new Promise((r) => setTimeout(r, Math.max(0, t - performance.now())));

/** Plays recorded chunks from `t0` (performance.now()) on their own offsets, or all at once. */
export async function replay(chunks: Chunk[], doneMs: number, t0: number, onText: (t: string) => void, instant = false) {
  for (const c of chunks) {
    if (!instant) await sleepUntil(t0 + c.ms);
    onText(c.text);
  }
  if (!instant) await sleepUntil(t0 + doneMs);
}

/** One real call's chunks as they arrive, for an arm that sent the same request. */
/** `stopped`: its page dropped it with nobody following, so nobody may follow it now (its reply would be cut short). */
export type Flight = { arm: string; chunks: Chunk[]; done?: { ms: number; stats?: Record<string, unknown>; error?: string; cacheFile?: string }; wake: (() => void)[]; followers: Set<string>; stopped?: boolean };

export class Flights {
  private m = new Map<string, Flight[]>();

  /** A flight the other arm leads for this request in this case that this arm hasn't followed yet. */
  follow(scope: string, hash: string, arm: string): Flight | undefined {
    const f = this.m.get(`${scope}|${hash}`)?.find((x) => x.arm !== arm && !x.followers.has(arm) && !x.stopped);
    f?.followers.add(arm);
    return f;
  }

  lead(scope: string, hash: string, arm: string): Flight {
    const f: Flight = { arm, chunks: [], wake: [], followers: new Set() };
    const key = `${scope}|${hash}`;
    this.m.set(key, [...(this.m.get(key) ?? []), f]);
    return f;
  }

  static push(f: Flight, c: Chunk) {
    f.chunks.push(c);
    for (const w of f.wake.splice(0)) w();
  }

  static end(f: Flight, done: NonNullable<Flight["done"]>) {
    f.done = done;
    for (const w of f.wake.splice(0)) w();
  }

  /** A follower's delivery: chunk i at its own t0 plus the leader's offset (waiting for the chunk when the leader hasn't got it yet). */
  static async relay(f: Flight, t0: number, onText: (t: string) => void): Promise<NonNullable<Flight["done"]>> {
    for (let i = 0; ; i++) {
      while (i >= f.chunks.length && !f.done) await new Promise<void>((r) => f.wake.push(r));
      if (i >= f.chunks.length) break;
      await sleepUntil(t0 + f.chunks[i].ms);
      onText(f.chunks[i].text);
    }
    await sleepUntil(t0 + f.done!.ms);
    return f.done!;
  }

  /** The case is over: its flights go. */
  drop(scope: string) {
    for (const k of this.m.keys()) if (k.startsWith(`${scope}|`)) this.m.delete(k);
  }
}

/**
 * A scan's stand-in for a request the bank never saw (N2): the case's recorded reply for the same
 * picture subject (pictures run side by side, so their order isn't stable), else for the same role and ordinal.
 */
export function standIn(p: Paths, caseId: string, role: string, ordinal: number, user: string | string[]): Reply | undefined {
  const file = join(p.bankCase(caseId), "replies.json");
  if (!existsSync(file)) return;
  const recorded = (JSON.parse(readFileSync(file, "utf8")) as RecordedReply[]).filter((r) => !r.copy);
  const text = Array.isArray(user) ? user.join("\n") : user;
  const hit = recorded.find((r) => r.role === role && r.subject && text.includes(r.subject)) ?? recorded.find((r) => r.role === role && r.ordinal === ordinal);
  const reply = hit && p.reply(basename(hit.cacheFile, ".json"), isRealCase(caseId));
  return reply && existsSync(reply) ? (JSON.parse(readFileSync(reply, "utf8")) as Reply) : undefined;
}
