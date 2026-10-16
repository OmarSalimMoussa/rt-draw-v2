// T20's acceptance check: the history branch, checkpoints, anchors, eras, the yardstick and the human set.
// Part 1 runs real checkpoints on t15's fake bank (one headless Chrome, the gateway on the fake API, fake
// tokens, 0 real calls; the fake API's requests must equal the gateway's calls): checkpoint 0 (A0 against
// A0, the aa block), U1 frozen from fake recorded sends (a bench era, bridged by re-running the last pair)
// and a judge change (an era bridged by re-judging the last checkpoint's packets). Part 2 runs the
// bookkeeping on crafted rows in a second temp home with a small git repo: bench freeze of 32 + 32 and
// verifyBench, the anchor rule, Q, both debts through an anchor move, markers, a measuring-code era, an
// owner step, the ledger, tried patches, the owner list and the push. Ports 5325–5327.
//   TMPDIR=<work dir> node --import ./evals/loop/node-hooks.mjs evals/checks/t20-history.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromeCount } from "./cdp.mjs";
import { check, cleanEnv, finish, tempHome } from "./lib.mjs";
import { JPEG, fakeLoop } from "./t15-ab.mjs";

const env = cleanEnv(); // no token, key or Claude session variable, for this process and every child
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, env);

const sha = (b) => createHash("sha256").update(b).digest("hex");
const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fails = (...a) => { try { git(...a); return false; } catch { return true; } };
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const write = (f, body) => (mkdirSync(dirname(f), { recursive: true }), writeFileSync(f, typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)));
const logit = (p) => Math.log(Math.min(0.95, Math.max(0.05, p)) / (1 - Math.min(0.95, Math.max(0.05, p))));
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// A CheckpointRow as §5.3 has it: every field there, finite, intervals around their estimates.
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const ratioOk = (x) => !!x && ["est", "lo90", "hi90", "lo95"].every((k) => fin(x[k]));
const shareOk = (x) => !!x && x.n > 0 && [x.share, x.lo90, x.hi90].every(fin) && x.lo90 <= x.share + 1e-9 && x.share <= x.hi90 + 1e-9;
const latOk = (x) => !!x && ["ttfcP50", "ttfcP75", "ttdP50", "ttdP75"].every((k) => fin(x[k]));
function invalid(r) {
  const l = r.latency, q = r.quality?.vsQualityCheckpoint, h = r.health ?? {};
  const t = (k) => r.aa?.tests?.[k];
  return Object.entries({
    id: /^ck-\d\d$/.test(r.id), head: fin(r.epoch) && fin(r.era) && !Number.isNaN(Date.parse(r.at)) && typeof r.machine === "string",
    trust: ["green", "amber", "void"].includes(r.trust), arms: /^[0-9a-f]{40}$/.test(r.champion) && /^A\d+$/.test(r.anchor) && typeof r.anchorMoved === "boolean",
    share: shareOk(r.share?.all) && ["heldout", "tuning", "human"].every((k) => r.share[k] === undefined || shareOk(r.share[k])) && shareOk(r.craft),
    Q: [r.Q?.value, r.Q?.lo90, r.Q?.hi90].every(fin) && r.Q.lo90 <= r.Q.value + 1e-9 && r.Q.value <= r.Q.hi90 + 1e-9,
    latency: latOk(l?.champion) && latOk(l?.anchor) && ratioOk(l?.ratioTtfc) && ratioOk(l?.ratioTtd) && fin(l?.chainedTtfc) && fin(l?.chainedTtd) && typeof l?.debt === "boolean"
      && ratioOk(l?.vsLatencyCheckpoint?.ttfc) && ratioOk(l?.vsLatencyCheckpoint?.ttd) && /^ck-\d\d$/.test(l?.vsLatencyCheckpoint?.L),
    quality: typeof r.quality?.debt === "boolean" && [q?.dQ, q?.lo90, q?.hi90].every(fin) && /^ck-\d\d$/.test(q?.P),
    cost: fin(r.productUsdPerSend?.champion) && fin(r.productUsdPerSend?.anchor) && fin(r.overfitGap),
    health: ["voidPct", "flipPct", "hedgePct", "beatCompliance", "coldShare", "psiMedian"].every((k) => fin(h[k])) && typeof h.thinking === "object",
    aa: r.aa === undefined || (typeof r.aa.pass === "boolean" && r.aa.ci === 0.99 && ["ttfc", "ttd", "order", "share"].every((k) => [t(k)?.est, t(k)?.lo, t(k)?.hi, t(k)?.halfWidth].every(fin) && t(k).halfWidth > 0)),
  }).filter(([, ok]) => !ok).map(([k]) => k);
}

const H = await import("../loop/history.ts");
const C = await import("../loop/checkpoint.ts");
const { benchCases } = await import("../loop/ab.ts");
const { paths } = await import("../loop/paths.ts");

// ======== Part 1: real checkpoints through the fake API

const L = await fakeLoop({ port: 5325 });
{
  const { p, champ, api, gw, rig, repo } = L;
  const { gatewayStatus } = await import("../loop/client.ts");
  const { freezeHuman, pageShot } = await import("../loop/human.ts");
  // The stray case voids wherever it lands: voided in the bank, as the bank voids a case.
  renameSync(p.bankCase(L.stray), `${p.bankCase(L.stray)}.void`);
  const hist = H.openHistory();
  check(git("-C", hist, "rev-parse", "--abbrev-ref", "HEAD") === "eval/history" && fails("-C", repo, "merge-base", "eval/history", "HEAD"), "the history worktree isn't the clone's orphan eval/history branch");

  const b1 = C.freeze({ heldout: 4, tuning: 4, seed: "t20" });
  const ck0 = await C.checkpoint({ rig, epoch: 0, champion: champ });
  check(!invalid(ck0).length, `checkpoint 0's row isn't a valid CheckpointRow: ${invalid(ck0).join(", ")}`);
  check(ck0.id === "ck-00" && ck0.anchor === "A0" && !ck0.anchorMoved && ck0.share.all.n === 8 - Math.round(ck0.health.voidPct * 8) && ck0.share.heldout && ck0.share.tuning, `checkpoint 0 isn't A0 against A0 on B1's 8 cases: ${JSON.stringify(ck0.share)}`);
  check(ck0.aa && ["ttfc", "ttd", "order", "share"].every((k) => ck0.aa.tests[k].halfWidth > 0), `checkpoint 0 carries no aa block with half-widths: ${JSON.stringify(ck0.aa)}`);
  const anchors0 = json(join(hist, "anchors.json")), eras0 = json(join(hist, "eras.json"));
  check(anchors0.length === 1 && anchors0[0].id === "A0" && anchors0[0].sha === champ.sha && anchors0[0].Q === 0, `anchors.json after checkpoint 0: ${JSON.stringify(anchors0)}`);
  check(eras0.length === 1 && eras0[0].why === "bench" && eras0[0].bench === b1.hash.slice(0, 16) && /^[0-9a-f]{16}$/.test(eras0[0].judgeId) && eras0[0].measureHash === C.measureHash(), `eras.json after checkpoint 0: ${JSON.stringify(eras0)}`);
  check(lines(join(hist, "health.jsonl")).some((h) => h.kind === "aa" && h.detail.checkpoint === "ck-00"), "checkpoint 0's A/A isn't in health.jsonl");
  check(!git("-C", hist, "status", "--porcelain") && git("-C", hist, "log", "--format=%s").includes("ck-00: share"), "checkpoint 0 wasn't committed on eval/history");
  check(json(join(hist, "runs", "ck-00.json")).rows.length === 8, "runs/ck-00.json doesn't hold checkpoint 0's rows");
  check(JSON.stringify(C.checkpointTrees(champ)) === JSON.stringify([champ.tree]), `checkpointTrees() after checkpoint 0: ${C.checkpointTrees(champ).join(", ")}`);

  // ---- U1 from recorded sends: two with a meant (one typed, one spoken with a mark), one without, one blank.
  const toy = L.tuning.find((id) => json(join(p.bankCase(id), "case.json")).start === "toyshop-home");
  const scene = json(join(p.bankCase(toy), "before.scene.json")), view = json(join(p.bankCase(toy), "input.json")).camera;
  const send = (id, input, strokes, meant) => write(join(p.human, `${id}.json`), { id, input, strokes, scene, view, at: "2026-10-16T09:00:00.000Z", recordedAt: "2026-10-16T09:00:01.000Z", ...(meant === undefined ? {} : { meant }) });
  send("h-20261016T090000-aaaa", "make the top bar pink", [], "the top navigation bar turns pink");
  send("h-20261016T090500-bbbb", [{ word: "badge", t0: 0, t1: 300 }, { word: "here", t0: 320, t1: 600 }], [{ id: 1, points: [[700, 60, 100], [702, 62, 160]], t0: 100, t1: 160 }], "a small sale badge where I tapped");
  send("h-20261016T091000-cccc", "add a footer", []);
  send("h-20261017T080000-dddd", "remove the logo", [], "   ");
  const u1 = await freezeHuman(pageShot((await rig.tab(0, "A", champ.tree)).page));
  const u1Dir = join(hist, "bench", "U1");
  const u1Cases = readdirSync(u1Dir).filter((d) => statSync(join(u1Dir, d)).isDirectory()).sort();
  check(JSON.stringify(u1Cases) === JSON.stringify(["h-20261016T090000-aaaa", "h-20261016T090500-bbbb"]), `bench/U1 holds ${u1Cases.join(", ")} (want the two sends with a meant)`);
  const shot = readFileSync(join(u1Dir, u1Cases[1], "before-ink.jpg"));
  check(shot[0] === 0xff && shot[1] === 0xd8 && shot.length > 2000, `U1's before image isn't a real JPEG shot (${shot.length} bytes)`);
  check(json(join(u1Dir, u1Cases[0], "input.json")).words === "make the top bar pink" && json(join(u1Dir, u1Cases[1], "meant.json")).meant === "a small sale badge where I tapped" && json(join(u1Dir, u1Cases[0], "case.json")).set === "human",
    "a U1 case lost its typed words, meant or set");
  check(C.verifyBench("U1").ok && json(join(u1Dir, "manifest.json")).hash === u1.hash, "U1's manifest doesn't match its files");

  // ---- ck-01: U1 joined the yardstick, so era 2 starts, bridged by re-running ck-00's pair on it.
  const ck1 = await C.checkpoint({ rig, epoch: 1, champion: champ });
  const eras1 = json(join(hist, "eras.json"));
  const bridge = eras1[1]?.bridge;
  check(!invalid(ck1).length && ck1.era === 2 && eras1.length === 2 && eras1[1].why === "bench" && eras1[1].bench === C.benchHash() && eras1[1].bench.includes("+"), `the U1 freeze didn't start a bench era: ${JSON.stringify(eras1.at(-1))}`);
  check(bridge?.run === "ck-01-bridge" && [bridge.step.Q, bridge.step.ttfc, bridge.step.ttd].every(fin) && json(join(hist, "runs", "ck-01-bridge.json")).rows.length === 10, `the bench era's bridge didn't re-run the last pair: ${JSON.stringify(bridge)}`);
  check(ck1.share.human?.n === 2 || ck1.health.voidPct > 0, `ck-01 has no human line: ${JSON.stringify(ck1.share.human)}`);
  check(u1Cases.every((c) => existsSync(join(u1Dir, c, "expectation.json"))) && C.verifyBench("U1").ok && C.benchHash() === eras1[1].bench, "U1's new expectations weren't written back, or moved its hash");

  // ---- ck-02: calibration adopts fidelity variant 2, a new judgeId: era 3, bridged by re-judging ck-01's packets.
  write(join(hist, "judge", "calibration.json"), { use: { fidelity: 2 } });
  const before = (await gatewayStatus(gw.url)).calls;
  const ck2 = await C.checkpoint({ rig, epoch: 2, champion: champ });
  const eras2 = json(join(hist, "eras.json"));
  const packets = readdirSync(join(p.run("ck-01"), "cases")).filter((c) => existsSync(join(p.run("ck-01"), "cases", c, "judge", "packet.json"))).length;
  check(!invalid(ck2).length && ck2.era === 3 && eras2[2]?.why === "judge" && eras2[2].judgeId !== eras2[1].judgeId && eras2[2].bridge?.run === "ck-02-rejudge" && eras2[2].bridge.step.ttfc === 1 && fin(eras2[2].bridge.step.Q),
    `a judge change didn't start an era bridged by a re-judge: ${JSON.stringify(eras2.at(-1))}`);
  check(lines(join(p.run("ck-02-rejudge"), "rejudged.jsonl")).length === packets && packets > 0, `the re-judge didn't cover ck-01's ${packets} packets`);
  check(!lines(join(hist, "markers.jsonl")).some((m) => m.kind === "harness" || m.kind === "served-model"), "a marker was written though the harness and served models didn't change");
  console.error(`t20: ck-00 share ${ck0.share.all.share.toFixed(2)} (aa ${ck0.aa.pass ? "pass" : `fail ${JSON.stringify(ck0.aa.tests)}`}), ck-01 bridge step Q ${bridge.step.Q.toFixed(2)}, ck-02 re-judge step Q ${eras2[2].bridge.step.Q.toFixed(2)}; ${(await gatewayStatus(gw.url)).calls - before} calls for ck-02`);

  const total = (await gatewayStatus(gw.url)).calls;
  check(api.requests.length === total && total > 0, `the fake API got ${api.requests.length} requests for the gateway's ${total} calls`);
  check(!rig.blocked.length, `a page requested ${rig.blocked.join(", ")}`);
  await L.close();
  check(chromeCount(join(p.home, "chrome")) === 0, "Chrome processes are left after close");
}

// ======== Part 2: the bookkeeping on crafted rows (no Chrome, no gateway)

const home = tempHome();
const p = paths();
const repo = join(home, "repo");
mkdirSync(repo);
git("-C", repo, "init", "-q", "-b", "master");
const ID = ["-c", "user.name=rt-check", "-c", "user.email=check@localhost"];
const commitIn = (dir, files, msg) => {
  for (const [f, body] of Object.entries(files)) write(join(dir, f), body);
  git("-C", dir, "add", "-A");
  git("-C", dir, ...ID, "commit", "-qm", msg);
  return git("-C", dir, "rev-parse", "HEAD");
};
const c = [commitIn(repo, { "evals/bridge/timing.ts": "// timing\n", "evals/judge/judge.ts": "// judge\n", "evals/core/diff.ts": "// diff\n", "src/app.ts": "export const v = 0;\n" }, "harness and product")];
git("-C", repo, "tag", "eval-harness-1");
// A judge id written before the worktree existed: adopted into it.
write(join(p.history, "judge", "ids.json"), { "j-early": { role: "fidelity" } });

// A bank: 32 H-chart cases (8 sessions × 4) and 64 tuning cases (32 sessions × 2), files only.
const ASKS = ["add", "remove", "move", "resize", "restyle", "retext", "reorder", "new-page"];
const bankCase = (id, set, session, n, ask, extra = {}) => {
  const d = p.bankCase(id);
  write(join(d, "case.json"), { id, set, scenario: session, persona: "explorer", style: "typical", start: "blank", ask, seed: n, originSession: session, send: n, championSha: c[0], tuningId: "defaults", harnessTag: "eval-harness-1", configId: "check", recordedAt: "2026-10-16T00:00:00.000Z", hedged: false, beatDone: true, flags: [], ...extra });
  write(join(d, "input.json"), { camera: { x: 0, y: 0, zoom: 1 }, words: [{ word: `w${id}`, t0: 0, t1: 100 }], strokes: [], enterAtMs: 200, inputHash: sha(id) });
  write(join(d, "before.scene.json"), { shapes: [], id });
  write(join(d, "meant.json"), { meant: `meant ${id}`, hedged: n === 1 && set === "heldout-chart" });
  write(join(d, "expectation.json"), { judgeId: "j1", should: ["x"], mustNot: [] });
  write(join(d, "readings.json"), { marks: [] });
  write(join(d, "before-ink.jpg"), JPEG);
  write(join(d, "done"), "done\n");
};
for (let k = 1; k <= 8; k++) for (let n = 1; n <= 4; n++) bankCase(`c-h-s${k}-${n}`, "heldout-chart", `h-s${k}`, n, ASKS[(k + n) % 8], n === 2 ? { beat: "two-cand", beatDone: k !== 1 } : {});
for (let k = 1; k <= 32; k++) for (let n = 1; n <= 2; n++) bankCase(`c-t-s${String(k).padStart(2, "0")}-${n}`, "tuning", `t-s${k}`, n, ASKS[(2 * k + 3 * n) % 8]);
bankCase("c-g-s1-1", "heldout-gate", "g-s1", 1, "add");

// ---- bench freeze: 32 H-chart + 32 tuning (one per session), a manifest whose hash recomputes; tampering is caught.
const hist = H.openHistory();
check(fails("-C", repo, "merge-base", "eval/history", "master") && existsSync(`${p.history}.void`) && JSON.parse(git("-C", repo, "show", "eval/history:judge/ids.json"))["j-early"], "a file written before the worktree wasn't adopted onto the orphan branch");
const m = C.freeze({ seed: "t20" });
const B1 = join(hist, "bench", "B1");
const picked = readdirSync(B1).filter((d) => statSync(join(B1, d)).isDirectory()).map((d) => json(join(B1, d, "case.json")));
const tuning = picked.filter((x) => x.set === "tuning");
const askCounts = Object.values(Object.groupBy(tuning, (x) => x.ask)).map((g) => g.length);
check(picked.filter((x) => x.set === "heldout-chart").length === 32 && tuning.length === 32 && new Set(tuning.map((x) => x.originSession)).size === 32 && picked.length === 64,
  `bench/B1 isn't the 32 H-chart + 32 tuning cases one per session (${picked.length} cases, ${new Set(tuning.map((x) => x.originSession)).size} tuning sessions)`);
check(Math.max(...askCounts) - Math.min(...askCounts) <= 2, `B1's tuning asks aren't balanced: ${JSON.stringify(Object.fromEntries(Object.entries(Object.groupBy(tuning, (x) => x.ask)).map(([k, g]) => [k, g.length])))}`);
const files = {};
for (const d of readdirSync(B1).filter((x) => statSync(join(B1, x)).isDirectory()).sort())
  for (const f of readdirSync(join(B1, d)).sort()) if (f !== "expectation.json") files[`${d}/${f}`] = sha(readFileSync(join(B1, d, f)));
const recomputed = sha(Object.entries(files).map(([f, h]) => `${f} ${h}`).join("\n"));
const onDisk = json(join(B1, "manifest.json"));
check(onDisk.hash === recomputed && m.hash === recomputed && Object.keys(onDisk.files).length === 64 * 6 && JSON.stringify(onDisk.files) === JSON.stringify(files) && onDisk.version === "B1",
  `B1's manifest hash ${onDisk.hash} isn't the recomputed ${recomputed} (${Object.keys(onDisk.files).length} files)`);
check(json(join(B1, "manifest.json")).hash === JSON.parse(git("-C", repo, "show", "eval/history:bench/B1/manifest.json")).hash, "bench freeze wasn't committed");
const victim = join(B1, picked[5].id, "before.scene.json");
const kept = readFileSync(victim);
check(C.verifyBench().ok, "verifyBench() fails an untouched B1");
writeFileSync(victim, Buffer.concat([kept, Buffer.from(" ")]));
const tampered = C.verifyBench();
writeFileSync(victim, kept);
check(!tampered.ok && JSON.stringify(tampered.bad) === JSON.stringify([`${picked[5].id}/before.scene.json`]) && C.verifyBench().ok, `verifyBench() didn't catch the tampered file: ${JSON.stringify(tampered)}`);
let refroze = false;
try { C.freeze(); refroze = true; } catch {}
check(!refroze, "a second bench freeze over a frozen B1 wasn't refused");

// ---- Checkpoints on crafted rows: each run id has a plan (who wins, how much slower B is, the served model).
const bench = benchCases().filter((x) => x.bench === "B1");
const info = new Map(bench.map((x) => [x.id, json(join(x.dir, "case.json"))]));
const even = (share) => (x, i) => (Math.floor((i + 1) * share) - Math.floor(i * share) ? 1 : -1);
const plans = {};
const asked = [];
let served = "claude-x-1";
const runner = async ({ run, anchor, champion }) => {
  asked.push({ run, anchor: anchor.sha, champion: champion.sha });
  const { win, ratio = 1 } = plans[run];
  const rows = bench.map((x, i) => {
    const jit = 1 + 0.02 * ((i % 5) - 2); // per-case noise, so every interval has a width
    const s = win(x, i);
    return { case: x.id, cluster: info.get(x.id).originSession, affected: true, class: "Q", s, sCraft: s, ttfc: [1000, Math.round(1000 * ratio * jit)], ttd: [3000, Math.round(3000 * ratio * jit)],
      work: [1, 1], usd: [0.03, 0.03], thought: [false, false], overuse: [false, false], pics: [[0, 0], [0, 0]], ask: info.get(x.id).ask, firstArm: i % 2 ? "B" : "A" };
  });
  write(join(p.run(run), "rows.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  write(join(p.run(run), "run.json"), { id: run, kind: "checkpoint", meter: { calls: 120, listUsd: 4.8, minutes: 4.2 } });
  mkdirSync(dirname(p.calls), { recursive: true });
  appendFileSync(p.calls, JSON.stringify({ at: "2026-10-16T00:00:00.000Z", run, case: bench[0].id, arm: "B", role: "draw", model: "sonnet", servedModel: served, mode: "live", shared: "-", thinkingTokens: 0, readyAtTake: true }) + "\n");
  return rows;
};
const share = (rows) => rows.reduce((a, r) => a + (r.s + 1) / 2, 0) / rows.length;
const run = async (id, champion, plan, extra = {}) => {
  plans[id] = plan;
  return C.checkpoint({ epoch: Number(id.slice(3)), champion: { sha: champion }, runner, ...extra });
};
const tuningOf = (x) => info.get(x.id).set === "tuning";
const helds = [...new Set(bench.filter((x) => !tuningOf(x)).map((x) => info.get(x.id).originSession))].sort();
/** Wins and losses in whole sessions: half the H-chart sessions lose every case, 29 of 32 tuning cases win (share 0.70, a wide interval). */
const clumped = (x, i) => (tuningOf(x) ? (i % 11 === 3 ? -1 : 1) : helds.indexOf(info.get(x.id).originSession) < 4 ? 1 : -1);
// Product commits go on loop/champion in its own worktree: the clone's HEAD stays the pinned harness.
const champWt = join(home, "wt-champion");
git("-C", repo, "worktree", "add", "-q", "-b", "loop/champion", champWt);
const commits = (n) => { for (let k = 1; k <= n; k++) c.push(commitIn(champWt, { "src/app.ts": `export const v = ${c.length};\n` }, `product ${c.length}`)); };
commits(4);

const k0 = await run("ck-00", c[0], { win: even(0.5) });
const k1 = await run("ck-01", c[1], { win: even(0.8), ratio: 1.1 });
const k2 = await run("ck-02", c[2], { win: even(0.5) });
const k3 = await run("ck-03", c[3], { win: clumped, ratio: 0.88 });
const k4 = await run("ck-04", c[4], { win: (x, i) => (tuningOf(x) && i % 5 === 1 ? 1 : -1) });
const rowsOf = (id) => lines(join(p.run(id), "rows.jsonl"));
for (const k of [k0, k1, k2, k3, k4]) check(!invalid(k).length, `${k.id}'s row isn't a valid CheckpointRow: ${invalid(k).join(", ")}`);

// Anchors move only by §5.2's rule: share ≥ 0.70 with its 90% lower bound ≥ 0.60.
const anchors = json(join(hist, "anchors.json"));
check(k1.anchorMoved && k1.share.all.share >= 0.7 && k1.share.all.lo90 >= 0.6 && anchors.length === 2 && anchors[1].id === "A1" && anchors[1].sha === c[1] && near(anchors[1].Q, k1.Q.value), `ck-01 (share ${k1.share.all.share.toFixed(2)}, lo90 ${k1.share.all.lo90.toFixed(2)}) didn't freeze A1: ${JSON.stringify(anchors)}`);
check(!k3.anchorMoved && k3.share.all.share >= 0.7 && k3.share.all.lo90 < 0.6 && !k0.anchorMoved && !k2.anchorMoved && !k4.anchorMoved, `the anchor moved on a share whose lower bound is under 0.60 (ck-03: ${JSON.stringify(k3.share.all)})`);
check(lines(join(hist, "markers.jsonl")).filter((x) => x.kind === "anchor").map((x) => x.ref).join() === "ck-01", "the anchor move isn't one marker at ck-01");
// Q chains: Q(anchor) + logit(share), the anchor's Q frozen with it.
check(near(k0.Q.value, logit(k0.share.all.share)) && near(k1.Q.value, logit(k1.share.all.share)) && k2.anchor === "A1" && near(k2.Q.value, k1.Q.value + logit(k2.share.all.share)) && near(k4.Q.value, anchors[1].Q + logit(k4.share.all.share)),
  `Q doesn't chain: ${[k0, k1, k2, k3, k4].map((k) => `${k.id} ${k.anchor} ${k.Q.value.toFixed(3)}`).join(", ")}`);
// Latency debt through the move: ck-02's champion is as fast as A1, but A1 was 1.10× A0 in ck-01's own run.
check(k1.latency.debt && k1.latency.vsLatencyCheckpoint.L === "ck-00" && k1.latency.vsLatencyCheckpoint.ttd.lo90 > 1.05, `ck-01 (1.10× slower) isn't in latency debt: ${JSON.stringify(k1.latency.vsLatencyCheckpoint)}`);
check(k2.latency.debt && Math.abs(k2.latency.ratioTtd.est - 1) < 0.03 && Math.abs(k2.latency.vsLatencyCheckpoint.ttd.est - 1.1) < 0.03 && Math.abs(k2.latency.chainedTtd - 1.1) < 0.03,
  `ck-02's debt isn't the chain through ck-01's anchor move: ratio ×${k2.latency.ratioTtd.est.toFixed(3)}, vs L ×${k2.latency.vsLatencyCheckpoint.ttd.est.toFixed(3)}, chained ×${k2.latency.chainedTtd.toFixed(3)}`);
check(!k3.latency.debt && k3.debts.latency.L === "ck-03" && Math.abs(k3.latency.chainedTtd - 0.968) < 0.03, `ck-03 (0.88× A1) didn't clear the debt and become L: ${JSON.stringify(k3.debts)}, chained ×${k3.latency.chainedTtd.toFixed(3)}`);
// Quality debt: ΔQ against P = ck-00 is this run's log-odds minus P's plus the move's (ck-01), all same-run shares.
const dQ = logit(share(rowsOf("ck-04"))) - logit(share(rowsOf("ck-00"))) + logit(share(rowsOf("ck-01")));
const q4 = k4.quality.vsQualityCheckpoint;
check(k4.quality.debt && q4.P === "ck-00" && near(q4.dQ, dQ, 1e-6) && q4.hi90 < 0 && !k2.quality.debt && near(k2.quality.vsQualityCheckpoint.dQ, logit(share(rowsOf("ck-01"))) + logit(share(rowsOf("ck-02"))) - logit(share(rowsOf("ck-00"))), 1e-6),
  `quality debt isn't the same-run chain through the move: ck-04 ${JSON.stringify(q4)} (want dQ ${dQ.toFixed(3)}), ck-02 ${JSON.stringify(k2.quality)}`);
console.error(`t20: ck-01 share ${k1.share.all.share.toFixed(3)} lo90 ${k1.share.all.lo90.toFixed(3)} (moved); ck-03 share ${k3.share.all.share.toFixed(3)} lo90 ${k3.share.all.lo90.toFixed(3)} (kept A1); ck-02 TTD ×${k2.latency.ratioTtd.est.toFixed(3)} vs L ×${k2.latency.vsLatencyCheckpoint.ttd.est.toFixed(3)} lo90 ${k2.latency.vsLatencyCheckpoint.ttd.lo90.toFixed(3)}; ck-04 dQ ${q4.dQ.toFixed(3)} hi90 ${q4.hi90.toFixed(3)}`);
// The overfitting gap above 0.15 at two checkpoints in a row → the owner list.
check(k3.overfitGap > 0.15 && k4.overfitGap > 0.15 && /overfitting.*ck-04/.test(readFileSync(join(hist, "owner-list.md"), "utf8")), `the overfitting gap (${k3.overfitGap.toFixed(2)}, ${k4.overfitGap.toFixed(2)}) twice didn't reach the owner list`);

// ---- A harness re-pin and a new served model are markers only; measuring code starts an era, bridged by re-running the last pair.
commits(1);
commitIn(repo, { "evals/README.md": "re-pinned\n" }, "harness 2");
git("-C", repo, "tag", "eval-harness-2");
served = "claude-x-2";
const k5 = await run("ck-05", c[5], { win: even(0.5) });
const marks5 = lines(join(hist, "markers.jsonl")).filter((x) => x.at === k5.at);
check(marks5.some((x) => x.kind === "harness" && x.ref === "eval-harness-2") && marks5.some((x) => x.kind === "served-model" && x.ref === "claude-x-2") && json(join(hist, "eras.json")).length === 1 && k5.era === 1,
  `a harness tag or served-model change did more than add a marker: markers ${JSON.stringify(marks5)}, eras ${json(join(hist, "eras.json")).length}`);
commits(1);
commitIn(repo, { "evals/judge/judge.ts": "// judge, changed\n" }, "harness 3: judge code");
git("-C", repo, "tag", "eval-harness-3");
plans["ck-06-bridge"] = { win: even(0.6), ratio: 1.2 };
const k6 = await run("ck-06", c[6], { win: even(0.5) });
const eras = json(join(hist, "eras.json"));
const e2 = eras[1];
check(eras.length === 2 && e2.why === "measure" && e2.measureHash === C.measureHash() && e2.measureHash !== eras[0].measureHash && k6.era === 2 && e2.bridge?.run === "ck-06-bridge", `a measuring-code change didn't start a bridged era: ${JSON.stringify(eras)}`);
check(asked.some((a) => a.run === "ck-06-bridge" && a.anchor === c[1] && a.champion === c[5]) && near(e2.bridge.step.Q, logit(share(rowsOf("ck-06-bridge"))) - logit(k5.share.all.share)) && Math.abs(e2.bridge.step.ttd - 1.2 / k5.latency.ratioTtd.est) < 1e-9,
  `the bridge didn't re-run ck-05's pair (A1 against its champion) or its step is off: ${JSON.stringify(e2.bridge)}`);

// ---- An owner step: a checkpoint, an owner-step DecisionRow and a labelled marker.
commits(1);
const k7 = await run("ck-07", c[7], { win: even(0.5) }, { owner: { commits: 3, baseSha: c[6], candSha: c[7] } });
const owner = lines(join(hist, "decisions.jsonl")).find((d) => d.kind === "owner-step");
check(owner?.id === "owner-ck-07" && owner.checkpoint === "ck-07" && owner.class === "owner" && owner.goal === "owner" && owner.verdict === "owner" && owner.reasons[0] === "owner: 3 commits merged by rte sync" && owner.candSha === c[7] && owner.run === "ck-07" && ratioOk(owner.latency.ttfc),
  `the owner step's DecisionRow: ${JSON.stringify(owner)}`);
check(lines(join(hist, "markers.jsonl")).some((x) => x.kind === "owner-step" && x.label === "owner: 3 commits" && x.ref === "ck-07") && readFileSync(join(hist, "ledger.md"), "utf8").includes("## owner-ck-07 · owner step"), "the owner step has no marker or ledger entry");
check([k5, k6, k7].every((k) => !invalid(k).length), "a later checkpoint's row isn't valid");

// ---- A card decision: decisions.jsonl, the ledger, the tried patch with its header, the owner list, runs/<id>.json, a pushed commit.
const bare = join(home, "remote.git");
git("init", "-q", "--bare", bare);
git("-C", repo, "remote", "add", "hist", bare);
git("-C", repo, "config", "branch.eval/history.remote", "hist");
const wt = join(home, "wt-cand");
git("-C", repo, "worktree", "add", "-q", "-b", "cand/e1-h1", wt, c[7]);
const cand = commitIn(wt, { "src/app.ts": "export const v = 'a candidate';\n" }, "candidate: resolve with fewer words");
const { decide } = await import("../loop/verdict.ts");
const card = { id: "e1-h1", component: "draw", kind: "code", change: "draw prose opener", goal: "fidelity", classGuess: "Q", dialogue: false, predicts: "", isPatch: false, raisesCost: false, touchesFrozen: false, risk: "", files: ["src/app.ts"] };
const dRows = bench.filter(tuningOf).slice(0, 16).map((x, i) => ({ case: x.id, cluster: info.get(x.id).originSession, affected: true, class: "Q", s: -1, ttfc: [1000, 1010], ttd: [3000, 3030], work: [1, 1], usd: [0.03, 0.03], thought: [false, false], overuse: [false, false], pics: [[0, 0], [0, 0]], ask: info.get(x.id).ask, firstArm: i % 2 ? "B" : "A" }));
write(join(p.run("e1-h1-g2"), "rows.jsonl"), dRows.map((x) => JSON.stringify(x)).join("\n") + "\n");
write(join(p.run("e1-h1-g2"), "run.json"), { id: "e1-h1-g2", kind: "ab", meter: { calls: 40, listUsd: 1.5, minutes: 9 } });
const decision = decide({ tuning: dRows, exhausted: true, flips: { audited: 0, flipped: 0 }, cold: [0, 0], invariants: 0 }, card, { latencyDebt: false, qualityDebt: false, costVsAnchor: 1 });
const d = H.decisionRow({ id: "e1-h1", epoch: 8, card, candSha: cand, baseSha: c[7], run: "e1-h1-g2", judgeId: "j-check", result: { rows: dRows, decision }, affected: { tuning: 16, of: 64, topUp: 0 } });
const head = H.recordDecision(d, { owner: ["3 failures in a row on draw"] });
const patch = readFileSync(join(hist, "tried", "e1-h1.patch"), "utf8");
check(d.verdict === "revert" && d.counts.exactTies === 48 && d.cost.listUsd === 1.5 && lines(join(hist, "decisions.jsonl")).at(-1).id === "e1-h1", `the card decision's row: ${JSON.stringify({ verdict: d.verdict, counts: d.counts, cost: d.cost })}`);
check(/^rt-eval tried: e1-h1\ntitle: draw prose opener\ncomponent: draw\nverdict: revert/.test(patch) && patch.includes("diff --git a/src/app.ts") && patch.includes("candidate: resolve with fewer words"), `tried/e1-h1.patch isn't the format-patch under a card and verdict header:\n${patch.slice(0, 300)}`);
check(H.triedIndex().some((l) => /^e1-h1 draw prose opener \| draw \| [0-9a-f]{12} \| revert$/.test(l)), `the tried index: ${H.triedIndex().join(" / ")}`);
check(readFileSync(join(hist, "ledger.md"), "utf8").includes("## e1-h1 · draw · revert (Q, fidelity)") && /- \[ \] \d{4}-\d\d-\d\d: e1-h1: 3 failures in a row on draw/.test(readFileSync(join(hist, "owner-list.md"), "utf8")), "the ledger entry or the owner-list item is missing");
check(json(join(hist, "runs", "e1-h1-g2.json")).rows.length === 16 && json(join(hist, "runs", "e1-h1-g2.json")).run.meter.calls === 40, "runs/<id>.json doesn't hold the run and its rows");
check(head && git("-C", bare, "rev-parse", "eval/history") === head && !git("-C", hist, "status", "--porcelain"), "the decision's commit wasn't pushed to the branch's remote");
const big = Array.from({ length: 1500 }, (_, i) => JSON.stringify({ ...dRows[0], case: `big-${i}`, void: "x".repeat(200) })).join("\n") + "\n";
write(join(p.run("big"), "rows.jsonl"), big);
H.saveRun("big");
const bigFile = join(hist, "runs", "big.json");
check(statSync(bigFile).size <= 200_000 && json(bigFile).dropped > 0, `runs/big.json is ${statSync(bigFile).size} bytes (cap 200 KB)`);

write(p.machine, { host: "check-host", slots: 2, dispatchLimitMs: 25 });
H.recordMachine();
check(json(join(hist, "machine", "check-host.json")).dispatchLimitMs === 25, "machine.json wasn't kept as machine/<host>.json");

// ---- Everything above is on the branch: one commit per record, nothing left uncommitted.
const log = git("-C", hist, "log", "--format=%s");
check(["bench freeze: B1", ...["00", "01", "02", "03", "04", "05", "06", "07"].map((n) => `ck-${n}: share`), "e1-h1: revert", "adopt what was written"].every((s) => log.includes(s)) && Number(git("-C", hist, "rev-list", "--count", "HEAD")) >= 12,
  `eval/history's log is missing a record:\n${log}`);
check(JSON.parse(git("-C", repo, "show", "eval/history:anchors.json")).length === 2 && git("-C", repo, "show", "eval/history:checkpoints.jsonl").split("\n").length === 8, "the committed anchors or checkpoints differ from the worktree's");
finish();
