// Every model call the eval makes goes through here (spec §7.3): the arm pages'
// /api/model (the dev plugin's NDJSON protocol, labelled by CDP with x-rt-run,
// x-rt-case, x-rt-arm, x-rt-slot and optionally x-rt-role and x-rt-at) and the eval roles'
// POST /call (client.ts). It runs as its own process: run.ts also does CDP
// traffic, screenshot decoding, hashing, statistics and tsc spawns, and a stall
// in its event loop would delay chunks to both arms and skew a follower's timed
// delivery. The loop's delay p99 is reported per case (V9 voids a case above 20 ms).
//
// Product calls are never queued (a queue would read as model latency) and pool
// per (arm, case slot, token, model, system, effort, thinking), so each slot
// behaves like one user's server; eval roles run at most 6 at once and never pool.
// A run is live (fresh calls, shared inside a case unless the run says share: false),
// replay (cached replies on their own clock) or scan (instant: a hit, else the case's
// stand-in, else empty; a warm scan also starts the processes its calls would take; a timed
// scan plays them on their recorded clock, so a render-only decision's first drawing means something). Only eval calls resume from the cache within their run: a
// product call is a fresh sample (or the other arm's, shared) in every live run,
// except the request hashes the run names as identical in both arms (the diffscan
// found them): those come from the bank cache on their recorded clock, for both.
// --cap n refuses call n+1: a loop or retry bug stops there instead of burning a window.
// A Jev call (model "jev-…", dev/jev.ts) takes the same road without a process, a pool
// or a token slot: TYPESAFE_API_KEY from the tokens file, or the fake API with --mock-api.
//
//   node --import ./evals/loop/node-hooks.mjs evals/loop/gateway.ts [--port n] [--cap n]
//        [--tokens <file> | --dev-token [<checkout>]] [--mock-api <url>] [--home <dir>]
// prints "READY <url>"; exits when its stdin closes (run.ts went away).
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { CallError, type CallStats, EFFORTS, type Effort, MODEL_IDS, type MockApi, Pool, type Proc, SDK_VERSION, type Thinking, keepOf, keyOf, startProcess, streamCall, toContent } from "../../dev/claude.ts";
import { JEV_SETTINGS, callJev, isJev } from "../../dev/jev.ts";
import { type Chunk, Flights, type Req, readReply, replay, replyName, reqHash, standIn, storeImages, writeReply } from "./cache.ts";
import { listUsd, meterCall } from "./meter.ts";
import { type Paths, paths } from "./paths.ts";
import { type SlotN, Slots, type Token, loadDevToken, loadJevKey, loadTokens } from "./tokens.ts";
import type { Arm, CallMode, RecordedReply, Shared } from "./types.ts";

/** Eval-role calls in flight at once, at most. */
export const EVAL_IN_FLIGHT = 6;
/** Waiting processes per pool key, at most (today's MAX_WARM, so picture.parallel still gets its pool). */
const MAX_WARM = 4;
/** An overload fails in ~2 s, not 102 s: the case is voided and replayed. */
const MAX_RETRIES = 2;
/** A product call's limit, as on the hosted app (dev/model-plugin.ts). */
const TIMEOUT_MS = 120_000;
/**
 * An eval role's hang guard, never a limit on its work: gold is never throttled (the owner, 2026-10-25), so its guard is
 * over twice the slowest gold ever drawn (38 min at max effort); every other role finished within 2 min in history.
 */
const evalHangMs = (role: string) => (role === "real-gold" ? 90 : 15) * 60_000;
/**
 * An eval role's output, at most: the model's own maximum. Only the product's calls keep MAX_TOKENS, as the hosted app
 * does: gold is the ideal the product aims at, so nothing throttles it (nor triage, the judge or the analyst).
 */
const EVAL_MAX_TOKENS = 128_000;
const LOOP_RESOLUTION_MS = 10;
const LATE_MAX_MS = 1000;
/** A warm scan's case end waits this long, at most, for the processes it started to finish starting. */
const WARM_WAIT_MS = 20_000;
/**
 * Starting a Claude process blocks this loop ~6–12 ms (20–27 ms measured on the busy shared laptop): every start
 * goes through one queue, this far apart, so the starts of two arms and several slots never stack. A call that has
 * no waiting process is served first; pool top-ups, the page's warm requests and eval roles wait their turn.
 */
const SPAWN_GAP_MS = 25;

export type RunMode = "live" | "replay" | "scan";
type Ask = {
  run: string; case?: string; arm?: string; slot?: number; role: string; ordinal: number;
  /** performance.now() when the request was sent (x-rt-at) or got here: every offset counts from it */ t0: number;
  /** an arm page's call (pooled, shared), not an eval role's */ page: boolean;
  req: Req; hash: string; images: string[]; warm?: number; token?: SlotN;
  /** the page went away (it dropped the call: resolve.speculate, a cancel): a call no other arm follows stops */ gone?: AbortSignal;
  /** copy n (2 or more) of one answer (draw.copies, picture.copies): the page keeps whichever copy streams first */ copy?: number;
};
type Out = {
  text: string; stats: Record<string, unknown>; mode: CallMode; shared: Shared; scan?: "hit" | "standin" | "miss"; error?: string; cacheFile?: string; chunks: Chunk[];
  /** a real call was made: its list $ and token slot (none for Jev) */ upstream?: { usd: number; token?: SlotN };
  /** refused before any call (the cap, `capped`): no meter line */ refused?: boolean; capped?: boolean;
  /** its page dropped it (a copy that lost, a speculation that missed, a picture past its timeout): no error */ dropped?: boolean;
};
/** A case's loop delays by whole ms (the last bucket: LATE_MAX_MS and more), a fixed size however long the case runs. */
type CaseState = { lates: Uint32Array; ordinals: Map<string, number>; calls: Record<string, RecordedReply[]>; /** a warm scan's processes, settled once up */ ups: Promise<void>[] };

const flat = (s: CallStats) => ({
  inTokens: s.inTokens, outTokens: s.outTokens, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, write5m: s.write5m, write1h: s.write1h, thinkingTokens: s.thinkingTokens,
  thinkingBlocks: s.thinkingBlocks, stopReason: s.stopReason, served: s.served, costUsd: s.costUsd, retries: s.retries, rateLimit: s.rateLimit,
});
const n = (x: unknown) => (typeof x === "number" ? x : 0);

async function startGateway(o: { p: Paths; tokens: Token[]; cap?: number; mockApi?: MockApi; port?: number; jevKey?: string }) {
  const { p, cap } = o;
  const slots = new Slots(o.tokens.map((t) => t.slot), join(p.home, "meter", "slots.json"));
  const same = slots.sameAccount();
  if (same) throw new Error(`slots ${same[0]} and ${same[1]} report the same resetsAt: they are one account (use three different loop accounts)`);
  const tokenOf = (slot: SlotN) => o.tokens.find((t) => t.slot === slot)!.token;
  const pool = new Pool();
  const flights = new Flights();
  const runs = new Map<string, { mode: RunMode; share: boolean; cached?: Set<string>; warm?: boolean; timed?: boolean }>();
  const cases = new Map<string, CaseState>();
  // The loop's delay, sampled every LOOP_RESOLUTION_MS into each open case: how late a tick ran, less the time spent
  // starting processes since the last one. The starts are the harness's own and spaced (SPAWN_GAP_MS); counted, a
  // run's first cases (every pool starting) tripped V9 on them alone, and V9 is about every other delay.
  let tick = performance.now(), starting = 0;
  const sampler = setInterval(() => {
    const now = performance.now(), late = Math.max(0, now - tick - LOOP_RESOLUTION_MS - starting);
    [tick, starting] = [now, 0];
    for (const c of cases.values()) c.lates[Math.min(LATE_MAX_MS, Math.round(late))]++;
  }, LOOP_RESOLUTION_MS);
  sampler.unref();
  let calls = 0;
  let evalBusy = 0;
  const evalWaiting: (() => void)[] = [];

  const start = (r: Req, slot: SlotN, evalRole = false) => () =>
    startProcess(r.model, r.system, { token: tokenOf(slot), effort: r.effort as Effort, thinking: r.thinking as Thinking, configDir: p.claudeConfig, maxRetries: MAX_RETRIES, mockApi: o.mockApi, ...(evalRole ? { maxTokens: EVAL_MAX_TOKENS } : {}) });
  const spawnQueue: (() => void)[] = [];
  let lastSpawn = -Infinity;
  let spawnTimer: ReturnType<typeof setTimeout> | undefined;
  const pump = () => {
    if (spawnTimer || !spawnQueue.length) return;
    const wait = lastSpawn + SPAWN_GAP_MS - performance.now();
    if (wait > 0) return void (spawnTimer = setTimeout(() => ((spawnTimer = undefined), pump()), wait));
    const t0 = performance.now();
    spawnQueue.shift()!();
    lastSpawn = performance.now();
    starting += lastSpawn - t0;
    pump();
  };
  const later = (f: () => void, first = false) => (first ? spawnQueue.unshift(f) : spawnQueue.push(f), pump());
  const queued = (s: () => Proc, first = false) => new Promise<Proc>((r) => later(() => r(s()), first));
  /** Tops a pool key up to `keep` waiting processes, one start per turn; `ups` gets a promise per turn, settled once its starts are up. */
  const topUp = (key: string, keep: number, s: () => Proc, ups?: Promise<void>[]) => {
    for (let k = 1; k <= Math.min(keep, MAX_WARM); k++) {
      let settle = () => {};
      ups?.push(new Promise<void>((r) => (settle = r)));
      later(() => {
        const started: Proc[] = [];
        pool.warm(key, k, () => (started.push(s()), started.at(-1)!));
        void Promise.allSettled(started.map((x) => x.ready)).then(() => settle());
      });
    }
  };
  const poolKey = (a: Pick<Ask, "arm" | "slot" | "req">, slot: SlotN) => `${a.arm ?? "-"}|${a.slot ?? "-"}|t${slot}|${keyOf(a.req.model, a.req.system, a.req.effort as Effort, a.req.thinking as Thinking)}`;

  /** A case's first request is a case boundary: new processes may move to the next token there. */
  function caseOf(run: string, id: string): CaseState {
    const key = `${run}|${id}`;
    let c = cases.get(key);
    if (!c) {
      slots.boundary();
      cases.set(key, (c = { lates: new Uint32Array(LATE_MAX_MS + 1), ordinals: new Map(), calls: {}, ups: [] }));
    }
    return c;
  }

  async function evalTurn() {
    if (evalBusy >= EVAL_IN_FLIGHT) await new Promise<void>((r) => evalWaiting.push(r));
    evalBusy++;
  }
  const evalDone = () => {
    evalBusy--;
    evalWaiting.shift()?.();
  };

  async function live(a: Ask, onText: (t: string) => void, flight?: ReturnType<Flights["lead"]>): Promise<Out> {
    const since = () => performance.now() - a.t0;
    const refuse = (error: string): Out => (flight && Flights.end(flight, { ms: since(), error }), { text: "", stats: {}, mode: "live", shared: "-", error, chunks: [], refused: true });
    if (cap !== undefined && calls >= cap) return { ...refuse(`call cap ${cap} reached`), capped: true };
    const same = slots.sameAccount();
    if (same) return refuse(`slots ${same[0]} and ${same[1]} report the same resetsAt: one account`);
    calls++;
    if (isJev(a.req.model)) return jevLive(a, since, onText, flight);
    if (!a.page) await evalTurn();
    const token = a.token ?? (a.page ? slots.current : (slots.boundary() ?? slots.current));
    const key = poolKey(a, token);
    const taken = a.page && pool.sizes()[key] ? pool.take(key, 0, start(a.req, token)) : { proc: await queued(start(a.req, token, !a.page), a.page), waiting: false, readyAtTake: false };
    if (a.page) topUp(key, keepOf(a.warm, MAX_WARM), start(a.req, token));
    // Closing the query ends its stream cleanly, so what stopped it is noted: a reply cut short is never a reply.
    let stopped: "page" | "timer" | undefined;
    // A product call has the hosted app's limit; an eval role only a hang guard (Claude Code's own stream-idle watchdog
    // ends a dead connection, and the API's pings keep a long think alive, but a process that never answers holds a
    // step forever).
    const limitMs = a.page ? TIMEOUT_MS : evalHangMs(a.role);
    const late = `no reply within ${limitMs / 1000} s`;
    const timer = setTimeout(() => ((stopped ??= "timer"), taken.proc.q.close()), limitMs);
    // A page that dropped its call stops it, unless another arm's identical call is waiting on this one; none may join after.
    const stop = () => {
      if (flight?.followers.size) return;
      if (flight) flight.stopped = true;
      stopped ??= "page";
      taken.proc.q.close();
    };
    if (a.gone?.aborted) stop();
    a.gone?.addEventListener("abort", stop);
    const chunks: Chunk[] = [];
    let waitMs: number | undefined;
    const head = { warm: taken.waiting, readyAtTake: taken.readyAtTake, token };
    try {
      await taken.proc.ready;
      waitMs = since();
      const { text, stats } = await streamCall(taken.proc, toContent(a.req.user, a.images), (t) => {
        const c = { ms: since(), text: t };
        chunks.push(c);
        if (flight) Flights.push(flight, c);
        onText(t);
      });
      const st = { ...head, ...flat(stats), ms: since(), firstMs: chunks[0]?.ms, waitMs };
      const usd = listUsd(a.req.model, { inTokens: stats.inTokens, cacheRead: stats.cacheRead, cacheWrite5m: stats.write5m, cacheWrite1h: stats.write1h, outTokens: stats.outTokens });
      slots.record(token, { usd, rateLimit: stats.rateLimit });
      // Stopped, by its page or the timeout: whatever came is cut short, so it's never cached, followed or replayed.
      if (stopped) {
        if (flight) Flights.end(flight, { ms: st.ms, error: stopped === "page" ? "dropped by its page" : late });
        return { text: "", stats: st, mode: "live", shared: "-", ...(stopped === "page" ? { dropped: true } : { error: late }), chunks, upstream: { usd, token } };
      }
      const cacheFile = writeReply(p, { reqHash: a.hash, run: a.run, role: a.role, at: new Date().toISOString(), request: a.req, text, chunks, doneMs: st.ms, stats: st }, !a.page);
      if (flight) Flights.end(flight, { ms: st.ms, stats: st, cacheFile });
      return { text, stats: st, mode: "live", shared: flight?.followers.size ? "leader" : "-", chunks, cacheFile, upstream: { usd, token } };
    } catch (err) {
      const error = stopped === "timer" ? late : err instanceof Error ? err.message : String(err);
      const s = err instanceof CallError ? err.stats : undefined;
      const usd = s ? listUsd(a.req.model, { inTokens: s.inTokens, cacheRead: s.cacheRead, cacheWrite5m: s.write5m, cacheWrite1h: s.write1h, outTokens: s.outTokens }) : 0;
      slots.record(token, { usd, rateLimit: s?.rateLimit, limited: /rate.?limit/i.test(error) });
      if (flight) Flights.end(flight, { ms: since(), error });
      // A call its page dropped (stop() closed it) is the product's own choice, never a transport failure (V7): recorded
      // as an error, it voided or lost the case of every copies card and every speculation that missed.
      const dropped = stopped === "page";
      return { text: "", stats: { ...head, ...(s ? flat(s) : {}), ms: since(), waitMs }, mode: "live", shared: "-", ...(dropped ? { dropped } : { error }), chunks, upstream: { usd, token } };
    } finally {
      clearTimeout(timer);
      a.gone?.removeEventListener("abort", stop);
      taken.proc.q.close();
      if (!a.page) evalDone();
    }
  }

  /** A Jev call: one chunk (the answers' JSON); in checks the fake API's, never the real Jev. */
  async function jevLive(a: Ask, since: () => number, onText: (t: string) => void, flight?: ReturnType<Flights["lead"]>): Promise<Out> {
    const key = o.mockApi ? "mock" : (o.jevKey ?? "");
    try {
      const { text, stats } = await callJev(key, a.req.model, String(a.req.user), { baseUrl: o.mockApi?.baseUrl });
      const c = { ms: since(), text };
      if (flight) Flights.push(flight, c);
      onText(text);
      const st = { ...stats, ms: since(), firstMs: c.ms, settings: JEV_SETTINGS };
      const usd = listUsd(a.req.model, { inTokens: stats.inTokens, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, outTokens: stats.outTokens });
      const cacheFile = writeReply(p, { reqHash: a.hash, run: a.run, role: a.role, at: new Date().toISOString(), request: a.req, text, chunks: [c], doneMs: st.ms, stats: st }, !a.page);
      if (flight) Flights.end(flight, { ms: st.ms, stats: st, cacheFile });
      return { text, stats: st, mode: "live", shared: flight?.followers.size ? "leader" : "-", chunks: [c], cacheFile, upstream: { usd } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (flight) Flights.end(flight, { ms: since(), error });
      return { text: "", stats: { ms: since() }, mode: "live", shared: "-", error, chunks: [], upstream: { usd: 0 } };
    }
  }

  async function serve(a: Ask, onText: (t: string) => void): Promise<Out> {
    const { mode, share, cached, warm, timed } = runs.get(a.run) ?? { mode: "live", share: true };
    const instant = mode === "scan" && !!a.page && !timed;
    // A warm scan (ab.ts' warm-up send, a slot's first in a live run) starts the processes each call would take.
    if (warm && a.page) topUp(poolKey(a, slots.current), keepOf(a.warm, MAX_WARM), start(a.req, slots.current), a.case ? cases.get(`${a.run}|${a.case}`)?.ups : undefined);
    // A copy is another draw of the upstream wait: live, a fresh call of its own (never the cache's, never another arm's);
    // in a scan or a replay it answers nothing, so its first copy's reply decides and the page drops it.
    if (a.copy) return mode === "live" ? live(a, onText) : held(a, mode);
    // An eval call this run already made (a resume); in replay and scan any product reply the cache holds; in live the run's named ones.
    const hit = !a.page || mode !== "live" || cached?.has(a.hash) ? readReply(p, a.hash, a.run, !a.page) : undefined;
    if (hit) {
      await replay(hit.chunks, hit.doneMs, a.t0, onText, instant);
      return { text: hit.text, stats: hit.stats, mode: !a.page ? "resume" : mode === "live" ? "replay" : mode, shared: "-", chunks: hit.chunks, cacheFile: replyName(a.hash, a.run, !a.page), scan: mode === "scan" && a.page ? "hit" : undefined };
    }
    if (mode === "scan" && a.page) {
      const s = a.case ? standIn(p, a.case, a.role, a.ordinal, a.req.user) : undefined;
      if (!s) return { text: "", stats: {}, mode: "scan", shared: "-", chunks: [], scan: "miss" };
      await replay(s.chunks, s.doneMs, a.t0, onText, instant);
      return { text: s.text, stats: s.stats, mode: "scan", shared: "-", chunks: s.chunks, cacheFile: replyName(s.reqHash, s.run, false), scan: "standin" };
    }
    const scope = share && a.page && a.case && a.arm ? `${a.run}|${a.case}` : undefined;
    const f = scope ? flights.follow(scope, a.hash, a.arm!) : undefined;
    if (f) {
      const done = await Flights.relay(f, a.t0, onText);
      return { text: f.chunks.map((c) => c.text).join(""), stats: done.stats ?? {}, error: done.error, mode: "live", shared: "follower", chunks: f.chunks, cacheFile: done.cacheFile };
    }
    return live(a, onText, scope ? flights.lead(scope, a.hash, a.arm!) : undefined);
  }

  /** A copy in a scan or a replay: no reply, until the page drops it (or the call timeout). */
  function held(a: Ask, mode: RunMode): Promise<Out> {
    return new Promise((r) => {
      const done = () => r({ text: "", stats: {}, mode, shared: "-", chunks: [] });
      if (a.gone?.aborted) return done();
      a.gone?.addEventListener("abort", done, { once: true });
      setTimeout(done, TIMEOUT_MS).unref();
    });
  }

  /** Serves a request and records it: one meter line, and the call in its case's record. */
  async function serveAndRecord(a: Ask, onText: (t: string) => void): Promise<Out> {
    const t0 = a.t0;
    let firstMs: number | undefined;
    const out = await serve(a, (t) => {
      firstMs ??= performance.now() - t0;
      onText(t);
    });
    const s = out.stats;
    const up = out.upstream;
    const rl = (up ? s.rateLimit : undefined) as CallStats["rateLimit"];
    if (!out.refused) meterCall(p.calls, {
      at: new Date().toISOString(), run: a.run, case: a.case, arm: a.arm as Arm | undefined, slot: a.slot, role: a.role, page: a.page, model: a.req.model, servedModel: s.served as string | undefined,
      sdk: SDK_VERSION, reqHash: a.hash, shared: out.shared, mode: out.mode, scan: out.scan,
      inTokens: up ? n(s.inTokens) : 0, cacheRead: up ? n(s.cacheRead) : 0, cacheWrite5m: up ? n(s.write5m) : 0, cacheWrite1h: up ? n(s.write1h) : 0, outTokens: up ? n(s.outTokens) : 0,
      thinkingTokens: up ? n(s.thinkingTokens) : 0, stopReason: s.stopReason as string | undefined, ms: Math.round(performance.now() - t0), firstMs: firstMs === undefined ? undefined : Math.round(firstMs),
      waitMs: up ? (s.waitMs as number | undefined) : undefined, readyAtTake: up ? (s.readyAtTake as boolean) : undefined, retries: up ? n(s.retries) : 0, apiError: out.error, dropped: out.dropped,
      listUsd: up?.usd ?? 0, costUsd: up ? (s.costUsd as number | undefined) : undefined, token: up?.token as SlotN, fiveHour: rl?.fiveHour, sevenDay: rl?.sevenDay, resetsAt: rl?.resetsAt,
    });
    // The case's calls per arm, for its replies.json (the stand-in index); a picture by its subject.
    const c = a.case && a.arm && !out.error && !out.dropped ? cases.get(`${a.run}|${a.case}`) : undefined;
    if (c) {
      // The subject line of every picture prompt variant: "Doodle: …" or, from the matched variant on, "Picture: …".
      const subject = a.role === "picture" ? /^(?:Doodle|Picture): (.+)$/m.exec(String(a.req.user))?.[1] : undefined;
      (c.calls[a.arm!] ??= []).push({ role: a.role, ordinal: a.ordinal, subject, reqHash: a.hash, cacheFile: out.cacheFile ?? "", offsets: out.chunks.map((x) => Math.round(x.ms)), ...(a.copy ? { copy: a.copy } : {}) });
    }
    return out;
  }

  const model = (m: unknown) => (typeof m === "string" ? (MODEL_IDS[m] ?? (Object.values(MODEL_IDS).includes(m) ? m : undefined)) : undefined);
  function reqOf(b: Record<string, unknown>, user: string | string[], run: string): { req?: Req; error?: string } {
    // Jev: the version is the model; no images, effort or thinking (fixed, so the hash is stable).
    if (isJev(b.model)) return typeof user === "string" ? { req: { model: b.model as string, system: typeof b.system === "string" ? b.system : "", user, images: [], effort: "low", thinking: "auto" } } : { error: "a Jev call's user is one JSON text" };
    const id = model(b.model);
    const effort = (b.effort ?? "low") as Effort;
    if (!id) return { error: `unknown model "${b.model}" (haiku, sonnet, opus)` };
    if (!EFFORTS.includes(effort)) return { error: `unknown effort "${effort}"` };
    if (typeof b.system !== "string") return { error: "system must be a string" };
    return { req: { model: id, system: b.system, user, images: storeImages(p, (b.images as string[]) ?? [], run), effort, thinking: b.thinking === "off" ? "off" : "auto" } };
  }

  /** An arm page's /api/model: NDJSON text chunks, then the stats line (with reqHash, shared, mode). */
  async function product(req: IncomingMessage, res: ServerResponse, b: Record<string, unknown>, arrived: number) {
    const h = (k: string) => req.headers[`x-rt-${k}`] as string | undefined;
    const base = { run: h("run") ?? "-", case: h("case"), arm: h("arm"), slot: h("slot") === undefined ? undefined : Number(h("slot")), role: h("role") ?? (b.from as string) ?? "product" };
    const { req: r, error } = reqOf(b, (b.user as string) ?? "", base.run);
    if (!r) return json(res, 400, { error });
    const c = base.case ? caseOf(base.run, base.case) : undefined;
    if (b.user === undefined && isJev(b.model)) return json(res, 200, { warming: 0 });
    if (b.user === undefined) {
      // A scan or replay serves every reply from the cache: a process warmed for it would never be used (but a warm scan's are).
      const run = runs.get(base.run);
      if ((run?.mode ?? "live") !== "live" && !run?.warm) return json(res, 200, { warming: 0 });
      const keep = keepOf(b.warm, MAX_WARM);
      topUp(poolKey({ ...base, req: r }, slots.current), keep, start(r, slots.current), c?.ups);
      return json(res, 200, { warming: keep });
    }
    const ordKey = `${base.arm}|${base.role}`;
    const copy = typeof b.copy === "number" && b.copy > 1 ? b.copy : undefined;
    // A copy is its first copy's call again: it takes that call's ordinal, not the next one.
    const ordinal = copy ? Math.max(0, (c?.ordinals.get(ordKey) ?? 0) - 1) : (c?.ordinals.get(ordKey) ?? 0);
    if (!copy) c?.ordinals.set(ordKey, ordinal + 1);
    const a: Ask = { ...base, ordinal, t0: sentAt(h("at"), arrived), page: true, req: r, hash: reqHash(r), images: (b.images as string[]) ?? [], warm: b.warm as number | undefined, copy };
    res.setHeader("content-type", "application/x-ndjson");
    const gone = new AbortController();
    res.on("close", () => !res.writableEnded && gone.abort());
    const out = await serveAndRecord({ ...a, gone: gone.signal }, (t) => res.write(`${JSON.stringify({ text: t })}\n`));
    res.end(`${JSON.stringify({ done: true, model: b.model, modelId: r.model, ...out.stats, reqHash: a.hash, shared: out.shared, mode: out.mode, scan: out.scan, error: out.error })}\n`);
  }

  /** An eval role's call: {role, model, system, turns | user, images?, effort?, thinking?, run?, case?, token?} → {text, stats}. */
  async function evalCall(res: ServerResponse, b: Record<string, unknown>, arrived: number) {
    const user = (b.user ?? b.turns) as string | string[] | undefined;
    if (!user || typeof b.role !== "string") return json(res, 400, { error: "a call needs a role and user text (turns)" });
    const { req: r, error } = reqOf(b, user, (b.run as string) ?? "-");
    if (!r) return json(res, 400, { error });
    const a: Ask = { run: (b.run as string) ?? "-", case: b.case as string | undefined, role: b.role, ordinal: 0, t0: arrived, page: false, req: r, hash: reqHash(r), images: (b.images as string[]) ?? [], token: b.token as SlotN | undefined };
    const out = await serveAndRecord(a, () => {});
    json(res, out.error ? 502 : 200, { text: out.text, stats: { ...out.stats, reqHash: a.hash, mode: out.mode }, error: out.error, ...(out.capped ? { capped: true } : {}) });
  }

  /** The case is over: its loop delay p99 (above the timer's own resolution) and its calls per arm. */
  async function endCase(run: string, id: string) {
    const c = cases.get(`${run}|${id}`);
    if (!c) return { loopP99Ms: 0, calls: {} };
    if (c.ups.length) await Promise.race([Promise.all(c.ups), new Promise((r) => setTimeout(r, WARM_WAIT_MS).unref())]);
    cases.delete(`${run}|${id}`);
    flights.drop(`${run}|${id}`);
    const n = c.lates.reduce((a, x) => a + x, 0);
    let ms = 0;
    for (let seen = c.lates[0]; seen < 0.99 * n; seen += c.lates[++ms]);
    return { loopP99Ms: ms, calls: c.calls };
  }

  const status = () => ({ calls, cap, capReached: cap !== undefined && calls >= cap, evalInFlight: evalBusy, evalWaiting: evalWaiting.length, pools: pool.sizes(), slots: slots.status(), stale: slots.stale(), pace: slots.pace(), sameAccount: slots.sameAccount(), runs: Object.fromEntries([...runs].map(([k, r]) => [k, { ...r, cached: r.cached?.size }])) });

  const server = createServer(async (req, res) => {
    const arrived = performance.now();
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/status") return json(res, 200, status());
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      if (path === "/api/model") return await product(req, res, b, arrived);
      if (path === "/call") return await evalCall(res, b, arrived);
      if (path === "/run") {
        if (!["live", "replay", "scan"].includes(b.mode as string)) return json(res, 400, { error: "mode is live, replay or scan" });
        if (b.warm && b.mode !== "scan") return json(res, 400, { error: "only a scan warms" });
        if (b.timed && b.mode !== "scan") return json(res, 400, { error: "only a scan is timed (a replay always is)" });
        runs.set(b.run as string, { mode: b.mode as RunMode, share: b.share !== false, cached: b.cached ? new Set(b.cached as string[]) : undefined, warm: b.warm === true, timed: b.timed === true });
        return json(res, 200, {});
      }
      if (path === "/case-end") return json(res, 200, await endCase(b.run as string, b.case as string));
      if (path === "/spend") {
        // An agent session (run outside the gateway, on a slot's token): its $ and rate-limit state count on that slot.
        if (!o.tokens.some((t) => t.slot === b.slot) || typeof b.usd !== "number") return json(res, 400, { error: "spend needs a loaded slot and usd" });
        slots.record(b.slot as SlotN, { usd: b.usd, rateLimit: b.rateLimit as CallStats["rateLimit"] });
        return json(res, 200, {});
      }
      json(res, 404, { error: `no ${path}` });
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close() {
      clearInterval(sampler);
      clearTimeout(spawnTimer);
      spawnQueue.length = 0;
      pool.closeAll();
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * When the page sent the request (x-rt-at: epoch ms, the bridge stamps it), as performance.now(): starting a Claude
 * process blocks this loop ~10 ms, and a request read late must not get its chunks late. Else when it got here.
 */
function sentAt(at: string | undefined, arrived: number): number {
  const t = Number(at) - performance.timeOrigin;
  return at && Number.isFinite(t) ? Math.min(arrived, Math.max(arrived - 1000, t)) : arrived;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** A local port nothing listens on: HTTPS_PROXY there makes any request past the fake API fail at once. */
export async function closedPort(): Promise<number> {
  const s = netServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i < 0 ? undefined : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "";
  };
  try {
    const cap = arg("cap") === undefined ? undefined : Number(arg("cap"));
    const tokens = arg("dev-token") !== undefined ? loadDevToken(cap, arg("dev-token") || undefined) : loadTokens(arg("tokens") || undefined, (s) => console.error(s));
    const mock = arg("mock-api");
    const jevKey = mock ? undefined : arg("dev-token") !== undefined ? loadJevKey({ dev: true, dir: arg("dev-token") || undefined }) : loadJevKey({ file: arg("tokens") || undefined });
    const gw = await startGateway({ p: paths(arg("home") || undefined), tokens, cap, port: Number(arg("port") ?? 0), mockApi: mock ? { baseUrl: mock, deadProxyPort: await closedPort() } : undefined, jevKey });
    const stop = () => (gw.close(), process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.stdin.on("end", stop).resume();
    console.log(`READY ${gw.url}`);
  } catch (err) {
    console.error(`gateway refused to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
