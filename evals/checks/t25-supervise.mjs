// T25's acceptance check: the loop runs without anyone watching it. loop.lock names its holder, nests in its own process,
// is taken over from a dead holder (a resume only when that holder was a loop), and makes the loop wait out a live
// intake or readiness check instead of failing; the budget pauses on the week instead of stopping, until the week is
// read again; `rte wanted` keeps an owner's stop across a reboot and lets a crash restart; `rte unit-failed` records
// the unit giving up. Then evals/ops/units.sh's units run for real under systemd with a fake rte: a crash loop restarts
// three times (four starts) and then runs the failure unit once, and a stop the owner made keeps the loop's unit from running; intake's
// unit pulls first, and pull.sh keeps each pull as a snapshot. Last, a deploy (evals/ops/pgx-deploy.sh) on those units
// waits for the loop to be down before it re-pins the harness, and starts it again.
// 0 model calls: no gateway, no tokens; the units are this check's own (prefix rtcheck<pid>), removed after.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t25-supervise.mjs
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { ROOT, check, cleanEnv, finish, tempHome } from "./lib.mjs";

const home = tempHome();
// The loop's clone, for the history worktree rte unit-failed writes the owner list in.
execFileSync("git", ["init", "-q", "-b", "master", join(home, "repo")]);
execFileSync("git", ["-C", join(home, "repo"), "-c", "user.name=t25", "-c", "user.email=t25@localhost", "commit", "-q", "--allow-empty", "-m", "t25"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { lock, holder, rules, readState, saveState, newState } = await import("../loop/state.ts");
const { Slots } = await import("../loop/tokens.ts");
const { LOOP, WEEK_CHECK } = await import("../loop/config.ts");
const { paths } = await import("../loop/paths.ts");
const p = paths();
const putLock = (h) => writeFileSync(p.lock, JSON.stringify({ host: hostname(), start: new Date().toISOString(), ...h }));
const dead = () => {
  const c = spawnSync("true");
  return c.pid; // exited: no process has this pid now (pids aren't reused this fast)
};

// ---- loop.lock
{
  const a = await lock("loop");
  check(holder()?.cmd === "loop" && holder()?.pid === process.pid && holder()?.live, `the lock doesn't name its holder: ${JSON.stringify(holder())}`);
  const b = await lock("intake"); // the loop's own intake, inside it
  b.release();
  check(existsSync(p.lock), "a nested release freed the lock its outer holder still has");
  a.release();
  check(!existsSync(p.lock), "the lock outlived its holder's release");

  putLock({ pid: dead(), cmd: "ready" });
  const c = await lock("loop");
  check(!c.stale && holder()?.cmd === "loop", "a dead readiness check's lock read as a crashed loop (a resume)");
  c.release();
  putLock({ pid: dead(), cmd: "loop" });
  const d = await lock("loop");
  check(d.stale, "a dead loop's lock wasn't stale: the next loop wouldn't resume");
  d.release();

  const child = spawn("sleep", ["30"]);
  putLock({ pid: child.pid, cmd: "intake" });
  let refused = "";
  await lock("ready").catch((e) => (refused = e.message));
  check(/held by intake/.test(refused), `a second command took a live holder's lock: ${refused || "taken"}`);
  // The same pid, but not the process that took the lock (its start differs): a pid reused after a crash or a reboot.
  putLock({ pid: child.pid, since: "1", cmd: "loop" });
  const reused = await lock("loop");
  check(reused.stale && holder()?.pid === process.pid, "a lock whose pid another process now has wasn't taken over");
  reused.release();
  // A lock that isn't JSON (lock() never writes one): held while fresh, taken over once a minute old.
  writeFileSync(p.lock, "{");
  refused = "";
  await lock("ready").catch((e) => (refused = e.message));
  check(/held by an unreadable lock/.test(refused), `a fresh unreadable lock was taken: ${refused || "taken"}`);
  utimesSync(p.lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const old = await lock("ready");
  check(!old.stale && holder()?.cmd === "ready", "an old unreadable lock wasn't taken over");
  old.release();
  putLock({ pid: child.pid, cmd: "intake" });
  const said = [];
  const t0 = Date.now();
  setTimeout(() => child.kill(), 2000);
  const e = await lock("loop", { wait: true, say: (l) => said.push(l) });
  check(Date.now() - t0 >= 2000 && /waiting: .* held by intake/.test(said.join()) && !e.stale, `the loop didn't wait out a live intake: ${said.join("; ")}, ${Date.now() - t0} ms`);
  e.release();
  const loopChild = spawn("sleep", ["30"]);
  putLock({ pid: loopChild.pid, cmd: "loop" });
  refused = "";
  await lock("loop", { wait: true }).catch((err) => (refused = err.message));
  check(/held by loop/.test(refused), "a second loop waited for the first instead of refusing");
  loopChild.kill();
  rmSync(p.lock);
  check(!readdirSync(home).some((f) => f.startsWith("loop.lock.")), `a lock attempt left its file beside the lock: ${readdirSync(home).join(", ")}`);
}

// ---- The budget: a week spent is a pause until the week is read again, never a stop
{
  const T = Date.parse("2026-10-28T12:00:00Z");
  const file = join(home, "slots.json");
  const at = T - 3600_000;
  writeFileSync(file, JSON.stringify([1, 2].map((slot) => ({ slot, sevenDay: LOOP.weekSevenDayMax + 0.01, sevenDayAt: at, usdWindow: 0, limited: false, hours: {} }))));
  const week = new Slots([1, 2], file, () => T).pace();
  check(!week.ok && week.week && week.pauseUntil === at + WEEK_CHECK.afterH * 3600_000, `every token past its week: ${JSON.stringify(week)} (want a pause to ${new Date(at + WEEK_CHECK.afterH * 3600_000).toISOString()})`);
  const resets = (T + 1800_000) / 1000;
  writeFileSync(file, JSON.stringify([{ slot: 1, sevenDay: 0.9, sevenDayAt: at, usdWindow: 0, limited: false, hours: {} }, { slot: 2, fiveHour: 0.95, resetsAt: resets, sevenDay: 0.2, usdWindow: 0, limited: false, hours: {} }]));
  const mixed = new Slots([1, 2], file, () => T).pace();
  check(!mixed.ok && !mixed.week && mixed.pauseUntil === resets * 1000, `one token on its week, one on five hours: ${JSON.stringify(mixed)} (want the five-hour reset, not a week)`);
  const base = { now: T, pace: week, recent: [], ready: true, calib: "pass", overloads: [], diskGb: 500, onAC: true };
  const acts = rules(base);
  check(acts.length === 1 && acts[0].do === "pause" && acts[0].until === week.pauseUntil && /week/.test(acts[0].why), `the rules on a spent week: ${JSON.stringify(acts)}`);
  check(rules({ ...base, pace: { ok: true }, capped: true, error: "a reply quoting a tester" }).every((a) => a.do !== "stop" || (a.code === "cap" && !a.why.includes("tester"))), "a stop carries an error's text");
}

// ---- rte wanted, rte unit-failed
const rte = (...a) => spawnSync(process.execPath, ["--import", join(ROOT, "evals/loop/node-hooks.mjs"), join(ROOT, "evals/loop/run.ts"), ...a], { cwd: ROOT, env: cleanEnv({ RT_EVAL_HOME: home, RT_NOTIFY_ENV: join(home, "no-notify.env") }), encoding: "utf8" });
{
  const st = newState(7);
  saveState({ ...st, until: 9, emptyEpochs: 1, run: { status: "stopped", code: "asked", at: new Date().toISOString(), why: "stopped as asked" } });
  check(rte("wanted").status === 1, "rte wanted said yes after the owner's stop: a reboot would undo it");
  for (const code of ["crashed"]) {
    saveState({ ...readState(), run: { status: "stopped", code, at: new Date().toISOString() } });
    check(rte("wanted").status === 0, `rte wanted said no after a ${code} stop: the unit couldn't restart it`);
  }
  for (const code of ["voids", "gave-up"]) {
    saveState({ ...readState(), run: { status: "stopped", code, at: new Date().toISOString() } });
    check(rte("wanted").status === 1, `rte wanted said yes after a ${code} stop, the owner's to judge: a reboot would start it`);
  }
  check(rte("wanted", "--set").status === 0, "rte wanted --set failed");
  const now = readState();
  check(rte("wanted").status === 0 && now.run.status === "running" && now.until === undefined && now.emptyEpochs === 0, `rte wanted --set left ${JSON.stringify({ run: now.run, until: now.until, emptyEpochs: now.emptyEpochs })}`);
  const f = rte("unit-failed");
  const owner = existsSync(join(home, "history/owner-list.md")) ? readFileSync(join(home, "history/owner-list.md"), "utf8") : "";
  check(f.status === 0 && readState().run.code === "gave-up" && rte("wanted").status === 1 && /unit failed past its restarts/.test(owner) && /not mailed: no /.test(f.stdout), `rte unit-failed: exit ${f.status}, run ${JSON.stringify(readState().run)}, ${f.stdout.trim().slice(-200)}`);
}

// ---- pull.sh receive: each pull a snapshot under real/raw/<source>/ that only this user reads, the newest named in
// latest; a pull the same as the last is dropped.
{
  const src = join(home, "pull-src");
  mkdirSync(join(src, "app"), { recursive: true });
  writeFileSync(join(src, "app", "a.json"), "{}");
  const receive = () => spawnSync("bash", [join(ROOT, "evals/real/pull.sh"), "receive", "live"], { input: execFileSync("tar", ["-C", src, "-cf", "-", "app"]), env: cleanEnv({ RT_EVAL_HOME: home }), encoding: "utf8" });
  const raw = join(home, "real", "raw", "live");
  const snaps = () => readdirSync(raw).filter((d) => /^\d{8}T\d{6}Z$/.test(d)).sort();
  const latest = () => readFileSync(join(raw, "latest"), "utf8").trim();
  const r1 = receive();
  check(r1.status === 0 && snaps().length === 1 && latest() === snaps()[0] && existsSync(join(raw, latest(), "app", "a.json")) && existsSync(join(raw, "pulled")) && (statSync(join(home, "real")).mode & 0o077) === 0,
    `the first pull: exit ${r1.status}, ${snaps().join(", ")} (${r1.stderr.trim()})`);
  const r2 = receive();
  check(r2.status === 0 && /the same as/.test(r2.stdout) && snaps().length === 1, `a pull the same as the last was kept: ${snaps().join(", ")}`);
  await sleep(1100);
  writeFileSync(join(src, "app", "a.json"), '{"n":2}');
  const r3 = receive();
  check(r3.status === 0 && snaps().length === 2 && latest() === snaps()[1] && readFileSync(join(raw, latest(), "app", "a.json"), "utf8") === '{"n":2}', `a new pull isn't the latest: ${snaps().join(", ")}`);
  rmSync(join(home, "real"), { recursive: true, force: true });
}

// ---- pull.sh local, through a fake ssh that runs the PGX's side here with a home of its own: the dev server's data
// becomes a local snapshot there, and the owner's recorded sends go with it, new ones only (what the PGX wrote stays).
{
  const laptop = join(home, "laptop"), pgx = join(home, "pgx-home"), bin = join(home, "fake-bin");
  mkdirSync(join(laptop, "data", "app"), { recursive: true });
  writeFileSync(join(laptop, "data", "app", "a.json"), "{}");
  mkdirSync(join(laptop, "eval", "human"), { recursive: true });
  writeFileSync(join(laptop, "eval", "human", "h-1.json"), '{"input":"as recorded"}');
  writeFileSync(join(laptop, "eval", "human", "h-2.json"), '{"input":"new"}');
  mkdirSync(join(pgx, "human"), { recursive: true });
  writeFileSync(join(pgx, "human", "h-1.json"), '{"input":"as recorded","meant":"written on the PGX"}');
  mkdirSync(join(pgx, "repo", "evals", "real"), { recursive: true });
  symlinkSync(join(ROOT, "evals/real/pull.sh"), join(pgx, "repo", "evals", "real", "pull.sh"));
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nfor last; do :; done\nRT_EVAL_HOME="${pgx}" exec bash -c "$last"\n`, { mode: 0o755 });
  writeFileSync(join(home, "hosts.env"), "RT_PGX=fake-pgx\n");
  const r = spawnSync("bash", [join(ROOT, "evals/real/pull.sh"), "local"], { env: cleanEnv({ RT_EVAL_HOME: join(laptop, "eval"), RT_LOCAL_DATA: join(laptop, "data"), RT_HOSTS: join(home, "hosts.env"), PATH: `${bin}:${process.env.PATH}` }), encoding: "utf8" });
  const raw = join(pgx, "real", "raw", "local");
  const latest = existsSync(join(raw, "latest")) ? readFileSync(join(raw, "latest"), "utf8").trim() : "none";
  check(r.status === 0 && existsSync(join(raw, latest, "app", "a.json")) && /written on the PGX/.test(readFileSync(join(pgx, "human", "h-1.json"), "utf8")) && existsSync(join(pgx, "human", "h-2.json")),
    `pull.sh local: exit ${r.status}, snapshot ${latest}, human ${readdirSync(join(pgx, "human")).join(", ")} (${r.stderr.trim().slice(-300)})`);
}

// ---- The units under systemd, with a fake rte
if (spawnSync("systemctl", ["--user", "show-environment"]).status !== 0) console.log("note: no systemd user manager here: the units aren't run");
else {
  const prefix = `rtcheck${process.pid}`;
  const dir = join(homedir(), ".config/systemd/user");
  const fake = join(home, "fake-rte");
  const log = join(home, "fake-rte.log");
  // What the fake loop does is in loop.mode: crash (exit 1), stop (exit 0, the owner's), or work (until stop-after asks,
  // as a card finishing).
  writeFileSync(fake, `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  wanted) [ -e "${home}/not-wanted" ] && exit 1; exit 0 ;;
  stop-after) touch "${home}/stop-asked"; exit 0 ;;
  loop)
    case "$(cat "${home}/loop.mode")" in
      crash) exit 1 ;;
      work) until [ -e "${home}/stop-asked" ]; do sleep 0.2; done; sleep 1; echo "loop done" >> "${log}" ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  const sc = (...a) => spawnSync("systemctl", ["--user", ...a], { encoding: "utf8" });
  const unit = (n) => `${prefix}-${n}`;
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const until = async (f, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (f()) return true;
    return false;
  };
  try {
    const out = execFileSync("bash", [join(ROOT, "evals/ops/units.sh")], { cwd: ROOT, env: cleanEnv({ RT_EVAL_HOME: home, RT_UNIT_PREFIX: prefix, RT_RTE: fake, RT_RESTART_SEC: "1", RT_PAGES_HOST: "127.0.0.1" }), encoding: "utf8" });
    check(/installed/.test(out) && ["loop", "loop-failed", "intake", "pages"].every((n) => existsSync(join(dir, `${unit(n)}.service`))) && existsSync(join(dir, `${unit("intake")}.timer`)), `units.sh didn't install every unit: ${out.trim()}`);
    check(sc("is-enabled", `${unit("loop")}.service`).stdout.trim() === "enabled", "the loop's unit isn't enabled: a reboot wouldn't start it");
    const env = readFileSync(join(home, `${prefix}-units.env`), "utf8");
    check(env.includes(`RT_EVAL_HOME=${home}`) && env.includes(`RT_UNIT_PREFIX=${prefix}`) && /PATH=.*\//.test(env), `the units' env file: ${env}`);
    // Intake pulls the hosted app's data first; a pull that fails (the box down) doesn't keep intake from the last snapshot.
    const intakeUnit = readFileSync(join(dir, `${unit("intake")}.service`), "utf8");
    check(intakeUnit.includes(`ExecStartPre=-/bin/bash ${join(ROOT, "evals/real/pull.sh")} live\n`) && intakeUnit.includes(`ExecStart=${fake} intake\n`), `the intake unit: ${intakeUnit}`);

    // A crash loop: the first start and three restarts, each after readiness, then the failure unit once.
    writeFileSync(join(home, "loop.mode"), "crash");
    sc("start", "--no-block", `${unit("loop")}.service`);
    const gaveUp = await until(() => calls().includes("unit-failed"), 30_000);
    const c = calls();
    check(gaveUp && c.filter((l) => l === "loop --resume").length === 4 && c.filter((l) => l === "ready --stub --mock-api").length === 4 && c.filter((l) => l === "unit-failed").length === 1,
      `the crash loop: ${c.join(" | ")}`);
    check(sc("is-failed", `${unit("loop")}.service`).stdout.trim() === "failed", `after its restarts the unit is ${sc("is-active", `${unit("loop")}.service`).stdout.trim()}`);

    // The owner's stop: the unit's condition keeps it from running, without a failure.
    sc("reset-failed", `${unit("loop")}.service`);
    rmSync(log);
    writeFileSync(join(home, "not-wanted"), "");
    sc("start", `${unit("loop")}.service`);
    await sleep(1500);
    check(calls().join() === "wanted" && sc("is-failed", `${unit("loop")}.service`).stdout.trim() !== "failed", `a stop the owner made didn't hold the unit: ${calls().join(" | ")}`);

    // Wanted again, a clean exit (the owner's stop-after): no restart.
    rmSync(join(home, "not-wanted"));
    rmSync(log);
    writeFileSync(join(home, "loop.mode"), "stop");
    sc("start", `${unit("loop")}.service`);
    await until(() => sc("is-active", `${unit("loop")}.service`).stdout.trim() === "inactive" && calls().includes("loop --resume"), 10_000);
    await sleep(2500);
    check(calls().filter((l) => l === "loop --resume").length === 1 && !calls().includes("unit-failed"), `a clean exit was restarted: ${calls().join(" | ")}`);

    // A deploy while the loop works: its card finishes before the harness is re-pinned, then the loop starts again.
    // The loop's clone is this check's home/repo, its units.sh this checkout's.
    mkdirSync(join(home, "repo", "evals", "ops"), { recursive: true });
    symlinkSync(join(ROOT, "evals/ops/units.sh"), join(home, "repo", "evals", "ops", "units.sh"));
    rmSync(log);
    writeFileSync(join(home, "loop.mode"), "work");
    sc("start", "--no-block", `${unit("loop")}.service`);
    check(await until(() => sc("is-active", `${unit("loop")}.service`).stdout.trim() === "active" && calls().includes("loop --resume"), 10_000), "the working loop didn't start");
    const dep = spawnSync("bash", [join(ROOT, "evals/ops/pgx-deploy.sh")], { env: cleanEnv({ RT_EVAL_HOME: home, RT_UNIT_PREFIX: prefix, RT_RTE: fake, RT_RESTART_SEC: "1", RT_PAGES_HOST: "127.0.0.1" }), encoding: "utf8", timeout: 60_000 });
    const order = calls().filter((l) => l !== "pages");
    check(dep.status === 0 && JSON.stringify(order) === JSON.stringify(["wanted", "ready --stub --mock-api", "loop --resume", "stop-after", "loop done", "init --refresh", "run"]),
      `the deploy: exit ${dep.status}, ${order.join(" | ")} (${dep.stderr.trim().slice(-300)})`);
  } finally {
    sc("disable", "--now", ...["loop", "loop-failed", "intake", "pages"].map((n) => `${unit(n)}.service`), `${unit("intake")}.timer`);
    for (const n of ["loop.service", "loop-failed.service", "intake.service", "intake.timer", "pages.service"]) rmSync(join(dir, `${prefix}-${n}`), { force: true });
    sc("daemon-reload");
    sc("reset-failed");
  }
}
finish();
