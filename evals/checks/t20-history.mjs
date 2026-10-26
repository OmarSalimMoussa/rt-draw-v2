// T20's acceptance check: the history branch, checkpoints against A0, eras, the yardstick and the human set.
// Part 1 runs real checkpoints on t15's fake bank (one headless Chrome, the gateway on the fake API, fake
// tokens, 0 real calls; the fake API's requests must equal the gateway's calls): checkpoint 0 (A0 against
// A0, the aa block), U1 frozen from fake recorded sends (a new bench: the next era) and a judge change (a new
// judgeId: the next era). Part 2 runs the bookkeeping on crafted rows in a second temp home with a small git
// repo: bench freeze of 32 + 32 and verifyBench, A0 that never moves, a surely slower champion on the owner
// list, markers, an owner step, the ledger, tried patches, the owner list and the push. Ports 5325–5327.
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

// A CheckpointRow as §5.3 has it: every field there, finite, intervals around their estimates.
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const ratioOk = (x) => !!x && fin(x.est) && (x.p === undefined || (fin(x.p.slower) && fin(x.p.faster)));
const shareOk = (x) => !!x && x.n > 0 && [x.share, x.lo90, x.hi90].every(fin) && x.lo90 <= x.share + 1e-9 && x.share <= x.hi90 + 1e-9;
const latOk = (x) => !!x && ["ttfcP50", "ttfcP75", "ttdP50", "ttdP75", "ttfdP50", "ttfdP75", "renderP50", "renderP75"].every((k) => fin(x[k]));
function invalid(r) {
  const l = r.latency, h = r.health ?? {};
  const t = (k) => r.aa?.tests?.[k];
  return Object.entries({
    id: /^ck-\d\d$/.test(r.id), head: fin(r.epoch) && fin(r.era) && !Number.isNaN(Date.parse(r.at)) && typeof r.machine === "string",
    trust: ["green", "amber", "void"].includes(r.trust), arms: /^[0-9a-f]{40}$/.test(r.champion) && r.anchor === "A0",
    share: shareOk(r.share?.all) && ["heldout", "tuning", "human"].every((k) => r.share[k] === undefined || shareOk(r.share[k])) && shareOk(r.craft),
    latency: latOk(l?.champion) && latOk(l?.anchor) && ratioOk(l?.ratioTtfc) && ratioOk(l?.ratioTtd) && ratioOk(l?.ratioTtfd) && ratioOk(l?.ratioRender)
      && (l.slower === undefined || /^latency veto: surely slower/.test(l.slower)),
    cost: fin(r.productUsdPerSend?.champion) && fin(r.productUsdPerSend?.anchor) && fin(r.overfitGap),
    health: ["voidPct", "flipPct", "hedgePct", "beatCompliance", "coldShare", "psiMedian"].every((k) => fin(h[k])) && typeof h.thinking === "object",
    aa: r.aa === undefined || (typeof r.aa.pass === "boolean" && r.aa.ci === 0.99 && ["ttfd", "render", "order", "share"].every((k) => [t(k)?.est, t(k)?.lo, t(k)?.hi, t(k)?.halfWidth].every(fin) && t(k).halfWidth > 0)),
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
  check(ck0.id === "ck-00" && ck0.anchor === "A0" && ck0.era === 1 && ck0.bench === b1.hash.slice(0, 16) && !ck0.latency.slower && ck0.share.all.n === 8 - Math.round(ck0.health.voidPct * 8) && ck0.share.heldout && ck0.share.tuning, `checkpoint 0 isn't A0 against A0 on B1's 8 cases: ${JSON.stringify(ck0.share)}`);
  check(ck0.aa && ["ttfd", "render", "order", "share"].every((k) => ck0.aa.tests[k].halfWidth > 0), `checkpoint 0 carries no aa block with half-widths: ${JSON.stringify(ck0.aa)}`);
  const anchors0 = json(join(hist, "anchors.json"));
  check(JSON.stringify(anchors0) === JSON.stringify([{ id: "A0", sha: champ.sha }]) && /^[0-9a-f]{16}$/.test(ck0.judgeId) && !existsSync(join(hist, "eras.json")), `anchors.json after checkpoint 0: ${JSON.stringify(anchors0)}`);
  check(lines(join(hist, "health.jsonl")).some((h) => h.kind === "aa" && h.detail.checkpoint === "ck-00"), "checkpoint 0's A/A isn't in health.jsonl");
  check(!git("-C", hist, "status", "--porcelain") && git("-C", hist, "log", "--format=%s").includes("ck-00: share"), "checkpoint 0 wasn't committed on eval/history");
  check(json(join(hist, "runs", "ck-00.json")).rows.length === 8, "runs/ck-00.json doesn't hold checkpoint 0's rows");
  // The anchor is the champion: its tree twice, so each arm gets its own Vite.
  check(JSON.stringify(C.checkpointTrees(champ)) === JSON.stringify([champ.tree, champ.tree]), `checkpointTrees() after checkpoint 0: ${C.checkpointTrees(champ).join(", ")}`);

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

  // ---- ck-01: U1 joined the yardstick, a new bench: era 2, charted apart (nothing bridges two eras).
  const eraMarks = () => lines(join(hist, "markers.jsonl")).filter((m) => m.kind === "era").map((m) => `${m.ref} ${m.era} ${m.label}`);
  const ck1 = await C.checkpoint({ rig, epoch: 1, champion: champ });
  check(!invalid(ck1).length && ck1.era === 2 && ck1.bench === C.benchHash() && ck1.bench.includes("+") && eraMarks().join() === "ck-01 2 era 2: a new bench", `the U1 freeze didn't start era 2: ${ck1.era}, ${eraMarks().join(" / ")}`);
  check(!existsSync(p.run("ck-01-bridge")) && JSON.stringify(json(join(hist, "anchors.json"))) === JSON.stringify(anchors0), "a new bench re-ran a pair or moved A0");
  check(ck1.share.human?.n === 2 || ck1.health.voidPct > 0, `ck-01 has no human line: ${JSON.stringify(ck1.share.human)}`);
  check(u1Cases.every((c) => existsSync(join(u1Dir, c, "expectation.json"))) && C.verifyBench("U1").ok && C.benchHash() === ck1.bench, "U1's new expectations weren't written back, or moved its hash");

  // ---- ck-02: calibration adopts fidelity variant 2, a new judgeId: era 3, nothing re-judged.
  write(join(hist, "judge", "calibration.json"), { use: { fidelity: 2 } });
  const before = (await gatewayStatus(gw.url)).calls;
  const ck2 = await C.checkpoint({ rig, epoch: 2, champion: champ });
  check(!invalid(ck2).length && ck2.era === 3 && ck2.judgeId !== ck1.judgeId && eraMarks().at(-1) === "ck-02 3 era 3: a new judge" && !existsSync(p.run("ck-02-rejudge")), `a judge change didn't start era 3: ${ck2.era}, ${eraMarks().join(" / ")}`);
  check(!lines(join(hist, "markers.jsonl")).some((m) => m.kind === "harness" || m.kind === "served-model"), "a marker was written though the harness and served models didn't change");
  console.error(`t20: ck-00 share ${ck0.share.all.share.toFixed(2)} (aa ${ck0.aa.pass ? "pass" : `fail ${JSON.stringify(ck0.aa.tests)}`}), eras ${[ck0, ck1, ck2].map((k) => k.era).join(" ")}; ${(await gatewayStatus(gw.url)).calls - before} calls for ck-02`);

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

// ---- A decision's scan: no case retires, so past LOOP.bank.scanMax tuning cases each decision scans its own seeded
// sample of whole sessions; under it, every case, as before the cap.
{
  const { scanCases } = await import("../loop/rte.ts");
  const { LOOP } = await import("../loop/config.ts");
  const all = scanCases("d1");
  check(all.length === 65 && all.join() === [...all].sort().join(), `under the cap the scan didn't take all 64 tuning cases and the H-gate case, sorted: ${all.length}`);
  const max = LOOP.bank.scanMax;
  LOOP.bank.scanMax = 20;
  const draws = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"].map((s) => scanCases(s));
  const again = scanCases("d1");
  LOOP.bank.scanMax = max;
  const tuningOf = (ids) => ids.filter((id) => id.startsWith("c-t-"));
  const sessions = (ids) => new Set(tuningOf(ids).map((id) => id.replace(/-\d+$/, ""))).size;
  check(draws.every((d) => tuningOf(d).length === 20 && sessions(d) === 10 && d.includes("c-g-s1-1")) && again.join() === draws[0].join(),
    `past the cap a scan isn't 20 tuning cases in 10 whole sessions plus the H-gate case, the same for the same decision: ${draws.map((d) => `${tuningOf(d).length}/${sessions(d)}`).join(" ")}`);
  const seen = new Set(draws.flatMap(tuningOf)).size;
  check(new Set(draws.map((d) => d.join())).size === draws.length && seen >= 48, `8 decisions' samples aren't all different or reach only ${seen} of the 64 tuning cases`);
}

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
  if (!plans[run]) throw new Error(`no plan for run ${run}`);
  // ratio: B's over A's on the times, render: on render (null: rows without render, as before the metric). Each arm has the
  // same spread of per-case noise, mirrored between them, so the ratio holds at the median and the tails alike, and the
  // per-case ratios vary around it (as measured ones do).
  const { win, ratio = 1, render = 1 } = plans[run];
  const rows = bench.map((x, i) => {
    const ja = 1 + 0.02 * ((i % 5) - 2), jb = 1 + 0.02 * (2 - (i % 5));
    const s = win(x, i);
    return { case: x.id, cluster: info.get(x.id).originSession, affected: true, class: "Q", s, sCraft: s, ttfc: [Math.round(1000 * ja), Math.round(1000 * ratio * jb)], ttd: [Math.round(3000 * ja), Math.round(3000 * ratio * jb)],
      ttfd: [Math.round(1000 * ja), Math.round(1000 * ratio * jb)], render: render === null ? [null, null] : [8 * ja, 8 * render * jb],
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
for (const k of [k0, k1, k2, k3, k4]) check(!invalid(k).length, `${k.id}'s row isn't a valid CheckpointRow: ${invalid(k).join(", ")}`);

// A0 is checkpoint 0's champion and never moves: every checkpoint runs against it, however well the champion does.
check(JSON.stringify(json(join(hist, "anchors.json"))) === JSON.stringify([{ id: "A0", sha: c[0] }]) && asked.every((a) => a.anchor === c[0]) && k1.share.all.share >= 0.7,
  `A0 moved, or a checkpoint ran against something else: ${JSON.stringify(json(join(hist, "anchors.json")))}, ${JSON.stringify(asked.map((a) => a.anchor.slice(0, 7)))}`);
// The champion surely slower than A0 in the same run goes to the owner list; faster doesn't.
const ownerList = () => readFileSync(join(hist, "owner-list.md"), "utf8");
check(/^latency veto: surely slower.*most on (ttfd|render)/.test(k1.latency.slower ?? "") && ownerList().includes("ck-01: the champion is surely slower than A0") && !k3.latency.slower && !ownerList().includes("ck-03:"),
  `ck-01 (1.10× A0) isn't surely slower on the owner list, or ck-03 (0.88×) is: ${k1.latency.slower}, ${k3.latency.slower}`);
check(Math.abs(k1.latency.ratioTtfd.est - 1.1) < 0.03 && Math.abs(k3.latency.ratioTtfd.est - 0.88) < 0.03 && k1.latency.ratioTtfd.p.slower < 0.05 && k3.latency.ratioTtfd.p.faster < 0.05,
  `the same-run ratios against A0: ck-01 ${JSON.stringify(k1.latency.ratioTtfd)}, ck-03 ${JSON.stringify(k3.latency.ratioTtfd)}`);
console.error(`t20: ck-01 share ${k1.share.all.share.toFixed(3)} first drawing ×${k1.latency.ratioTtfd.est.toFixed(3)} (${k1.latency.slower}); ck-03 ×${k3.latency.ratioTtfd.est.toFixed(3)}`);
// The overfitting gap above 0.15 at two checkpoints in a row → the owner list.
check(k3.overfitGap > 0.15 && k4.overfitGap > 0.15 && /overfitting.*ck-04/.test(ownerList()), `the overfitting gap (${k3.overfitGap.toFixed(2)}, ${k4.overfitGap.toFixed(2)}) twice didn't reach the owner list`);

// ---- A harness re-pin, a new served model and new judge code are markers or nothing: only a new judgeId or bench starts an era.
commits(1);
commitIn(repo, { "evals/README.md": "re-pinned\n" }, "harness 2");
git("-C", repo, "tag", "eval-harness-2");
served = "claude-x-2";
const k5 = await run("ck-05", c[5], { win: even(0.5) });
const marks5 = lines(join(hist, "markers.jsonl")).filter((x) => x.at === k5.at);
check(marks5.some((x) => x.kind === "harness" && x.ref === "eval-harness-2") && marks5.some((x) => x.kind === "served-model" && x.ref === "claude-x-2") && k5.era === 1,
  `a harness tag or served-model change did more than add a marker: markers ${JSON.stringify(marks5)}, era ${k5.era}`);
commits(1);
commitIn(repo, { "evals/judge/judge.ts": "// judge, changed\n" }, "harness 3: judge code");
git("-C", repo, "tag", "eval-harness-3");
const k6 = await run("ck-06", c[6], { win: even(0.5) });
check(k6.era === 1 && !lines(join(hist, "markers.jsonl")).some((x) => x.kind === "era" || x.kind === "anchor") && !existsSync(join(hist, "eras.json")), `judge code without a new judgeId started an era: ${k6.era}`);

// ---- An owner step: a checkpoint, an owner-step DecisionRow and a labelled marker.
commits(1);
const k7 = await run("ck-07", c[7], { win: even(0.5) }, { owner: { commits: 3, baseSha: c[6], candSha: c[7] } });
const owner = lines(join(hist, "decisions.jsonl")).find((d) => d.kind === "owner-step");
check(owner?.id === "owner-ck-07" && owner.checkpoint === "ck-07" && owner.class === "owner" && owner.goal === "owner" && owner.verdict === "owner" && owner.reasons[0] === "owner: 3 commits merged by rte sync" && owner.candSha === c[7] && owner.run === "ck-07" && ratioOk(owner.latency.ttfc) && ratioOk(owner.latency.ttfd),
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
const card = { id: "e1-h1", component: "draw", kind: "code", change: "draw prose opener", goal: "fidelity", classGuess: "Q", dialogue: false, isPatch: false, touchesFrozen: false, risk: "", files: ["src/app.ts"] };
const dRows = bench.filter(tuningOf).slice(0, 16).map((x, i) => ({ case: x.id, cluster: info.get(x.id).originSession, affected: true, class: "Q", s: -1, ttfc: [1000, 1010], ttd: [3000, 3030], ttfd: [1000, 1010], render: [8, 8], work: [1, 1], usd: [0.03, 0.03], thought: [false, false], overuse: [false, false], pics: [[0, 0], [0, 0]], ask: info.get(x.id).ask, firstArm: i % 2 ? "B" : "A" }));
write(join(p.run("e1-h1-g2"), "rows.jsonl"), dRows.map((x) => JSON.stringify(x)).join("\n") + "\n");
write(join(p.run("e1-h1-g2"), "run.json"), { id: "e1-h1-g2", kind: "ab", meter: { calls: 40, listUsd: 1.5, minutes: 9 } });
const decision = decide({ tuning: dRows, exhausted: true, flips: { audited: 0, flipped: 0 }, cold: [0, 0], invariants: 0 }, card);
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
check(["bench freeze: B1", ...["00", "01", "02", "03", "04", "05", "06", "07"].map((n) => `ck-${n}: share`), "ck-01: share 0.80 against A0, surely slower", "e1-h1: revert", "adopt what was written"].every((s) => log.includes(s)) && Number(git("-C", hist, "rev-list", "--count", "HEAD")) >= 12,
  `eval/history's log is missing a record:\n${log}`);
check(JSON.parse(git("-C", repo, "show", "eval/history:anchors.json")).length === 1 && git("-C", repo, "show", "eval/history:checkpoints.jsonl").split("\n").length === 8, "the committed anchors or checkpoints differ from the worktree's");
finish();
