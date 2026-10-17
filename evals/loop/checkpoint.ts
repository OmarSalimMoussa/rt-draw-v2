// Checkpoints, the stable yardstick (spec §5.2, §5.3; N7, N10). The champion runs against the current
// anchor on bench/B1 (+ bench/U1), both live and unshared, judged by fidelity and craft on every case,
// and becomes one CheckpointRow: the champion's share with a 90% origin-session bootstrap, the chained
// quality index Q, latency against the anchor and chained to A0, both debts through same-run chains
// (latency.ts), the anchor ladder, the overfitting gap, health and trust. An era starts only when the
// yardstick itself changes (the judgeId, a bench manifest, the measuring code) and is bridged, so Q and
// the latency chain carry across with a drawn step; a harness re-pin or a served product model is only a
// marker. Checkpoint 0 is A0 against A0: the unshared A/A (verdict.ts' aaPass) and the baseline. The
// yardstick is frozen here too: freeze() writes bench/B1 with its manifest, verifyBench() re-hashes it.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HitIndex } from "../../src/core/hittest.ts";
import { groupStrokes, readMark } from "../../src/core/marks.ts";
import { Scene } from "../../src/core/scene.ts";
import { ASKS, ASK_WORDS, POINTING } from "../core/scenarios.ts";
import { fidelityCall, judging, pick, variants } from "../judge/judge.ts";
import { readPacket } from "../judge/packet.ts";
import { type ArmSpec, INPUT_FILES, type Rig, benchCases, checkpointRun, harnessTag, product } from "./ab.ts";
import { LOOP, configId } from "./config.ts";
import { AMBER, type Anchor, ONE, commitHistory, historyAdd, historyRead, historyRows, historyWrite, ledger, openHistory, ownerItem, saveRun, trustOf } from "./history.ts";
import { type CheckpointLinks, type Debts, chainSince, debtsAfter, linksOf, pairedRatio } from "./latency.ts";
import { meterOf } from "./metrics.ts";
import { paths } from "./paths.ts";
import { appendLine, caseDir, runFile } from "./record.ts";
import { entryOrder, rng, seedOf } from "./stats.ts";
import { treeOf } from "./trees.ts";
import type { BenchManifest, CaseInfo, CaseInput, CheckpointRow, DecisionRow, Era, Judged, Lat, LoadSample, Marker, Meant, Row, RunInfo } from "./types.ts";
import { aaPass } from "./verdict.ts";

type Bench = "B1" | "U1";
type BenchCase = ReturnType<typeof benchCases>[number];
type Share = { n: number; share: number; lo90: number; hi90: number };
type Pin = { sha: string; tuning?: Record<string, number>; tree?: string };

/** checkpoints.jsonl's row: §5.3's, plus what the next checkpoint chains and compares against. */
export type StoredCheckpoint = CheckpointRow & {
  run: string; seed: string; judgeId: string; championTuning?: Record<string, number>;
  /** This run's chain links and the debts after it (latency.ts). */
  links: CheckpointLinks; debts: Debts;
  /** The harness tag and the served product models: a change is a marker, never an era. */
  harness: string; served: string[];
};

/** Runs a pair on the yardstick (A the anchor, B the champion) and returns its rows. */
export type Runner = (s: { run: string; anchor: Pin; champion: Pin; seed: string }) => Promise<Row[]>;

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const maybe = <T>(file: string): T | undefined => (existsSync(file) ? json<T>(file) : undefined);
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
/** Q's clip (§5.2, as latency.ts'): a share of 0 or 1 would make log-odds infinite. */
const logit = (p: number) => {
  const c = Math.min(0.95, Math.max(0.05, p));
  return Math.log(c / (1 - c));
};
const rank = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.max(0, Math.ceil(p * s.length) - 1)] : 0;
};

/** (wins + ½ ties) / n over `score`d rows, with a 90% bootstrap over whole origin sessions. */
function shareOf(rows: Row[], score: (r: Row) => number | undefined, seed: string): Share | undefined {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const s = score(r);
    if (!r.void && s !== undefined) (by.get(r.cluster) ?? by.set(r.cluster, []).get(r.cluster)!).push((s + 1) / 2);
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

/** One arm's TTFC and TTD at p50 and p75 (0 = A, 1 = B). */
function latOf(rows: Row[], i: 0 | 1): Lat {
  const ttfc = rows.flatMap((r) => (r.ttfc[i] ? [r.ttfc[i]!] : [])), ttd = rows.flatMap((r) => (r.ttd[i] ? [r.ttd[i]] : []));
  return { ttfcP50: rank(ttfc, 0.5), ttfcP75: rank(ttfc, 0.75), ttdP50: rank(ttd, 0.5), ttdP75: rank(ttd, 0.75) };
}

// ---- The yardstick's identity: what starts an era

/** The measuring code B1's numbers pass through (§5.2), hashed as the pinned harness has it. */
export const MEASURED = ["evals/bridge/timing.ts", "evals/judge", "evals/core/diff.ts"];
export function measureHash(repo = paths().repo): string {
  const files = MEASURED.flatMap((p) => (statSync(join(repo, p)).isDirectory() ? readdirSync(join(repo, p)).sort().map((f) => `${p}/${f}`) : [p]))
    .filter((f) => statSync(join(repo, f)).isFile());
  return sha256(files.map((f) => `${f} ${sha256(readFileSync(join(repo, f)))}`).join("\n")).slice(0, 16);
}

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

/** The champion's share in first-order fidelity verdicts alone: the like-for-like number a re-judge compares. */
const firstOrder = (js: Judged[]) => (js.length ? js.reduce((a, j) => a + (pick(j) === "B" ? 1 : pick(j) === "A" ? 0 : 0.5), 0) / js.length : 0.5);

/** The judge bridge: the run's stored packets re-judged by today's judge (first order, in groups of 4). */
async function rejudge(from: string, run: string): Promise<{ before: number; after: number }> {
  const cases = readdirSync(runFile(from, "cases")).filter((c) => existsSync(join(caseDir(from, c), "judge", "packet.json")) && existsSync(join(caseDir(from, c), "judge", "fidelity-1.json"))).sort();
  const after: Judged[] = [];
  for (let k = 0; k < cases.length; k += 4)
    after.push(...(await Promise.all(cases.slice(k, k + 4).map(async (c) => {
      const p = readPacket(from, c);
      const j = await fidelityCall(from, p, p.positions, variants().fidelity, run);
      appendLine(runFile(run, "rejudged.jsonl"), { case: c, ...j });
      return j;
    }))));
  return { before: firstOrder(cases.map((c) => json<Judged>(join(caseDir(from, c), "judge", "fidelity-1.json")))), after: firstOrder(after) };
}

function healthOf(run: string, rows: Row[], bench: Map<string, BenchCase>): CheckpointRow["health"] {
  let audited = 0, flipped = 0;
  for (const r of rows) {
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
    voidPct: rows.length ? rows.filter((r) => r.void).length / rows.length : 0, flipPct: audited ? flipped / audited : 0,
    hedgePct: dirs.length ? dirs.filter((d) => maybe<Meant>(join(d, "meant.json"))?.hedged).length / dirs.length : 0,
    beatCompliance: beats.length ? beats.filter((c) => c.beatDone).length / beats.length : 1, thinking,
    coldShare: calls.length ? calls.filter((c) => c.readyAtTake === false).length / calls.length : 0, psiMedian: rank(load, 0.5),
  };
}

/**
 * §2.8's distribution check: the drivers' B1 sends against the owner's U1 ones, as means per send (words, marks,
 * pointing words with a mark, each mark kind's share, each ask type the words name). Undefined without a U1.
 */
export function realismOf(cases: BenchCase[]): CheckpointRow["realism"] {
  const of = (c: BenchCase) => {
    const input = json<CaseInput>(join(c.dir, "input.json"));
    const said = typeof input.words === "string" ? input.words : input.words.map((w) => w.word).join(" ");
    const hits = new HitIndex(Scene.fromJSON(json(join(c.dir, "before.scene.json"))));
    const marks = groupStrokes(input.strokes).map((m) => readMark(m, hits).kind as string);
    return { said, words: said.split(/\s+/).filter(Boolean).length, marks };
  };
  const [driver, human] = [cases.filter((c) => c.bench !== "U1").map(of), cases.filter((c) => c.bench === "U1").map(of)];
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

/** The trees a checkpoint's rig must serve: the anchor's and champion's, and the last pair's when the yardstick changed (its bridge). */
export function checkpointTrees(champion: ArmSpec): string[] {
  const anchors = historyRead("anchors.json"), era = historyRead("eras.json").at(-1);
  const last = (historyRows("checkpoints.jsonl") as StoredCheckpoint[]).at(-1);
  const bridge = last && era && (benchHash() !== era.bench || measureHash() !== era.measureHash);
  // Checkpoint 0's anchor is the champion: its tree listed twice, so each arm gets its own Vite (openRig).
  const shas = [anchors.at(-1)?.sha ?? champion.sha, ...(bridge ? [last.champion, anchors.find((a) => a.id === last.anchor)?.sha] : [])].filter((s): s is string => !!s);
  return [champion.tree, ...new Set(shas.map(treeOf))];
}

/** The default runner: checkpointRun, live and unshared, judged by fidelity and craft on every case. */
const liveRunner = (rig?: Rig): Runner => async (s) => {
  if (!rig) throw new Error("a checkpoint needs a rig serving checkpointTrees()");
  const arm = (a: Pin): ArmSpec => ({ sha: a.sha, tree: a.tree ?? treeOf(a.sha), ...(a.tuning ? { tuning: a.tuning } : {}) });
  return (await checkpointRun(rig, { run: s.run, anchor: arm(s.anchor), champion: arm(s.champion), seed: s.seed, judge: judging(s.run, { seed: s.seed, craft: "all" }) })).rows;
};

/**
 * The next checkpoint (ck-00 is checkpoint 0: the champion is A0 and runs against itself). `owner`: an owner
 * step for `rte sync` (§8.6), recorded as an owner-step decision and a marker. `runner` replaces the live run
 * (checks only). Writes checkpoints.jsonl, anchors.json, eras.json, markers.jsonl and runs/<id>.json, then commits.
 */
export async function checkpoint(o: { rig?: Rig; epoch: number; champion: ArmSpec | Pin; seed?: string; owner?: { commits: number; baseSha: string; candSha: string }; runner?: Runner }): Promise<StoredCheckpoint> {
  openHistory();
  const past = historyRows("checkpoints.jsonl") as StoredCheckpoint[];
  const last = past.at(-1), zero = !last;
  const id = `ck-${String(past.length).padStart(2, "0")}`, run = id, seed = o.seed ?? id;
  const now = new Date().toISOString();
  const runner = o.runner ?? liveRunner(o.rig);
  const anchors = historyRead("anchors.json");
  const anchor: Anchor = anchors.at(-1) ?? { id: "A0", sha: o.champion.sha, Q: 0, ...(o.champion.tuning ? { tuning: o.champion.tuning } : {}) };
  const eras = historyRead("eras.json"), era0 = eras.at(-1);
  const bench = benchHash(), measure = measureHash();

  // A changed bench or measuring code: the last checkpoint's pair re-run under it first, the bridge.
  let era: Era | undefined;
  const why = era0 && (bench !== era0.bench ? "bench" : measure !== era0.measureHash ? "measure" : undefined);
  if (why && last) {
    const b = `${id}-bridge`;
    const pin = anchors.find((a) => a.id === last.anchor)!;
    const rows = await runner({ run: b, anchor: pin, champion: { sha: last.champion, tuning: last.championTuning }, seed: last.seed });
    const step = {
      Q: logit(shareOf(rows, (r) => r.s, b)?.share ?? 0.5) - logit(last.share.all!.share),
      ttfc: (pairedRatio(rows, "ttfc")?.est ?? 1) / last.latency.ratioTtfc.est, ttd: (pairedRatio(rows, "ttd")?.est ?? 1) / last.latency.ratioTtd.est,
    };
    era = { era: era0!.era + 1, from: now, why, judgeId: "", bench, measureHash: measure, bridge: { run: b, step } };
    saveRun(b);
    writeBack(b);
  }

  const rows = await runner({ run, anchor, champion: o.champion, seed });
  const judgeId = judgeOf(run) ?? era0?.judgeId ?? "";
  if (!era0) era = { era: 1, from: now, why: "bench", judgeId, bench, measureHash: measure };
  else if (era) era.judgeId = judgeId; // the bridge ran under today's judge too
  else if (era0.judgeId && judgeId !== era0.judgeId && last) {
    // A new judge: the last checkpoint's stored packets re-judged by it, the bridge.
    const b = `${id}-rejudge`;
    const r = await rejudge(last.run, b);
    era = { era: era0.era + 1, from: now, why: "judge", judgeId, bench, measureHash: measure, bridge: { run: b, step: { Q: logit(r.after) - logit(r.before), ttfc: 1, ttd: 1 } } };
  }
  const eraNo = era?.era ?? era0!.era;

  const byId = new Map(benchCases().map((c) => [c.id, c]));
  const setOf = (r: Row) => (byId.get(r.case)?.bench === "U1" ? "human" : byId.get(r.case)?.set);
  const ok = rows.filter((r) => !r.void);
  const sub = (set: string) => shareOf(ok.filter((r) => setOf(r) === set), (r) => r.s, `${seed} ${set}`);
  const share = { all: shareOf(ok, (r) => r.s, seed), heldout: sub("heldout-chart"), tuning: sub("tuning"), human: sub("human") };
  const all = share.all;
  if (!all) throw new Error(`checkpoint ${id}: every case is void (runs/${run}/invariants.jsonl)`);
  const craft = shareOf(ok, (r) => r.sCraft, `${seed} craft`) ?? { n: 0, share: 0.5, lo90: 0.5, hi90: 0.5 };
  const Q = { value: anchor.Q + logit(all.share), lo90: anchor.Q + logit(all.lo90), hi90: anchor.Q + logit(all.hi90) };
  const health = healthOf(run, rows, byId);
  const voided = health.voidPct > LOOP.voidMax || health.flipPct > LOOP.flipAlarm;
  // Hedges and beat compliance are the frozen yardstick's, the same at every checkpoint of an era: reported in health, never
  // colouring a point (one low B1 would otherwise empty the era's trend lines).
  const trust = trustOf(voided, run, health.flipPct >= AMBER.flip);
  // The anchor ladder (§5.2): only a clear win moves it, never at checkpoint 0 or on a void point.
  const moved = !zero && trust !== "void" && all.share >= LOOP.anchorMove.share && all.lo90 >= LOOP.anchorMove.lo90;
  const links = [...past.map((c) => c.links), linksOf(id, rows, moved)];
  const { debts, vsLatencyCheckpoint, vsQualityCheckpoint } = debtsAfter(last?.debts, links);
  const usd = (i: 0 | 1) => (ok.length ? ok.reduce((a, r) => a + r.usd[i], 0) / ok.length : 0);
  const overfitGap = share.tuning && share.heldout ? share.tuning.share - share.heldout.share : 0;
  const harness = harnessTag();
  const served = [...new Set(meterOf(run).filter(product).flatMap((c) => (c.servedModel ? [c.servedModel] : [])))].sort();
  const aa = zero ? aaPass(rows) : undefined;
  const row: StoredCheckpoint = {
    id, epoch: o.epoch, era: eraNo, at: now, machine: process.arch === "arm64" ? "pgx" : "laptop", trust,
    champion: o.champion.sha, anchor: anchor.id, anchorMoved: moved, share, craft, Q,
    latency: {
      champion: latOf(ok, 1), anchor: latOf(ok, 0), ratioTtfc: pairedRatio(rows, "ttfc") ?? ONE, ratioTtd: pairedRatio(rows, "ttd") ?? ONE,
      chainedTtfc: Math.exp(chainSince(links, undefined, "ttfc").log), chainedTtd: Math.exp(chainSince(links, undefined, "ttd").log),
      debt: debts.latency.debt, vsLatencyCheckpoint,
    },
    quality: { debt: debts.quality.debt, vsQualityCheckpoint },
    ...(aa ? { aa: { pass: aa.pass, ci: aa.ci, tests: aa.tests } } : {}),
    productUsdPerSend: { champion: usd(1), anchor: usd(0) }, overfitGap, health, realism: realismOf([...byId.values()]),
    run, seed, judgeId, ...(o.champion.tuning ? { championTuning: o.champion.tuning } : {}), links: links.at(-1)!, debts, harness, served,
  };

  // ---- Written only now, so a failed run leaves the record as it was.
  const mark = (kind: Marker["kind"], label: string, ref?: string) => historyAdd("markers.jsonl", { at: now, era: eraNo, kind, label, ...(ref ? { ref } : {}) });
  if (era) historyWrite("eras.json", [...eras, era]);
  if (zero) historyWrite("anchors.json", [anchor]);
  if (last && harness !== last.harness) mark("harness", harness ? `${harness} re-pinned` : "harness off its tag", harness || undefined);
  if (last && served.join() !== last.served.join()) mark("served-model", `served ${served.join(", ")}`, served.join(","));
  if (moved) {
    const next: Anchor = { id: `A${anchors.length}`, sha: o.champion.sha, Q: Q.value, latency: row.latency.champion, ...(o.champion.tuning ? { tuning: o.champion.tuning } : {}) };
    historyWrite("anchors.json", [...anchors, next]);
    mark("anchor", `anchor ${next.id}`, id);
  }
  if (last && overfitGap > LOOP.overfitGap && last.overfitGap > LOOP.overfitGap)
    ownerItem(`overfitting: tuning share minus H-chart share ${overfitGap.toFixed(2)} at ${id} and ${last.overfitGap.toFixed(2)} at ${last.id}`);
  if (aa) historyAdd("health.jsonl", { at: now, kind: "aa", pass: aa.pass, detail: { checkpoint: id, failed: aa.failed, kneeDown: aa.kneeDown } });
  if (o.owner) {
    const info = maybe<RunInfo>(runFile(run, "run.json"));
    const d: DecisionRow = {
      id: `owner-${id}`, kind: "owner-step", epoch: o.epoch, candSha: o.owner.candSha, baseSha: o.owner.baseSha, class: "owner", goal: "owner", verdict: "owner",
      reasons: [`owner: ${o.owner.commits} commits merged by rte sync`], trust, looks: [], counts: { wins: 0, losses: 0, ties: 0, exactTies: 0 },
      affected: { tuning: 0, of: 0, topUp: 0 }, checkpoint: id, latency: { ttfc: row.latency.ratioTtfc, ttd: row.latency.ratioTtd },
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
  commitHistory(`${id}: share ${all.share.toFixed(2)} against ${anchor.id}, Q ${Q.value.toFixed(2)}${moved ? `, anchor A${anchors.length}` : ""}${era ? `, era ${era.era} (${era.why})` : ""}${o.owner ? ", owner step" : ""}`);
  return row;
}
