// T26's acceptance check: Claude's tools for the eval. `rte api` on a temp RT_EVAL_HOME answers each tool with one JSON
// object (the loop's status and the champion, what waits for the owner and a reply on a thread, a stop request, intake
// left to a running loop), and evals/ops/mcp.ts speaks MCP on stdio: it lists the six tools and runs the PGX's through
// ssh, here a fake ssh that runs the remote command on this machine. deploy is listed, never called: it pushes. 0 model
// calls, no network.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t26-tools.mjs
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const home = tempHome();
const js = JSON.stringify;
const put = (f, v) => (mkdirSync(join(f, ".."), { recursive: true }), writeFileSync(f, typeof v === "string" ? v : js(v)));
// The loop's clone: a champion one keep ahead of master, as init leaves it plus one commit.
const repo = join(home, "repo");
const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t26", "-c", "user.email=t26@localhost", ...a], { encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", "-b", "master", repo]);
git("commit", "-q", "--allow-empty", "-m", "master");
git("update-ref", "refs/remotes/origin/master", "HEAD");
git("checkout", "-q", "-b", "loop/champion");
// A keep is the loop's own commit, naming its decision; the owner's commits a sync merges in aren't keeps.
git("commit", "-q", "--allow-empty", "--author=rt-eval loop <rt-eval@localhost>", "-m", "a keep\n\ne7-h1: a code card on draw (goal latency)");
git("commit", "-q", "--allow-empty", "-m", "the owner's commit, merged in by a sync");
git("checkout", "-q", "master");
put(join(home, "init.json"), { from: "/nowhere", branch: "master" });
put(join(home, "state.json"), { epoch: 7, stamp: "s", cards: [{ id: "e7-h1", status: "done" }, { id: "e7-h2", status: "todo" }], queue: [], keepsSinceCheckpoint: 0, keepsSinceRefresh: 0, refreshes: 0, recent: [], paused: [], lastRuns: [], run: { status: "paused", at: "2026-10-28T01:00:00Z", phase: "e7-h2 measuring", why: "every token is past 90% of its five-hour window" } });
// What waits for the owner: one owner-list item with the owner's question on it.
put(join(home, "history", "owner-list.md"), "# Owner list\n\n- [ ] 2026-10-27: e6-h3: a prompt line about roughness or stroke width in draw.ts: \"keep it rough\"\n");
put(join(home, "notes", "threads.jsonl"), `${js({ at: "2026-10-28T00:00:00Z", thread: "e6-h3", who: "owner", text: "Why does this need me?" })}\n`);
const env = cleanEnv({ RT_EVAL_HOME: home, RT_UNIT_PREFIX: `rtcheck${process.pid}` });
const rte = (...a) => {
  const r = spawnSync(join(ROOT, "bin", "rte"), ["api", ...a], { env, encoding: "utf8" });
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {} // not one JSON object: the check below says so
  return { code: r.status, out, raw: `${r.stdout}${r.stderr}` };
};

// ---- rte api, each tool
const s = rte("status");
check(s.code === 0 && s.out, `rte api status: exit ${s.code}, ${s.raw.slice(0, 300)}`);
check(s.out?.loop?.status === "paused" && s.out.loop.epoch === 7 && js(s.out.loop.cards) === js({ decided: 1, of: 2 }) && /five-hour/.test(s.out.loop.why) && s.out.loop.unit !== undefined,
  `status's loop: ${js(s.out?.loop)}`);
check(s.out?.champion?.sha === git("rev-parse", "--short=12", "loop/champion") && s.out.champion.unshipped === 1 && s.out.prod === null && s.out.lock === null, `status's champion, prod and lock: ${js([s.out?.champion, s.out?.prod, s.out?.lock])}`);
check(s.out?.intake?.lookDays === 2 && js(s.out.intake.cards) === "{}" && s.out.bank?.real === 0 && !("cards" in (s.out.bank ?? {})) && s.out.budget?.none, `status's intake, bank and budget (no tokens here): ${js([s.out?.intake, s.out?.bank, s.out?.budget])}`);
const n = rte("needs_you");
check(n.code === 0 && n.out?.items?.length === 1 && n.out.items[0].id === "e6-h3" && n.out.items[0].ownersTurn === false && js(n.out.waiting) === js([{ thread: "e6-h3", at: "2026-10-28T00:00:00Z", owner: "Why does this need me?" }]),
  `rte api needs_you: ${n.raw.slice(0, 400)}`);
const r = rte("needs_you", "--thread", "e6-h3", "--text", "The look is yours: it changes how rough the page is.", "--resolve");
const last = readFileSync(join(home, "notes", "threads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
check(r.code === 0 && js(r.out) === js({ replied: { thread: "e6-h3", resolved: true } }) && last.who === "claude" && last.resolved === true && /rough/.test(last.text), `a reply through needs_you: ${r.raw.slice(0, 200)}, wrote ${js(last)}`);
check(rte("needs_you", "--thread", "e9-nope", "--text", "hello").code !== 0 && readFileSync(join(home, "notes", "threads.jsonl"), "utf8").trim().split("\n").length === 2, "a reply to a thread that doesn't exist was written");
const st = rte("stop");
check(st.code === 0 && /no loop is running; if one starts, it stops at once/.test(st.out?.said ?? "") && existsSync(join(home, "stop.request")), `rte api stop: ${st.raw.slice(0, 200)}`);
const i = rte("intake_now");
check(i.code === 0 && i.out?.started === false && typeof i.out.said === "string", `rte api intake_now with no intake unit here: ${i.raw.slice(0, 200)}`);
check(rte("nothing").code !== 0, "rte api took a tool it doesn't have");
// A ship (evals/ops/ship.sh's rte shipped): the champion's keeps count from what's on prod, and status says where it serves.
const ship = (sha, champion, url = "https://imagine.example.test") => spawnSync(join(ROOT, "bin", "rte"), ["shipped", "--sha", sha, "--tag", `v2-${sha.slice(0, 12)}`, "--url", url, ...(champion ? ["--champion", champion] : [])], { env, encoding: "utf8" });
check(ship(git("rev-parse", "master")).status === 0 && js(rte("status").out?.champion) === js({ sha: git("rev-parse", "--short=12", "loop/champion"), unshipped: 1, since: "prod" }), `status after a ship of master: ${js(rte("status").out?.champion)}`);
// Prod carries the champion (a merge on master, here the same commit): its keep is on prod; the record replaces master's.
const shipsNow = () => readFileSync(join(home, "history", "ships.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check(ship(git("rev-parse", "master"), git("rev-parse", "loop/champion")).status === 0 && rte("status").out?.champion?.unshipped === 0 && shipsNow().length === 1 && shipsNow()[0].champion === git("rev-parse", "loop/champion") && rte("status").out.prod?.url === "https://imagine.example.test",
  `status after a ship of the champion: ${js(rte("status").out)}, ships ${js(shipsNow())}`);
check(ship(git("rev-parse", "master"), undefined, "http://imagine.example.test").status !== 0 && rte("status").out?.champion?.unshipped === 0, "rte shipped took an address that isn't https");

// ---- The MCP server, through a fake ssh: the remote command runs here, with this check's home as the PGX's ~/rt-eval.
const pgxHome = join(home, "pgx-home");
mkdirSync(pgxHome);
symlinkSync(home, join(pgxHome, "rt-eval"));
put(join(home, "rt-units.env"), `RT_EVAL_HOME=${home}\nRT_UNIT_PREFIX=rtcheck${process.pid}\nPATH=${process.env.PATH}\n`);
put(join(repo, "bin", "rte"), `#!/bin/sh\nexec ${join(ROOT, "bin", "rte")} "$@"\n`);
chmodSync(join(repo, "bin", "rte"), 0o755);
const sshLog = join(home, "ssh.log");
const fakeSsh = join(home, "fake-ssh");
put(fakeSsh, `#!/bin/bash\nfor a; do last=$a; done\nprintf '%s\\n' "$*" >> ${sshLog}\nHOME=${pgxHome} RT_EVAL_HOME= exec bash -c "$last"\n`);
chmodSync(fakeSsh, 0o755);
const mcp = spawn(process.execPath, [join(ROOT, "evals", "ops", "mcp.ts")], { cwd: ROOT, env: cleanEnv({ RT_SSH: fakeSsh, RT_PGX: "pgx.invalid", RT_HOSTS: join(home, "no-hosts.env"), RT_EVAL_HOME: "" }), stdio: ["pipe", "pipe", "inherit"] });
const replies = new Map();
let buf = "";
mcp.stdout.on("data", (b) => {
  buf += b;
  for (let k; (k = buf.indexOf("\n")) >= 0; buf = buf.slice(k + 1)) {
    const m = JSON.parse(buf.slice(0, k));
    replies.get(m.id)?.(m);
  }
});
let id = 0;
const ask = (method, params) => new Promise((ok, no) => {
  const n = ++id;
  const t = setTimeout(() => no(new Error(`no answer to ${method}`)), 60_000);
  replies.set(n, (m) => (clearTimeout(t), ok(m)));
  mcp.stdin.write(`${js({ jsonrpc: "2.0", id: n, method, params })}\n`);
});
const init = await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t26", version: "0" } });
mcp.stdin.write(`${js({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
check(init.result?.protocolVersion === "2025-06-18" && init.result.capabilities?.tools && init.result.serverInfo?.name === "rt-eval", `initialize: ${js(init)}`);
const list = await ask("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name);
check(js(names) === js(["status", "needs_you", "run", "stop", "intake_now", "deploy"]) && list.result.tools.every((t) => t.description && t.inputSchema?.type === "object"), `tools/list: ${js(names)}`);
const text = (m) => m.result?.content?.[0]?.text ?? "";
const cs = await ask("tools/call", { name: "status", arguments: {} });
check(!cs.result?.isError && JSON.parse(text(cs)).champion?.since === "prod", `tools/call status: ${text(cs).slice(0, 300)}`);
const cn = await ask("tools/call", { name: "needs_you", arguments: { thread: "e6-h3", text: "Said once more, with an apostrophe's quote." } });
check(!cn.result?.isError && JSON.parse(text(cn)).replied?.thread === "e6-h3" && /apostrophe's quote/.test(readFileSync(join(home, "notes", "threads.jsonl"), "utf8")), `tools/call needs_you with a reply: ${text(cn).slice(0, 200)}`);
const bad = await ask("tools/call", { name: "needs_you", arguments: { thread: "e6-h3", text: "--resolve" } });
check(bad.result?.isError === true, "a reply that would read as a flag went through");
const lines = readFileSync(sshLog, "utf8").trim().split("\n");
check(lines.length === 2 && lines.every((l) => l.startsWith("-o BatchMode=yes -o ConnectTimeout=20 pgx.invalid ")), `the ssh calls: ${js(lines)}`);
check((await ask("tools/call", { name: "nope", arguments: {} })).error?.code === -32602 && (await ask("nope/method", {})).error?.code === -32601, "an unknown tool or method wasn't refused");
mcp.stdin.end();
await new Promise((ok) => mcp.on("close", ok));
if (!existsSync(sshLog)) fail("the MCP server never ran ssh");
finish();
