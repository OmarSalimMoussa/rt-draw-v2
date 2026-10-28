// Checkpoints, the stable yardstick (spec §5.2, §5.3; N7, N10). The champion runs against A0 (checkpoint 0's
// champion, which never moves) on bench/B1 (+ bench/U1), both live and unshared, judged by fidelity and craft on
// every case, and becomes one CheckpointRow: the champion's share with a 90% origin-session bootstrap, latency
// against A0 in the same run (the owner hears when it's surely slower), the overfitting gap, health and trust. A
// new judgeId or bench starts the next era, charted apart: nothing bridges two eras. A harness re-pin or a served
// product model is only a marker. Checkpoint 0 is A0 against A0: the unshared A/A (verdict.ts' aaPass) and the
// baseline. The yardstick is frozen here too: freeze() writes bench/B1 with its manifest, verifyBench() re-hashes it.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HitIndex } from "../../src/core/hittest.ts";
import { groupStrokes, readMark } from "../../src/core/marks.ts";
import { Scene } from "../../src/core/scene.ts";
import { ASKS, ASK_WORDS, POINTING } from "../core/scenarios.ts";
import { inAudit, judging, pick } from "../judge/judge.ts";
import { type ArmSpec, INPUT_FILES, type Rig, benchCases, checkpointRun, harnessTag, product } from "./ab.ts";
import { LOOP, configId } from "./config.ts";
import { AMBER, type Anchor, ONE, commitHistory, historyAdd, historyRead, historyRows, historyWrite, ledger, openHistory, ownerItem, saveRun, trustOf } from "./history.ts";
import { pairedRatio } from "./latency.ts";
import { meterOf } from "./metrics.ts";
import { paths } from "./paths.ts";
import { caseDir, runFile } from "./record.ts";
import { entryOrder, rng, seedOf } from "./stats.ts";
import { treeOf } from "./trees.ts";
import type { BenchManifest, CaseInfo, CaseInput, CheckpointRow, DecisionRow, Judged, Lat, LoadSample, Marker, Meant, Row, RunInfo } from "./types.ts";
import { aaPass, latencyVeto } from "./verdict.ts";
import { realShadow } from "../real/shadow.ts";

type Bench = "B1" | "U1";
type BenchCase = ReturnType<typeof benchCases>[number];
type Share = { n: number; share: number; lo90: number; hi90: number };
type Pin = { sha: string; tuning?: Record<string, number>; tree?: string };

/** checkpoints.jsonl's row: §5.3's, plus what the next checkpoint compares against. */
export type StoredCheckpoint = CheckpointRow & {
  run: string; seed: string; judgeId: string; championTuning?: Record<string, number>;
  /** The bench hash it measured on (absent before 2026-10-26): a new one, like a new judgeId, starts an era. */
  bench?: string;
  /** The harness tag and the served product models: a change is a marker, never an era. */
  harness: string; served: string[];
};

/** Runs a pair on the yardstick (A0 as A, the champion as B) and returns its rows. */
export type Runner = (s: { run: string; anchor: Pin; champion: Pin; seed: string }) => Promise<Row[]>;

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const maybe = <T>(file: string): T | undefined => (existsSync(file) ? json<T>(file) : undefined);
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const rank = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.max(0, Math.ceil(p * s.length) - 1)] : 0;
};

/** (wins + ½ ties) / n over `score`d rows (a lost case is a void here), with a 90% bootstrap over whole origin sessions. */
function shareOf(rows: Row[], score: (r: Row) => number | undefined, seed: string): Share | undefined {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const s = score(r);
    if (!r.void && !r.lost && s !== undefined) (by.get(r.cluster) ?? by.set(r.cluster, []).get(r.cluster)!).push((s + 1) / 2);
  }
  const groups = [...by.values()];
  const n = groups.reduce((a, g) => a + g.length, 0);
  if (!n) return undefined;
  const draw = rng(seedOf(seed));
  const means: number[] = [];
  for (let k = 0; k < LOOP.bootstrap; k++) {
    let sum = 0, m = 0;
    for (let g = 0; g < groups.length; g++) for (const x of groups[Math.floor(draw() * groups.length)]) sum += x, m++;
    means.push(sum / m);
  }
  return { n, share: groups.flat().reduce((a, b) => a + b, 0) / n, lo90: rank(means, 0.05), hi90: rank(means, 0.95) };
}


/** One arm's latencies at p50 and p75 (0 = A, 1 = B): TTFD and render once rows have them. */
function latOf(rows: Row[], i: 0 | 1): Lat {
  const of = (m: "ttfc" | "ttd" | "ttfd" | "render") => rows.flatMap((r) => (r[m]?.[i] ? [r[m]![i]!] : []));
  const [ttfc, ttd, ttfd, render] = [of("ttfc"), of("ttd"), of("ttfd"), of("render")];
  return {
    ttfcP50: rank(ttfc, 0.5), ttfcP75: rank(ttfc, 0.75), ttdP50: rank(ttd, 0.5), ttdP75: rank(ttd, 0.75),
    ...(ttfd.length ? { ttfdP50: rank(ttfd, 0.5), ttfdP75: rank(ttfd, 0.75) } : {}),
    ...(render.length ? { renderP50: rank(render, 0.5), renderP75: rank(render, 0.75) } : {}),
  };
}

// ---- The yardstick's identity: a new bench starts an era

const benchDir = (b: Bench) => join(paths().history, "bench", b);
const manifestOf = (b: Bench) => maybe<BenchManifest>(join(benchDir(b), "manifest.json"));
/** B1's manifest hash, and U1's once it exists. */
export const benchHash = () => (["B1", "U1"] as const).map((b) => manifestOf(b)?.hash.slice(0, 16)).filter(Boolean).join("+");

/**
 * Every file of a bench's cases by sha256, and the hash over them. expectation.json stays out: it is the
 * judge's, re-made under a new judgeId (itself an era) and written back, so it must not move the bench hash.
 */
function manifest(b: Bench): BenchManifest {
  const root = benchDir(b);
  const files: Record<string, string> = {};
  for (const id of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort())
    for (const f of readdirSync(join(root, id)).sort()) if (f !== "expectation.json") files[`${id}/${f}`] = sha256(readFileSync(join(root, id, f)));
  return { version: b, files, hash: sha256(Object.entries(files).map(([f, h]) => `${f} ${h}`).join("\n")) };
}
export function writeManifest(b: Bench): BenchManifest {
  const m = manifest(b);
  historyWrite(`bench/${b}/manifest.json`, m);
  return m;
}

/** Re-hashes a frozen bench against its manifest: `bad` lists files changed, missing or added. */
export function verifyBench(b: Bench = "B1"): { ok: boolean; hash: string; bad: string[] } {
  const want = manifestOf(b);
  if (!want) throw new Error(`bench/${b} isn't frozen (no manifest.json)`);
  const have = manifest(b);
  const bad = [...new Set([...Object.keys(want.files), ...Object.keys(have.files)])].filter((f) => want.files[f] !== have.files[f]).sort();
  return { ok: !bad.length && have.hash === want.hash, hash: have.hash, bad };
}

/** One tuning case per origin session (sessions in seeded order, as many rounds as it takes), the ask least taken so far first. */
function stratified(cases: CaseInfo[], n: number, seed: string): CaseInfo[] {
  const groups = new Map<string, CaseInfo[]>();
  for (const c of entryOrder(cases, (x) => x.originSession, seedOf(seed))) (groups.get(c.originSession) ?? groups.set(c.originSession, []).get(c.originSession)!).push(c);
  const asks = new Map<string, number>();
  const out: CaseInfo[] = [];
  while (out.length < n && [...groups.values()].some((g) => g.length)) {
    for (const g of groups.values()) {
      if (out.length >= n || !g.length) continue;
      const tie = (c: CaseInfo) => seedOf(`${seed} ${c.id}`);
      g.sort((a, b) => (asks.get(a.ask) ?? 0) - (asks.get(b.ask) ?? 0) || tie(a) - tie(b));
      const c = g.shift()!;
      asks.set(c.ask, (asks.get(c.ask) ?? 0) + 1);
      out.push(c);
    }
  }
  return out;
}

/**
 * H-chart sends banked clean, of the LOOP.bench.heldout made: hedged meants (V5) and V6/V7/V12 voids are left out of a
 * held-out set by design, so a real bank never has all 32. Below this share the chart's held-out line is too thin.
 */
const CHART_MIN_SHARE = 0.75;

/**
 * `bench freeze`: every clean H-chart case (up to LOOP.bench.heldout, at least CHART_MIN_SHARE of it) and LOOP.bench.tuning
 * stratified tuning cases, copied from the bank into bench/B1 with their manifest, committed. Once only: a new yardstick
 * is an era, so a frozen B1 is refused.
 */
export function freeze(o: { seed?: string; heldout?: number; tuning?: number } = {}): BenchManifest {
  const p = paths();
  if (manifestOf("B1")) throw new Error("bench/B1 is frozen already: a new yardstick starts an era; move it aside by hand to freeze again");
  openHistory();
  const nH = o.heldout ?? LOOP.bench.heldout, nT = o.tuning ?? LOOP.bench.tuning;
  const bank = readdirSync(p.bankCases).filter((id) => !id.includes(".void") && existsSync(join(p.bankCase(id), "done"))).sort().map((id) => json<CaseInfo>(join(p.bankCase(id), "case.json")));
  const chart = bank.filter((c) => c.set === "heldout-chart").slice(0, nH);
  const tuning = stratified(bank.filter((c) => c.set === "tuning"), nT, o.seed ?? "B1");
  if (chart.length < Math.ceil(CHART_MIN_SHARE * nH) || tuning.length < nT) throw new Error(`the bank has ${chart.length} clean H-chart and ${tuning.length} tuning cases (B1 takes ${Math.ceil(CHART_MIN_SHARE * nH)}–${nH} + ${nT})`);
  for (const c of [...chart, ...tuning]) {
    mkdirSync(join(benchDir("B1"), c.id), { recursive: true });
    for (const f of INPUT_FILES) if (existsSync(join(p.bankCase(c.id), f))) copyFileSync(join(p.bankCase(c.id), f), join(benchDir("B1"), c.id, f));
  }
  const m = writeManifest("B1");
  commitHistory(`bench freeze: B1 = ${chart.length} H-chart + ${nT} tuning cases (${m.hash.slice(0, 12)})`);
  return m;
}

// ---- What a checkpoint reads off its run

/** The run's fidelity judgeId: the one its first-order verdicts carry. */
function judgeOf(run: string): string | undefined {
  const dir = runFile(run, "cases");
  const n = new Map<string, number>();
  for (const c of existsSync(dir) ? readdirSync(dir) : []) {
    const id = maybe<Judged>(join(dir, c, "judge", "fidelity-1.json"))?.judgeId;
    if (id) n.set(id, (n.get(id) ?? 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Flips are counted on the audit sample only, as judging() counts them: a low-confidence verdict's second order flips more. */
function healthOf(run: string, seed: string, rows: Row[], bench: Map<string, BenchCase>): CheckpointRow["health"] {
  let audited = 0, flipped = 0;
  for (const r of rows.filter((x) => inAudit(seed, x.case))) {
    const [a, b] = ["fidelity-1.json", "fidelity-2.json"].map((f) => maybe<Judged>(join(caseDir(run, r.case), "judge", f)));
    if (a && b) audited++, (flipped += Number(pick(a) !== pick(b)));
  }
  const dirs = rows.flatMap((r) => (bench.has(r.case) ? [bench.get(r.case)!.dir] : []));
  const beats = dirs.map((d) => json<CaseInfo>(join(d, "case.json"))).filter((c) => c.beat);
  const calls = meterOf(run).filter((c) => product(c) && c.mode === "live" && c.shared !== "follower");
  const thinking: Record<string, number> = {};
  for (const role of new Set(calls.map((c) => c.role))) {
    const mine = calls.filter((c) => c.role === role);
    thinking[role] = mine.filter((c) => c.thinkingTokens > 0).length / mine.length;
  }
  const load = existsSync(runFile(run, "load.ndjson")) ? readFileSync(runFile(run, "load.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as LoadSample).psiCpu) : [];
  return {
    voidPct: rows.length ? rows.filter((r) => r.void || r.lost).length / rows.length : 0, flipPct: audited ? flipped / audited : 0,
    hedgePct: dirs.length ? dirs.filter((d) => maybe<Meant>(join(d, "meant.json"))?.hedged).length / dirs.length : 0,
    beatCompliance: beats.length ? beats.filter((c) => c.beatDone).length / beats.length : 1, thinking,
    coldShare: calls.length ? calls.filter((c) => c.readyAtTake === false).length / calls.length : 0, psiMedian: rank(load, 0.5),
  };
}

/**
 * §2.8's distribution check: the drivers' B1 sends against the owner's U1 ones, as means per send (words, marks,
 * pointing words with a mark, each mark kind's share, each ask type the words name). Undefined without a U1. A case
 * it can't read (a scene from before Scene.toJSON's version) is left out: a reported figure never stops a checkpoint.
 */
export function realismOf(cases: BenchCase[]): CheckpointRow["realism"] {
  const of = (c: BenchCase) => {
    try {
      const input = json<CaseInput>(join(c.dir, "input.json"));
      const said = typeof input.words === "string" ? input.words : input.words.map((w) => w.word).join(" ");
      const hits = new HitIndex(Scene.fromJSON(json(join(c.dir, "before.scene.json"))));
      const marks = groupStrokes(input.strokes).map((m) => readMark(m, hits).kind as string);
      return [{ said, words: said.split(/\s+/).filter(Boolean).length, marks }];
    } catch {
      return [];
    }
  };
  const [driver, human] = [cases.filter((c) => c.bench !== "U1").flatMap(of), cases.filter((c) => c.bench === "U1").flatMap(of)];
  if (!driver.length || !human.length) return undefined;
  type Send = (typeof driver)[number];
  const both = (f: (x: Send) => number) => ({ driver: driver.reduce((a, x) => a + f(x), 0) / driver.length, human: human.reduce((a, x) => a + f(x), 0) / human.length });
  const kinds = [...new Set([...driver, ...human].flatMap((x) => x.marks))].sort();
  return {
    words: both((x) => x.words), marks: both((x) => x.marks.length), pointing: both((x) => Number(x.marks.length > 0 && POINTING.test(x.said))),
    ...Object.fromEntries(kinds.map((k) => [`mark:${k}`, both((x) => (x.marks.length ? x.marks.filter((m) => m === k).length / x.marks.length : 0))])),
    ...Object.fromEntries(ASKS.map((a) => [`ask:${a}`, both((x) => Number(ASK_WORDS[a].test(x.said)))])),
  };
}

/** Expectations a run made (a new case, or a new judgeId) go back to the bench, outside its hash, for the next run to reuse. */
function writeBack(run: string) {
  for (const c of benchCases()) {
    const made = join(caseDir(run, c.id), "expectation.json"), kept = join(c.dir, "expectation.json");
    if (existsSync(made) && JSON.stringify(json(made)) !== JSON.stringify(maybe(kept))) copyFileSync(made, kept);
  }
}

/** The trees a checkpoint's rig must serve: the champion's and A0's (checkpoint 0's A0 is the champion: its tree twice, so each arm gets its own Vite). */
export function checkpointTrees(champion: ArmSpec): string[] {
  return [champion.tree, treeOf(historyRead("anchors.json")[0]?.sha ?? champion.sha)];
}

/** The default runner: checkpointRun, live and unshared, judged by fidelity and craft on every case. */
const pinArm = (a: Pin): ArmSpec => ({ sha: a.sha, tree: a.tree ?? treeOf(a.sha), ...(a.tuning ? { tuning: a.tuning } : {}) });
const liveRunner = (rig?: Rig): Runner => async (s) => {
  if (!rig) throw new Error("a checkpoint needs a rig serving checkpointTrees()");
  return (await checkpointRun(rig, { run: s.run, anchor: pinArm(s.anchor), champion: pinArm(s.champion), seed: s.seed, judge: judging(s.run, { seed: s.seed, craft: "all" }) })).rows;
};
/** Bench R1, A0 against the champion, after B1 (LOOP-V2.md A5): reported, never deciding; a failure only says so. */
async function realAt(rig: Rig, run: string, anchor: Pin, champion: Pin, seed: string): Promise<CheckpointRow["real"]> {
  try {
    return await realShadow(rig, { run, arms: { A: pinArm(anchor), B: pinArm(champion) }, seed, judge: judging(run, { seed, craft: "none" }) });
  } catch (err) {
    console.error(`${run}: R1 failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * The next checkpoint (ck-00 is checkpoint 0: the champion is A0 and runs against itself). `owner`: an owner
 * step for `rte sync` (§8.6), recorded as an owner-step decision and a marker. `runner` replaces the live run
 * (checks only). Writes checkpoints.jsonl, anchors.json (at checkpoint 0), markers.jsonl and runs/<id>.json, then commits.
 */
export async function checkpoint(o: { rig?: Rig; epoch: number; champion: ArmSpec | Pin; seed?: string; owner?: { commits: number; baseSha: string; candSha: string }; runner?: Runner }): Promise<StoredCheckpoint> {
  openHistory();
  const past = historyRows("checkpoints.jsonl") as StoredCheckpoint[];
  const last = past.at(-1), zero = !last;
  const id = `ck-${String(past.length).padStart(2, "0")}`, run = id, seed = o.seed ?? id;
  const now = new Date().toISOString();
  const runner = o.runner ?? liveRunner(o.rig);
  const anchor: Anchor = historyRead("anchors.json")[0] ?? { id: "A0", sha: o.champion.sha, ...(o.champion.tuning ? { tuning: o.champion.tuning } : {}) };
  const bench = benchHash();

  const rows = await runner({ run, anchor, champion: o.champion, seed });
  const real = !o.runner && o.rig ? await realAt(o.rig, `real-r1-${id}`, anchor, o.champion, seed) : undefined;
  const judgeId = judgeOf(run) ?? last?.judgeId ?? "";
  // A new judge or bench measures differently: the next era, charted apart.
  const moved = last && ((last.judgeId && judgeId !== last.judgeId) || (last.bench !== undefined && bench !== last.bench));
  const era = moved ? last.era + 1 : (last?.era ?? 1);

  const byId = new Map(benchCases().map((c) => [c.id, c]));
  const setOf = (r: Row) => (byId.get(r.case)?.bench === "U1" ? "human" : byId.get(r.case)?.set);
  const ok = rows.filter((r) => !r.void);
  const sub = (set: string) => shareOf(ok.filter((r) => setOf(r) === set), (r) => r.s, `${seed} ${set}`);
  const share = { all: shareOf(ok, (r) => r.s, seed), heldout: sub("heldout-chart"), tuning: sub("tuning"), human: sub("human") };
  const all = share.all;
  if (!all) throw new Error(`checkpoint ${id}: every case is void (runs/${run}/invariants.jsonl)`);
  const craft = shareOf(ok, (r) => r.sCraft, `${seed} craft`) ?? { n: 0, share: 0.5, lo90: 0.5, hi90: 0.5 };
  const health = healthOf(run, seed, rows, byId);
  const voided = health.voidPct > LOOP.voidMax || health.flipPct > LOOP.flipAlarm;
  // Hedges and beat compliance are the frozen yardstick's, the same at every checkpoint of an era: reported in health, never
  // colouring a point (one low B1 would otherwise empty the era's trend lines).
  const trust = trustOf(voided, run, health.flipPct >= AMBER.flip);
  // The latency veto's own test, the champion against A0: never slower, so the owner hears of it (it stops nothing).
  const slower = zero ? undefined : latencyVeto(rows);
  const usd = (i: 0 | 1) => (ok.length ? ok.reduce((a, r) => a + r.usd[i], 0) / ok.length : 0);
  const overfitGap = share.tuning && share.heldout ? share.tuning.share - share.heldout.share : 0;
  const harness = harnessTag();
  const served = [...new Set(meterOf(run).filter(product).flatMap((c) => (c.servedModel ? [c.servedModel] : [])))].sort();
  const aa = zero ? aaPass(rows) : undefined;
  const [ttfd, render] = [pairedRatio(rows, "ttfd"), pairedRatio(rows, "render")];
  const row: StoredCheckpoint = {
    id, epoch: o.epoch, era, at: now, machine: process.arch === "arm64" ? "pgx" : "laptop", trust,
    champion: o.champion.sha, anchor: anchor.id, share, craft,
    latency: {
      champion: latOf(ok, 1), anchor: latOf(ok, 0), ratioTtfc: pairedRatio(rows, "ttfc") ?? ONE, ratioTtd: pairedRatio(rows, "ttd") ?? ONE,
      ...(ttfd ? { ratioTtfd: ttfd } : {}), ...(render ? { ratioRender: render } : {}), ...(slower ? { slower } : {}),
    },
    ...(aa ? { aa: { pass: aa.pass, ci: aa.ci, tests: aa.tests } } : {}),
    productUsdPerSend: { champion: usd(1), anchor: usd(0) }, overfitGap, health, realism: realismOf([...byId.values()]), ...(real ? { real } : {}),
    run, seed, judgeId, ...(o.champion.tuning ? { championTuning: o.champion.tuning } : {}), bench, harness, served,
  };

  // ---- Written only now, so a failed run leaves the record as it was.
  const mark = (kind: Marker["kind"], label: string, ref?: string) => historyAdd("markers.jsonl", { at: now, era, kind, label, ...(ref ? { ref } : {}) });
  if (zero) historyWrite("anchors.json", [anchor]);
  if (moved) mark("era", `era ${era}: ${judgeId !== last.judgeId ? "a new judge" : "a new bench"}`, id);
  if (last && harness !== last.harness) mark("harness", harness ? `${harness} re-pinned` : "harness off its tag", harness || undefined);
  if (last && served.join() !== last.served.join()) mark("served-model", `served ${served.join(", ")}`, served.join(","));
  if (slower) ownerItem(`${id}: the champion is surely slower than A0: ${slower}`);
  if (last && overfitGap > LOOP.overfitGap && last.overfitGap > LOOP.overfitGap)
    ownerItem(`overfitting: tuning share minus H-chart share ${overfitGap.toFixed(2)} at ${id} and ${last.overfitGap.toFixed(2)} at ${last.id}`);
  if (aa) historyAdd("health.jsonl", { at: now, kind: "aa", pass: aa.pass, detail: { checkpoint: id, failed: aa.failed, kneeDown: aa.kneeDown } });
  if (o.owner) {
    const info = maybe<RunInfo>(runFile(run, "run.json"));
    const d: DecisionRow = {
      id: `owner-${id}`, kind: "owner-step", epoch: o.epoch, candSha: o.owner.candSha, baseSha: o.owner.baseSha, class: "owner", goal: "owner", verdict: "owner",
      reasons: [`owner: ${o.owner.commits} commits merged by rte sync`], trust, looks: [], counts: { wins: 0, losses: 0, ties: 0, exactTies: 0 },
      affected: { tuning: 0, of: 0, topUp: 0 }, checkpoint: id,
      latency: { ttfc: row.latency.ratioTtfc, ttd: row.latency.ratioTtd, ...(row.latency.ratioTtfd ? { ttfd: row.latency.ratioTtfd } : {}), ...(row.latency.ratioRender ? { render: row.latency.ratioRender } : {}) },
      work: 1, emptyRise: 0, failedPicRise: 0, cost: { usdPerCaseRatio: usd(0) ? usd(1) / usd(0) : 1, listUsd: info?.meter.listUsd ?? 0, calls: info?.meter.calls ?? 0 },
      minutes: Math.round(info?.meter.minutes ?? 0), run, judgeId, configId,
    };
    historyAdd("decisions.jsonl", d);
    ledger(d);
    mark("owner-step", `owner: ${o.owner.commits} commits`, id);
  }
  writeBack(run);
  historyAdd("checkpoints.jsonl", row);
  saveRun(run);
  commitHistory(`${id}: share ${all.share.toFixed(2)} against A0${slower ? ", surely slower" : ""}${moved ? `, era ${era}` : ""}${o.owner ? ", owner step" : ""}`);
  return row;
}
