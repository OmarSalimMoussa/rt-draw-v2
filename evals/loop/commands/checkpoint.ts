// rte checkpoint, calib, packets and sync: the yardstick's runs (§5.2), the judge's calibration (§4.5) and the owner's
// own commits taken into the champion as an owner step (§8.6).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { View } from "../../../src/core/board.ts";
import { changeFrame, hidden } from "../../core/diff.ts";
import { assemble, assembleIllustrations, checkCalibration, checkIllustrations, topUpContrast } from "../../judge/calibrate.ts";
import { combined, judging } from "../../judge/judge.ts";
import { caseFile, framed, readPacket } from "../../judge/packet.ts";
import type { Label, PairRef } from "../../pages/plugin.ts";
import { writeMissDigest } from "../../optimizer/digest.ts";
import { bankedScenes, sceneRoundTrip, typecheck } from "../../optimizer/gates.ts";
import { benchCases, runAB } from "../ab.ts";
import { type StoredCheckpoint, checkpoint, checkpointTrees } from "../checkpoint.ts";
import { capture } from "../chrome.ts";
import { LOOP } from "../config.ts";
import { loadPage } from "../drive.ts";
import { commitHistory, historyAdd, historyRows, openHistory, ownerItem } from "../history.ts";
import { paths } from "../paths.ts";
import { caseDir, put, putImage, runFile, voidCase } from "../record.ts";
import { type State, newState, readState, saveState } from "../state.ts";
import { LockfileDiffers, contentHash, treeOf, worktreeOf } from "../trees.ts";
import type { Arm, Judged, Ratio, RecordedReply, SceneJSON } from "../types.ts";
import { CO_AUTHOR, IDENT, type Rte, banked, championArm, championSha, git, isAncestor, js, maybe, needBank, nextEpoch, ordered, tryGit, upstream } from "../rte.ts";

/** A checkpoint of today's champion (an owner step for `sync`), then the champion-miss digest from its losses. */
export async function runCheckpoint(rte: Rte, gw: string, epoch: number, owner?: { commits: number; baseSha: string; candSha: string }, champ = championArm()): Promise<StoredCheckpoint> {
  const ck = await rte.withRig(gw, checkpointTrees(champ), (rig) => checkpoint({ rig, epoch, champion: champ, owner }));
  writeMissDigest(champ.sha, { run: ck.run, champion: "B" });
  const x = (r?: Ratio) => (r ? `×${r.est.toFixed(2)}` : "-");
  rte.say(`${ck.id}: champion share ${ck.share.all?.share.toFixed(2)} [${ck.share.all?.lo90.toFixed(2)}, ${ck.share.all?.hi90.toFixed(2)}] against ${ck.anchor}, first drawing ${x(ck.latency.ratioTtfd)}, render ${x(ck.latency.ratioRender)}, trust ${ck.trust}${ck.latency.slower ? `; SURELY SLOWER than A0: ${ck.latency.slower}` : ""}${ck.aa ? `; A/A ${ck.aa.pass ? "passes" : "FAILS"}: ${Object.entries(ck.aa.tests).map(([k, t]) => `${k} ${t.est.toFixed(2)} ±${t.halfWidth.toFixed(2)}`).join(", ")}` : ""}`);
  return ck;
}
export async function checkpointCmd(rte: Rte) {
  rte.needCap(rte.o.f.zero ? "checkpoint --zero" : "checkpoint");
  needBank();
  openHistory();
  const zero = !historyRows("checkpoints.jsonl").length;
  if (rte.o.f.zero && !zero) throw new Error("checkpoint 0 exists already");
  if (!rte.o.f.zero && zero) throw new Error("no checkpoint 0 yet: checkpoint --zero --cap 750 first");
  const ck = await rte.withGateway((gw) => runCheckpoint(rte, gw, readState()?.epoch ?? 0));
  return ck.aa && !ck.aa.pass ? 1 : 0;
}

/** A rehearsal's labels, only on the fake API: the judge's own verdicts as the owner's, so `calib --check` runs end to end. */
function fakeLabels(rte: Rte) {
  if (!rte.o.mockApi) throw new Error("calib --fake-labels is for a dry run on the fake API: pass --mock-api");
  const at = new Date().toISOString();
  const pairs = JSON.parse(readFileSync(join(dirname(paths().labels), "pairs.json"), "utf8")) as PairRef[];
  const lines = pairs.flatMap((p, i): Label[] => {
    const dir = join(caseDir(p.run, p.case), "judge");
    const [a, b] = (p.question === "craft" ? ["craft.json"] : ["fidelity-1.json", "fidelity-2.json"]).map((f) => maybe<Judged>(join(dir, f)));
    if (!a) return [];
    const label = combined(a, b);
    const pos = readPacket(p.run, p.case).positions;
    const left = p.swap ? pos.right : pos.left;
    return [{ id: `fake-${i}`, pair: p.id, packet: `runs/${p.run}/cases/${p.case}/judge/packet.json`, subset: p.subset, question: p.question, side: label === "tie" ? "tie" : label === left ? "left" : "right", label, strength: label === "tie" ? null : "clear", ms: 0, at }];
  });
  appendFileSync(paths().labels, lines.map((l) => `${js(l)}\n`).join(""));
  rte.say(`calib: ${lines.length} fake labels (the judge's own verdicts) in ${paths().labels}; next: rte calib --check`);
}

/** §4.5: the contrast run and the label pairs, or the labels against the judge. */
/**
 * Packet version 2 for runs judged before it, from their saved scenes (0 calls): both arms framed on what changed when a
 * result's screen left it, added to the packet; those cases' fidelity and craft verdicts move to judge/blind/, so calibration and
 * any reader judge them again with the framed images. Rerunnable: a case that no longer needs a frame gets its verdicts back.
 */
export async function packetsCmd(rte: Rte) {
  const runs = rte.o.pos.slice(1);
  if (!runs.length) throw new Error("packets <run>…");
  for (const run of runs) {
    const info = maybe<{ arms: Record<Arm, { tree: string }> }>(runFile(run, "run.json"));
    if (!info) throw new Error(`no run ${run}`);
    const trees = [info.arms.A.tree, info.arms.B.tree];
    let cases = 0, done = 0;
    await rte.withGateway((gw) => rte.withRig(gw, trees, async (rig) => {
      for (const c of readdirSync(runFile(run, "cases")).sort()) {
        const dir = caseDir(run, c);
        if (!existsSync(join(dir, "judge", "packet.json")) || !existsSync(join(dir, "fork.json"))) continue;
        cases++;
        const after = { A: maybe<SceneJSON>(join(dir, "A", "after.scene.json"))!, B: maybe<SceneJSON>(join(dir, "B", "after.scene.json"))! };
        const { cameras } = maybe<{ cameras: Record<Arm, View> }>(join(dir, "fork.json"))!;
        const before = maybe<SceneJSON>(caseFile(c, "before.scene.json", run))!;
        const frame = changeFrame(before, [after.A, after.B], cameras.A.w / cameras.A.h);
        const need = !!frame && (["A", "B"] as Arm[]).some((a) => hidden(before, after[a], cameras[a]));
        for (const a of ["A", "B"] as Arm[]) {
          if (!need) {
            rmSync(join(dir, a, "changed.jpg"), { force: true });
            continue;
          }
          const { page } = await rig.tab(0, a, trees[a === "A" ? 0 : 1]);
          await loadPage(page, run, c, after[a], cameras[a]);
          putImage(join(dir, a, "changed.jpg"), await capture(page, { view: frame!, width: LOOP.judgePx, quality: LOOP.judgeQuality }));
        }
        const p = readPacket(run, c);
        const { leftChanged: _l, rightChanged: _r, ...images } = p.images;
        put(join(dir, "judge", "packet.json"), { ...p, images: { ...images, ...framed(run, c, p.positions) } });
        // Verdicts judged without the frame go aside while the packet has one, and come back when it doesn't.
        for (const sub of ["", "v1", "v2"])
          for (const f of ["fidelity-1.json", "fidelity-2.json", "craft.json"]) {
            const [live, blind] = [join(dir, "judge", sub, f), join(dir, "judge", "blind", sub, f)];
            if (need && existsSync(live)) mkdirSync(dirname(blind), { recursive: true }), renameSync(live, blind);
            if (!need && existsSync(blind) && !existsSync(live)) mkdirSync(dirname(live), { recursive: true }), renameSync(blind, live);
          }
        if (need) done++;
      }
    }, 1), true);
    rte.say(`packets: ${run}: ${done} of ${cases} cases framed on what changed (their fidelity and craft verdicts moved to judge/blind/), 0 calls`);
  }
}

/**
 * `rte calib --illustrations --contrast picture.model=0 --cap n`: the champion's pictures against another picture model's,
 * on banked cases whose pictures were drawn, the drawing call shared so only the pictures differ; the round's pairs go to
 * labels/illustrations/. `--check --illustrations`: the owner's labels there against the judge (0 calls), use.illustrations.
 */
async function illustrations(rte: Rte) {
  if (rte.o.f.check) {
    const r = await rte.withGateway(() => checkIllustrations(), rte.o.cap === undefined);
    historyAdd("health.jsonl", r.health);
    commitHistory(`calibration: illustrations ${r.outcome}`);
    rte.say(`calib: illustrations ${r.outcome}; fidelity ${r.fidelity.clear.score} of ${r.fidelity.clear.n} clear, craft ${r.craft.score} of ${r.craft.n}${r.outcome === "more" ? "; label more at /evals/label/?set=illustrations (or rerun the round with --cases n)" : ""}`);
    return r.outcome === "pass" ? 0 : 1;
  }
  const [knob, value] = (rte.str("contrast") ?? "").split("=");
  if (!knob?.startsWith("picture.") || value === undefined) throw new Error("calib --illustrations --contrast picture.<knob>=<value> --cap n | calib --check --illustrations");
  rte.needCap("calib --illustrations");
  needBank();
  const champ = championArm();
  const run = "calib-illustrations";
  const drew = (id: string) => {
    const f = join(paths().bankCase(id), "replies.json");
    return existsSync(f) && (JSON.parse(readFileSync(f, "utf8")) as RecordedReply[]).some((r) => r.role === "picture");
  };
  const ids = ordered(banked(["tuning", "fresh"]).filter(drew), run).slice(0, rte.num("cases") ?? LOOP.calib.illustrations.cases);
  await rte.withGateway((gw) => rte.withRig(gw, [champ.tree], async (rig) => {
    await runAB(rig, { run, kind: "calib", arms: { A: champ, B: { ...champ, tuning: { [knob]: Number(value) } } }, mode: "live", share: true, seed: run, judge: judging(run, { seed: run, craft: "none" }), cases: ids });
    const pairs = await assembleIllustrations({ contrast: run, seed: run });
    const I = LOOP.calib.illustrations;
    rte.say(`calib: ${pairs.length} pairs from ${ids.length} cases in labels/illustrations/pairs.json: label them at /evals/label/?set=illustrations (${I.clear} clear fidelity, ${I.craftPairs} craft), then rte calib --check --illustrations`);
  }));
}

export async function calib(rte: Rte) {
  openHistory();
  if (rte.o.f["fake-labels"]) return fakeLabels(rte);
  if (rte.o.f.illustrations) return illustrations(rte);
  if (rte.o.f.check) {
    const variant = rte.num("variant") === 2 ? 2 : 1;
    if (variant === 2) rte.needCap("calib --check --variant 2");
    // Variant 1 reads the runs' own verdicts (0 calls), except those set aside for framed images (judge/blind/): with --cap it judges them again.
    const r = await rte.withGateway(() => checkCalibration(variant), variant === 1 && rte.o.cap === undefined);
    historyAdd("health.jsonl", r.health);
    commitHistory(`calibration: ${r.outcome} (variant ${variant})`);
    rte.say(`calib: ${r.outcome}; fidelity ${r.fidelity.clear.score} of ${r.fidelity.clear.n} clear, craft ${r.craft.score} of ${r.craft.n}${r.outcome === "variant-2" ? "; next: calib --check --variant 2 --cap 150" : ""}`);
    return r.outcome === "pass" || r.outcome === "pass-no-craft" ? 0 : 1;
  }
  const [knob, value] = (rte.str("contrast") ?? "").split("=");
  if (!knob || value === undefined) throw new Error("calib --contrast <knob=value> --cap n | calib --check [--variant 2]");
  rte.needCap("calib --contrast");
  needBank();
  const ck0 = (historyRows("checkpoints.jsonl") as StoredCheckpoint[])[0];
  if (!ck0) throw new Error("no checkpoint 0 yet: its A/A pairs are most of the label set");
  const champ = championArm();
  const run = "calib-contrast";
  // --more n (calib --check said "more"): n further cases into the same run, their pairs appended to the label set.
  const more = rte.num("more") ?? 0;
  const ids = ordered(banked(["tuning", "fresh"]), run).slice(0, LOOP.calib.contrast + more);
  await rte.withGateway((gw) => rte.withRig(gw, [champ.tree], async (rig) => {
    await runAB(rig, { run, kind: "calib", arms: { A: champ, B: { ...champ, tuning: { [knob]: Number(value) } } }, mode: "live", share: true, seed: run, judge: judging(run, { seed: run, craft: "none" }), cases: ids });
    if (more) return void rte.say(`calib: ${topUpContrast(run).length} more fidelity pairs appended to labels/pairs.json: label them at /evals/label/, then rte calib --check --cap n`);
    const page = (await rig.tab(0, "A", champ.tree)).page;
    // One page: assemble() asks for its probes' captures at once, and two loads racing on one page never finished.
    let busy: Promise<unknown> = Promise.resolve();
    const shot = (scene: SceneJSON, camera: View) => {
      const r = busy.then(async () => (await loadPage(page, run, "calib-shot", scene, camera), capture(page, { width: LOOP.judgePx, quality: LOOP.judgeQuality })));
      busy = r.catch(() => {});
      return r;
    };
    const pairs = await assemble({ aa: ck0.run, contrast: run, seed: run, capture: shot });
    rte.say(`calib: ${pairs.length} pairs in labels/pairs.json: label them at /evals/label/ (60 clear fidelity, 30 craft), then rte calib --check`);
  }));
}

// ---- The owner's own commits: sync (§8.6)

/** Merges the owner's master into the champion as an owner step: G0's build checks, the bank's scene round trip, a checkpoint. */
export async function sync(rte: Rte, gw: string, st: State): Promise<"merged" | "nothing" | "paused"> {
  const p = paths();
  openHistory();
  git(p.repo, "fetch", "-q", "origin", upstream());
  const master = git(p.repo, "rev-parse", "FETCH_HEAD");
  const base = championSha();
  if (isAncestor(master, base)) {
    // The owner undid what conflicted: nothing to merge, nothing blocks.
    if (st.blocked?.startsWith("sync:")) (st.blocked = undefined), saveState(st);
    return "nothing";
  }
  const block = (why: string) => {
    ownerItem(`sync: ${why}`);
    commitHistory(`sync paused: ${why.slice(0, 80)}`);
    st.blocked = `sync: ${why}`;
    saveState(st);
    rte.say(`sync: PAUSED: ${why}`);
    return "paused" as const;
  };
  const wt = worktreeOf(`sync/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (tryGit(wt, ...IDENT, "merge", "-q", "--no-edit", "-m", "Merge the owner's master into the champion (rte sync)", "-m", CO_AUTHOR, master) === undefined) {
    const files = (tryGit(wt, "diff", "--name-only", "--diff-filter=U") ?? "").split("\n").join(", ");
    tryGit(wt, "merge", "--abort");
    return block(`master ${master.slice(0, 12)} conflicts with the champion in ${files || "?"}: resolve it on master, then rte sync`);
  }
  const merged = git(wt, "rev-parse", "HEAD");
  // Commits that change no product file (evals/, docs, the bake's pictures.json) leave every arm's tree as it was:
  // the champion takes them without a checkpoint, which would measure the same product again (~600 calls).
  if (contentHash(merged) === contentHash(base)) {
    git(p.repo, "branch", "-f", "loop/champion", merged);
    if (st.blocked?.startsWith("sync:")) (st.blocked = undefined), saveState(st);
    rte.say(`sync: master ${master.slice(0, 12)} changes no product file: the champion takes it without a checkpoint`);
    return "merged";
  }
  // G0's build checks only: the path, UX and lint gates bind the loop's own candidates, not the owner.
  let tree: string;
  try {
    tree = treeOf(merged);
  } catch (err) {
    if (err instanceof LockfileDiffers) return block(err.message);
    throw err;
  }
  const broken = typecheck(tree);
  if (broken.length) return block(`${broken.map((f) => f.why).join("; ")} (update evals/ on master, then rte init --refresh)`);
  // V8 on every banked and yardstick before-scene through the merged Scene.fromJSON: a banked case that fails is
  // refused; a yardstick case that fails is the owner's (B1 refrozen, a new era) before the champion can take it.
  const scenes = bankedScenes().filter((f) => !f.includes(".void"));
  const rt = sceneRoundTrip(tree, [...scenes, ...benchCases().map((c) => join(c.dir, "before.scene.json"))]);
  const failed = rt.failed.filter((f) => f.startsWith(`${p.bankCases}/`) || f.startsWith(`${p.realBank}/`));
  const other = rt.failed.find((f) => !failed.includes(f));
  if (other) return block(`master's Scene.fromJSON refuses ${other}: refreeze the yardstick (bench freeze, a new era) first`);
  const commits = Number(git(p.repo, "rev-list", "--count", `${base}..${master}`));
  const ck = await runCheckpoint(rte, gw, st.epoch, { commits, baseSha: base, candSha: merged }, { sha: merged, tree });
  git(p.repo, "branch", "-f", "loop/champion", merged);
  for (const f of failed) voidCase(dirname(f.slice(0, f.indexOf(": "))), `V8 after rte sync to ${master.slice(0, 12)}: ${f}`);
  if (failed.length > LOOP.sync.sceneFailMax * scenes.length) {
    ownerItem(`sync: a scene-format change in ${master.slice(0, 12)}: ${failed.length} of ${scenes.length} banked before-scenes don't round-trip; they're refused and a bank refresh is queued`);
    st.refreshQueued = `scene format (${master.slice(0, 12)})`;
    commitHistory("owner list: a scene-format change, bank refresh queued");
  }
  Object.assign(st, { blocked: undefined, lastOwnerStep: new Date().toISOString(), keepsSinceCheckpoint: 0, paused: [] });
  saveState(st);
  rte.say(`sync: ${commits} owner commits merged into the champion as an owner step (${ck.id})${failed.length ? `; ${failed.length} banked cases refused (V8)` : ""}`);
  return "merged";
}
export async function syncCmd(rte: Rte) {
  rte.needCap("sync");
  const st = readState() ?? newState(nextEpoch());
  const r = await rte.withGateway((gw) => sync(rte, gw, st));
  if (r === "nothing") rte.say("sync: master has nothing new for the champion");
  return r === "paused" ? 1 : 0;
}
