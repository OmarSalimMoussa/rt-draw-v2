// T18's acceptance check: G0's path, UX, lint, network and patch gates on synthetic
// diffs; the typecheck and the scene round trip in a real candidate tree; the digests
// on a synthetic bank; the over-use detectors and the trace patterns on crafted input;
// the agents' caps and tool rules in real Agent SDK sessions on the fake API. 0 real
// calls: fake tokens, every Claude process on the fake API with HTTPS_PROXY at a closed
// port, and each fake API's request count must equal the turns or calls made on it.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t18-optimizer.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, check, cleanEnv, fail, finish, tempHome } from "./lib.mjs";

const home = tempHome();
// No token or Claude session variable in this process either: only the fake ones below exist.
const env = cleanEnv({ RT_EVAL_HOME: home, RT_DATA_DIR: join(home, "data") });
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, env);
const PORTS = { gateway: 5290, fakeA: 5291, fakeB: 5292, fakeC: 5293, closed: 5294 };
const sh = (cmd, cwd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (file, data) => (mkdirSync(join(file, ".."), { recursive: true }), writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data)));
const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const { g0, parseDiff, diffOf, cardOwnerReasons } = await import("../optimizer/gates.ts");
const { analystDigest, decisionLines, failureDigest, tokensOf, writeLossDigest, writeMissDigest, DIGEST } = await import("../optimizer/digest.ts");
const { OVERUSE, PATTERNS, tracePatterns } = await import("../optimizer/patterns.ts");
const { BASH_ALLOW, CAPS, analyst, critic, engineer, engineerCanUseTool, failureAnalyst, readCards, slotToken, toolRule } = await import("../optimizer/agents.ts");
const prompts = await import("../optimizer/prompts.ts");
const { startFakeApi } = await import("../mock/fake-api.ts");
const { spawnGateway, gatewayStatus } = await import("../loop/client.ts");
const { readMeter } = await import("../loop/meter.ts");
const { paths } = await import("../loop/paths.ts");
const { DEFAULTS, tune } = await import("../../src/core/tuning.ts");
const p = paths();

// ---- G0 on synthetic diffs
const diff = (path, added = [], removed = []) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n ctx\n${[...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n")}\n`;
const verdict = (d) => g0({ diff: d });
// Moving today's fade filter (render.ts) isn't a new effect: as many effects added as removed.
const fadeLine = '    if (st.fade) pic.setAttribute("style", `opacity:${1 - st.fade * knobs["render.fadeOpacity"]};filter:saturate(${1 - st.fade})`);';
check(verdict(diff("src/core/render.ts", [`  ${fadeLine}`], [fadeLine])).verdict === "pass", `re-indenting today's fade filter went to the owner: ${verdict(diff("src/core/render.ts", [`  ${fadeLine}`], [fadeLine])).reasons}`);
// SVG effects (filters, masks, blurs, blending) are composited after render() returns, outside the engine's timing: the owner's.
for (const l of ['const blur = el("filter", { id: "soft" });', '  g.setAttribute("filter", "url(#soft)");', '  node.style.mixBlendMode = "multiply";', '  const fx = el("feGaussianBlur", { stdDeviation: 2 });', '  g.setAttribute("mask", "url(#m)");', '  svg.style.filter = "blur(2px)";',
  '  g.setAttribute("style", `opacity:${1 - fade};filter:drop-shadow(0 2px 2px #0003)`);', '  g.setAttribute("style", "opacity:1;filter:drop-shadow(0 1px 1px #000)");', "  g.style.filter = shadow;", '  const pat = el("pattern", { id: "dots" });', '  g.style.transition = "opacity 200ms";', '  const css = "@keyframes in { from { opacity: 0 } }";',
  '  const a = el("animate", { attributeName: "opacity" });', '  const markup = `<g filter="url(#f)">`;', '  g.style.setProperty("mix-blend-mode", "multiply");', '  g.style.boxShadow = "0 0 4px #000";'])
  check(verdict(diff("src/core/render.ts", [l])).verdict === "owner", `an SVG or CSS effect in src/ isn't the owner's: ${l}`);
for (const l of ["  const live = shapes.filter((s) => s.visible);", "  // a filter in a comment", '  const masked = "the mask word in prose";', '  const mask = "#000";', "  filter: string;", "  const x = keep ? mask : 0;", '  const mode = { transition: "glide" };', "  input.blur();", "  camera.animate(view);"])
  check(verdict(diff("src/core/render.ts", [l])).verdict === "pass", `a line with no SVG effect went to the owner: ${l} (${verdict(diff("src/core/render.ts", [l])).reasons})`);
for (const f of ["evals/judge/prompts.ts", "evals/loop/verdict.ts", "dev/claude.ts", "vite.config.ts", "scripts/tune.ts", "src/fixtures/board.ops.txt", "package.json"])
  check(verdict(diff(f, ["// x"])).verdict === "owner", `a diff touching ${f} isn't an owner-list item: ${JSON.stringify(verdict(diff(f, ["x"])))}`);
for (const f of ["src/ui.ts", "src/ui.css", "src/boardStage.ts", "index.html", "playgrounds/draw/index.html", "src/fonts/x.woff2"])
  check(verdict(diff(f, ["x"])).verdict === "reject", `the UX file ${f} isn't rejected`);
check(verdict(diff("src/core/speech.ts", ["// x"])).verdict === "reject", "speech.ts isn't rejected");
check(verdict(diff("src/main.ts", ["// x"])).verdict === "reject", "a path outside src/core isn't rejected");
const rename = "diff --git a/src/core/tidy.ts b/evals/core/tidy.ts\nsimilarity index 100%\nrename from src/core/tidy.ts\nrename to evals/core/tidy.ts\n";
check(parseDiff(rename)[0].from === "src/core/tidy.ts" && verdict(rename).verdict === "owner", `a rename into evals/: ${JSON.stringify(parseDiff(rename))}`);
const core = (lines, file = "src/core/draw.ts") => verdict(diff(file, lines));
check(/magic number 350/.test(core(["  const waitMs = 350;"]).reasons[0] ?? "") && core(["  const waitMs = 350;"]).verdict === "reject", "a new 350 in src/core/draw.ts doesn't fail the lint");
for (const [line, why] of [["  await sleep(0.5);", "0.5"], ["  const at = `${n * 1000} ms`;", "a number inside ${}"], ["  const m = 3_600_000;", "3_600_000"], ["  x[3] = 1e3;", "3 and 1e3"]])
  check(core([line]).verdict === "reject", `the lint missed ${why}: ${line}`);
for (const line of ['  K("draw.waitMs", 350, 0, 2000, 50, "how long the draw waits", "ms"),'])
  for (const file of ["src/core/tuning.ts", "src/core/prompts.ts"]) check(core([line], file).verdict === "pass", `a number in ${file} fails the lint`);
for (const line of ["  const half = (w - 1) / 2 + x[0] - 1;", '  const s = "wait 350 ms at 0.5";', "  // waits 350 ms", "   * a doc line with 350", '  const t = t["draw.mapDepth"] + 1; // 40 words', "  if (/\\d{3,4}/.test(s)) return;", "  return a.b2 + item.x1;"])
  check(core([line]).verdict === "pass", `the lint flags a clean line: ${line} (${core([line]).reasons})`);
const tuningDiff = diff("src/core/tuning.ts", ['  B("patches.scribe", 1, "scribe patches", "on: apply our patches"),'], ['  B("patches.scribe", 0, "scribe patches", "on: apply our patches"),']);
check(verdict(tuningDiff).verdict === "reject" && /patches/.test(verdict(tuningDiff).reasons[0]), "a changed patches.* default isn't refused");
check(verdict(diff("src/core/tuning.ts", ['  patch("scribe", K("speech.shiftMs", 40, -500, 500, 10, "shift", "ms"), 0),'])).verdict === "reject", "a moved patch knob isn't refused");
check(verdict(diff("src/core/tuning.ts", ['  K("draw.mapWords", 30, 0, 60, 1, "words"),'], ['  K("draw.mapWords", 40, 0, 60, 1, "words"),'])).verdict === "pass", "an ordinary knob default change is refused");
for (const [line, why] of [['  const r = await fetch("https://example.com/x");', "a fetch elsewhere"], ['  void fetch("/api/tts", { method: "POST" });', "/api/tts"], ["  const res = await fetch(url);", "a fetch to a variable"],
  ['  const u = "/api/stt-token";', "a new endpoint"], ["  const sttToken = await getToken();", "an stt identifier"], ["  speakWithElevenTTS(text);", "a tts identifier"], ["  useScribe();", "a Scribe identifier"], ["  const ws = new WebSocket(u);", "a WebSocket"]])
  check(core([line]).verdict === "reject", `not refused: ${why}`);
check(core(['  const r = await fetch("/api/model", { method: "POST", body });']).verdict === "pass", "a fetch to /api/model is refused");
check(core(['  const settings = { attempt: t["draw.mapDepth"] };']).verdict === "pass", "a clean src/core change doesn't pass G0's diff checks");
// The Sketchbook look: an outline set crisp in code, or asked for in a prompt, is the owner's; a knob read kept passes.
const KNOB = '    roughness: st.roughness ?? knobs["render.roughness"],';
for (const [file, added, removed] of [["src/core/render.ts", ["    roughness: 0,"], [KNOB]], ["src/core/picture.ts", ["    opts.strokeWidth = 1;"], []], ["src/core/ops.ts", ['      case "roughness": into.roughness = 0; break;'], []],
  ["src/core/prompts.ts", ["Give every shape roughness:0 so it reads clean."], []], ["src/core/draw.ts", ["  const x = 1;"], ['  const r = t["picture.roughness"];']]])
  check(verdict(diff(file, added, removed)).verdict === "owner", `a crisp outline in ${file} isn't an owner-list item: ${verdict(diff(file, added, removed)).reasons}`);
check(verdict(diff("src/core/render.ts", [`${KNOB} // the shape's own style first`], [KNOB])).verdict === "pass", "a render edit that keeps the knob read isn't passed");
check(verdict(diff("src/core/prompts.ts", ["When the ink is a rough box, fill that box with the shape it stands for."], [])).verdict === "pass", "a prompt line about the user's rough ink is held as a look change");
check(verdict(diff("src/core/prompts.ts", ['<circle cx="60" cy="60" r="34" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>'], [])).verdict === "pass"
  && verdict(diff("src/core/prompts.ts", ["Draw every outline at a thinner stroke width so the page reads clean."], [])).verdict === "owner"
  && verdict(diff("src/core/prompts.ts", ["Set strokeWidth=1 on every shape."], [])).verdict === "owner", "an SVG element's stroke-width (the picture prompt's own) is held, or an op's stroke width asked for isn't");
// No caps on a picture's elements or colors (LOOP-V2.md B1): setting one is a reject, taking one off passes.
const capLine = (v) => `  K("picture.colors", ${v}, 0, 10, 1, "and at most this many colors (0: as many as it needs)"),`;
check(verdict(diff("src/core/tuning.ts", [capLine(4)], [capLine(0)])).verdict === "reject", `a picture colour cap isn't refused: ${verdict(diff("src/core/tuning.ts", [capLine(4)], [capLine(0)])).reasons}`);
check(verdict(diff("src/core/tuning.ts", [capLine(0)], [capLine(4)])).verdict === "pass", `taking a picture colour cap off is refused: ${verdict(diff("src/core/tuning.ts", [capLine(0)], [capLine(4)])).reasons}`);

// ---- G0 in a candidate tree: the typecheck with the bridge, and the scene round trip (0 calls)
const tree = join(home, "trees", "cand");
mkdirSync(tree, { recursive: true });
sh(`git -C "${ROOT}" archive HEAD | tar -x -C "${tree}"`);
symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
sh('git init -q && git add -A && git -c user.email=c@x -c user.name=c commit -qm base && git tag base', tree);
const commit = (msg) => sh(`git add -A && git -c user.email=c@x -c user.name=c commit -qm "${msg}"`, tree);
const edit = (file, from, to) => {
  const f = join(tree, file);
  const text = readFileSync(f, "utf8");
  if (!text.includes(from)) fail(`${file} no longer holds ${from}`);
  writeFileSync(f, text.replace(from, to));
};
const g0Tree = (o = {}) => g0({ diff: diffOf(tree, "base", "HEAD"), tree, ...o });
edit("src/core/render.ts", "\n", "\n// G0's clean candidate: a comment.\n");
commit("clean");
check(g0Tree().verdict === "pass", `a clean candidate tree fails G0: ${g0Tree().reasons}`);
edit("src/core/render.ts", "// G0's clean candidate: a comment.", "export const broken: number = \"not a number\";");
commit("type error");
const own = g0Tree();
check(own.verdict === "reject" && /typecheck/.test(own.reasons[0]), `the candidate's own type error: ${JSON.stringify(own)}`);
sh("git reset -q --hard base", tree);
edit("src/core/send.ts", "export async function send(", "export async function sendOne(");
commit("contract break");
const broke = g0Tree();
check(broke.verdict === "owner" && /broken bridge contract/.test(broke.reasons[0]) && /evals\//.test(broke.reasons[0]), `a changed bridge-contract signature isn't an owner-list item: ${JSON.stringify(broke)}`);

// The bank (also the digest's): before-scenes, one from a real fixture.
const { runScript } = await import("../../src/core/ops.ts");
const toyshop = runScript(readFileSync(join(ROOT, "evals/fixtures/board.ops.txt"), "utf8")).scene.toJSON();
const shape = (id, o = {}) => ({ id, kind: "rect", box: { x: 10, y: 10, w: 100, h: 40 }, description: `the ${id} box of the page`, style: { fill: "#fff" }, ...o });
const scenes = [toyshop, { v: 1, width: 1280, height: 800, shapes: [shape("a"), shape("b", { text: { words: "Shop" } })], groups: { g: ["a", "b"] } }];

sh("git reset -q --hard base", tree);
edit("src/core/scene.ts", "\n", "\n// G0's scene.ts candidate: same format.\n");
commit("scene comment");

// ---- A synthetic bank: tuning cases with every kind of miss, held-out cases that must never show
const BEATS = ["amb-arrow", "two-cand", "pause-fix", "undo", "camera-ask"];
const ASKS = ["add", "move", "restyle", "retext"];
const STARTS = ["blank", "toyshop-home", "clowns", "messy"];
const SECRET = "HELDOUT-SECRET";
const bankCase = (id, set, n) => {
  const dir = p.bankCase(id);
  const info = { id, set, scenario: `sc-${n % 7}`, persona: ["first-timer", "explorer", "breaker"][n % 3], style: "typical", start: STARTS[n % 4], beat: BEATS[n % 5], ask: ASKS[n % 4], seed: n, originSession: `s${Math.floor(n / 5)}`, send: n % 5, championSha: "champ", tuningId: "default", harnessTag: "h1", configId: "c", recordedAt: "2026-10-16T00:00:00Z", hedged: false, beatDone: true, flags: [] };
  const tag = set === "tuning" ? "" : ` ${SECRET}`;
  put(join(dir, "case.json"), info);
  put(join(dir, "input.json"), { camera: { x: 0, y: 0, w: 1280, h: 800 }, words: `make the header ${"bigger and bolder ".repeat(4)}please${tag}`, strokes: [], enterAtMs: 1000, inputHash: "h" });
  put(join(dir, "meant.json"), { meant: `the header grows and gets bolder, the rest stays${tag}`, hedged: false });
  put(join(dir, "before.scene.json"), scenes[n % 2]);
  if (n % 3 === 0 || set !== "tuning") put(join(dir, "rating.json"), { satisfaction: set === "tuning" ? 1 + (n % 3) : 1, saw: `the header didn't change at all${tag}`, feeling: "meh" });
  put(join(dir, "miss.json"), { judgeId: "j1", met: set !== "tuning" ? "no" : ["yes", "partly", "no", "yes"][n % 4], why: `the header kept its size${tag}` });
  put(join(dir, "champion.json"), { opsFailed: n % 11 === 0 ? 2 : 0, picsFailed: n % 13 === 0 ? 1 : 0, empty: n % 17 === 0 });
  put(join(dir, "readings.json"), { marks: [{ n: 1, kind: "pointing", how: "loop", targets: ["a"] }], refs: [{ phrase: "the header", ids: ["a"] }] });
  put(join(dir, "replies.json"), [{ role: "draw", ordinal: 0, reqHash: `r${n}`, cacheFile: `r${n}.json`, offsets: [] }]);
  put(p.reply(`r${n}`), { text: Array.from({ length: 40 }, (_, i) => `shape(x${i}, rect, 10 10 100 40, "line ${i}")`).join("\n"), stats: { thinkingTokens: n % 2 ? 50 : 0 } });
  put(join(dir, "done"), "x\n");
  return info;
};
const tuningCases = Array.from({ length: 320 }, (_, n) => bankCase(`c-b1-s${String(Math.floor(n / 5)).padStart(2, "0")}-${n % 5}`, "tuning", n));
const heldCases = Array.from({ length: 48 }, (_, n) => bankCase(`c-h${n % 2 ? "c" : "g"}-s${n}-0`, n % 2 ? "heldout-chart" : "heldout-gate", 1000 + n));
// The crafted worst case: every signal at once.
const worst = tuningCases[0].id;
put(join(p.bankCase(worst), "miss.json"), { judgeId: "j1", met: "no", why: "nothing changed" });
put(join(p.bankCase(worst), "champion.json"), { opsFailed: 3, picsFailed: 2, empty: true });

const scene = g0Tree();
check(scene.verdict === "pass" && scene.scenes?.loaded === 368 && !scene.scenes.failed.length, `a scene.ts change didn't load every banked before-scene through B's Scene.fromJSON: ${JSON.stringify(scene).slice(0, 300)}`);
// A format change that still typechecks: every banked scene stops loading.
edit("src/core/scene.ts", "if (j.v !== 1)", "if ((j.v as number) !== 2)");
commit("scene format");
const fmt = g0Tree();
check(fmt.verdict === "owner" && fmt.scenes?.failed.length === 368 && /scene format/.test(fmt.reasons[0]), `a scene format break: ${JSON.stringify(fmt).slice(0, 300)}`);
check(!existsSync(p.calls), "G0 wrote meter lines (it must make 0 calls)");

// ---- Runs: the last checkpoint (champion A) and a decision (A champion, B candidate)
const rowOf = (c, s, o = {}) => ({ case: c, cluster: "s", affected: true, class: "Q", s, ttfc: [1000, 1100], ttd: [5000, 5200], work: [2, 2], usd: [0.03, 0.03], thought: [true, false], overuse: [false, false], pics: [[1, 0], [1, 0]], ask: "add", firstArm: "A", ...o });
const rows = (run, list) => put(join(p.run(run), "rows.jsonl"), list.map((r) => JSON.stringify(r)).join("\n") + "\n");
const cpLost = tuningCases.slice(100, 110).map((c) => c.id);
rows("cp1", [...cpLost.map((c) => rowOf(c, 1)), ...tuningCases.slice(110, 130).map((c) => rowOf(c.id, -1)), ...heldCases.map((c) => rowOf(c.id, 1))]);
const sp = (name, s, e, o = {}) => ({ name, traceId: "t", spanId: o.id ?? name, parentId: o.parent, startMs: s, endMs: e, attributes: o.attrs ?? {}, events: o.events ?? [] });
const armFiles = (run, c, a, failedOps) => {
  const d = join(p.run(run), "cases", c, a);
  put(join(d, "result.json"), { ops: [{ line: "shape(h, rect)", ok: true, ms: 10 }, ...(failedOps ? [{ line: "shape(x, blob)", ok: false, error: "unknown kind blob", ms: 20 }] : [])], reply: "shape(h, rect)", stopReasons: [], calls: [{ role: "draw", reqHash: a === "A" ? "d1" : "d2", shared: "-", mode: "live", ms: 5000, thinkingTokens: 10 }, { role: "draw-refs", reqHash: "r1", shared: "leader", mode: "live", ms: 3000 }] });
  put(join(d, "timing.json"), { enterAt: 0, ttfcMs: 1200, ttdMs: 6000, ttfdMs: 5050, renderP50Ms: 0.9, firstTextMs: 900, resolverMs: 3000, picturesMs: 2000, renders: 3, longTasksMs: 0, quiescedAt: 6000, heapMb: 50, gatewayLoopP99Ms: 1 });
  put(join(d, "changes.json"), [a === "A" ? "resized 'header'" : "added rect 'promo'"]);
  // The think router's answer, cached as cache.ts writes it: section 1 reads Jev's range from it.
  put(join(d, "replies.json"), [{ role: "draw-think", ordinal: 0, reqHash: `think-${run}-${c}-${a}`, cacheFile: `think-${run}-${c}-${a}.json`, offsets: [30] }]);
  put(p.reply(`think-${run}-${c}-${a}`), { text: '{"think":{"type":"noul","noul":0.62}}' });
  put(join(d, "spans.json"), [sp("build the prompt", 0, 3600, { id: "bp" }), sp("resolve references", 0, 3500, { id: "rr", parent: "bp" }), sp("model call · draw-refs · haiku", 0, 3500, { id: "mr", parent: "rr", attrs: { from: "draw-refs", model: "haiku" } }), sp("board screenshots", 3510, 3700, { id: "bs", parent: "bp" }),
    sp("model call · draw · sonnet", 3700, 6000, { id: "md", attrs: { from: "draw", model: "sonnet", outTokens: 200 } }), sp("model: time to first text", 3700, 4500, { parent: "md" }),
    sp("model: streaming the reply", 4500, 5500, { parent: "md" }), sp("op 1: shape(h, rect)", 5000, 5000, { attrs: { ok: true, line: "shape(h, rect)" } })]);
  put(join(p.run(run), "cases", c, "judge", "fidelity-1.json"), { winner: "left", confidence: 2, why: `A kept the header; B added a promo${c.startsWith("c-h") ? ` ${SECRET}` : ""}`, positions: { left: "A", right: "B" }, judgeId: "j1" });
};
const abCases = tuningCases.slice(200, 240);
for (const [i, c] of abCases.entries()) for (const a of ["A", "B"]) armFiles("ab1", c.id, a, i % 3 === 0);
for (const c of heldCases.slice(0, 6)) for (const a of ["A", "B"]) armFiles("ab1", c.id, a, true);
for (const c of tuningCases.slice(100, 110)) armFiles("cp1", c.id, "A", false);
rows("ab1", [...abCases.map((c, i) => rowOf(c.id, i % 4 === 0 ? -1 : i % 4 === 1 ? 0 : 1, { beat: c.beat })), ...heldCases.slice(0, 6).map((c) => rowOf(c.id, -1))]);

// ---- The digest
const digest = analystDigest({ championSha: "champ", checkpoint: { run: "cp1", champion: "A" }, runs: ["ab1"], decisions: ["- e1-h2 code draw fidelity: draw prose opener → revert: Rule F at look 48 (1-2-3)"], failures: ['[{"case":"x","component":"draw","evidence":"e","tag":"t"}]'] });
check(tokensOf(digest) <= DIGEST.maxTokens, `the digest is ${tokensOf(digest)} tokens (> ${DIGEST.maxTokens})`);
check(digest.length / 4 <= DIGEST.maxTokens, `the digest is over 40k tokens even at 4 characters a token`);
check(!digest.includes(SECRET) && !heldCases.some((c) => digest.includes(c.id)), "the digest includes a held-out case");
const at = (s) => digest.indexOf(s);
check(at("# 1. Where the time to first drawing goes") === 0 && at("# 1.") < at("# 2. Where the champion fails") && at("# 2.") < at("# 3. Candidate losses") && at("# 3.") < at("# 4. Failure analysts") && at("# 4.") < at("# 5. Every decision so far"), "the digest's sections are out of order");
const s1 = digest.slice(at("# 2."), at("# 3."));
const s2 = digest.slice(at("# 3."), at("# 4."));
check(/\(\+\d+ more not shown\)/.test(s1), "section 1 isn't cut to its budget (the synthetic bank is larger than it)");
for (const want of ["driver rated", "miss check no", "miss check partly", "lost to the anchor at the last checkpoint", "empty send", "failed ops", "failed pictures"]) check(s1.includes(want), `section 1 has no '${want}'`);
for (const by of ["By beat:", "By ask type:", "By start:", "By component:"]) check(s1.includes(by), `section 1 isn't grouped: no '${by}'`);
// A tuning case n misses when bankCase gave it a rating ≤ 2, a miss check no/partly or a failure, or the checkpoint lost it.
const missed = (n) => n % 3 === 0 || n % 4 === 1 || n % 4 === 2 || n % 11 === 0 || n % 13 === 0 || n % 17 === 0 || cpLost.includes(tuningCases[n].id);
const misses = tuningCases.filter((c, n) => c.beat === "amb-arrow" && missed(n)).length;
check(s1.includes(`amb-arrow ${misses}/64`), `section 1's beat count for amb-arrow isn't ${misses}/64: ${/By beat:.*/.exec(s1)?.[0]}`);
// The bar before a card is measured, and every target's case count, missed or not, so narrow cards drop before they're built.
check(/Coverage: .*fewer than 32 .*too rare/.test(s1) && /by beat: [^;]*amb-arrow 64/.test(s1) && /by ask type: /.test(s1) && /with ink: \d+/.test(s1), `section 1 lacks the 32-case bar or the coverage counts: ${/Coverage:.*/.exec(s1)?.[0]}`);
const scores = [...s1.matchAll(/^- (\S+) \[(\d+)\]/gm)].map((m) => [m[1], Number(m[2])]);
check(scores[0]?.[0] === worst && scores.every((x, i) => !i || x[1] <= scores[i - 1][1]), `champion misses aren't ranked worst first: ${scores.slice(0, 5)}`);
check(cpLost.every((c) => !scores.some(([id]) => id === c) || s1.includes(`${c} [`)), "a checkpoint loss is missing");
check(s2.includes("LOST") && s2.indexOf("LOST") < s2.indexOf(" tie ") && /B's failed ops/.test(s2) && /judge: A kept/.test(s2) && /B's top spans/.test(s2) && /thinking A true B false/.test(s2) && /By persona:/.test(s2) && /By fixture:/.test(s2) && /differs in: draw/.test(s2), `section 2 lacks the candidate losses' fields: ${s2.slice(0, 400)}`);
// 10 checkpoint cases + 40 decision cases (the 6 held-out ones never read).
check(/Waiting on a slow answer only part of the work needs.*: 50 cases/.test(digest) && /First drawing by step/.test(digest) && digest.includes("# 5. Every decision so far") && digest.includes("e1-h2 code draw fidelity"), "the patterns, latency or decisions are missing");
// First drawing's phases on the champion's 50 sends: the call starts at 3700, first text 800 ms later, the op 500 ms after.
for (const want of ["over 50 champion sends", "before the drawing call (Jev, screenshots, the prompt): 3700 ms", "the drawing model's first text: 800 ms", "streamed after it (nothing is drawn before a whole line): 500 ms",
  "to the first drawing (paint, or a picture's strokes or a later op): 50 ms", "first drawing: 5050 ms (p90 5050); render per op: p50 0.9 ms", "draw · sonnet: first text 800 ms (p90 800), 200 tok/s, thought on",
  "- draw-think: 0.62, 0.62–0.62, 0.62–0.62 (50 answers)"])
  check(digest.includes(want), `section 3's first drawing steps lack "${want}": ${digest.slice(digest.indexOf("First drawing by step"), digest.indexOf("First drawing by step") + 900)}`);
writeMissDigest("champ", { run: "cp1", champion: "A" });
writeLossDigest("ab1");
check(existsSync(p.digest("champ")) && readFileSync(p.digest("champ"), "utf8").startsWith("# 2. Where the champion fails") && existsSync(join(p.run("ab1"), "digest.md")), "the digests weren't written to digests/<sha>.md and runs/<run>/digest.md");
const fd = failureDigest([...heldCases.slice(0, 3).map((c) => ({ case: c.id })), ...tuningCases.slice(0, 14).map((c) => ({ case: c.id })), { case: abCases[0].id, run: "ab1" }]);
check((fd.match(/^## /gm) ?? []).length === DIGEST.failureCases && !fd.includes(SECRET), `the failure digest holds ${(fd.match(/^## /gm) ?? []).length} cases or a held-out one`);
check(/draw reply \(first 30 lines\):\n(?:shape.*\n){30}(?!shape)/.test(fd) && /thinking: draw/.test(fd) && /miss check: no/.test(fd) && /resolver: "the header" → a/.test(fd), "the failure digest lacks the draw reply's first 30 lines, the miss check, the resolver or thinking");

// ---- Over-use detectors: each fires on its crafted send and not on a clean one
const before = { v: 1, width: 1280, height: 800, shapes: [shape("header", { text: { words: "Shop", size: 24 } }), shape("body")], groups: {} };
const after = (f) => f(structuredClone(before));
const cam = { x: 0, y: 0, w: 1280, h: 800 };
const clean = { before, after: after((s) => (s.shapes.push(shape("note")), s)), ops: [{ line: "shape(note, rect)", ok: true, ms: 1 }], cameras: [cam, cam], pointed: [] };
const crafted = {
  "new-style": { ...clean, after: after((s) => (s.shapes.push(shape("promo", { style: { fill: "#ff00ff" } })), s)) },
  "extra-shapes": { ...clean, after: after((s) => (s.shapes.push(shape("x1"), shape("x2"), shape("x3")), s)) },
  "camera-move": { ...clean, ops: [{ line: "camera(0 0 800 500)", ok: true, ms: 1 }], cameras: [cam, { ...cam, w: 800, h: 500 }] },
  "restyle-unpointed": { ...clean, after: after((s) => ((s.shapes[1].style = { fill: "#fff", stroke: "red" }), s)) },
};
check(Object.keys(OVERUSE).sort().join() === "camera-move,extra-shapes,new-style,restyle-unpointed", `OVERUSE holds ${Object.keys(OVERUSE)}`);
for (const [name, send] of Object.entries(crafted)) {
  check(OVERUSE[name](send) === true, `${name} didn't fire on its crafted send`);
  check(OVERUSE[name](clean) === false, `${name} fired on a clean send`);
}
check(OVERUSE["restyle-unpointed"]({ ...crafted["restyle-unpointed"], pointed: ["body"] }) === false, "restyle-unpointed fired on a pointed shape");
check(OVERUSE["new-style"]({ ...crafted["new-style"], before: { ...before, shapes: [] } }) === false, "new-style fired on a blank scene");

// ---- The 6 trace patterns on synthetic spans
const M = (role, s, e, o = {}) => sp(`model call · ${role} · sonnet`, s, e, { ...o, attrs: { from: role, model: "sonnet", chars: o.chars ?? 900, images: 1 } });
const warm = (id, s, e) => sp("Claude process (already waiting)", s, s + 5, { parent: id, id: `${id}-p` });
const cold = (id, s, ms) => sp("Claude process (started for this call)", s, s + ms, { parent: id, id: `${id}-p` });
const traces = {
  "whole-reply": [M("draw", 0, 5000, { id: "d", events: [{ name: "first text", atMs: 1000 }] }), warm("d", 0), sp("picture: hero", 5010, 9000, { id: "ph" }), M("picture", 5010, 9000, { id: "mp", parent: "ph" }), warm("mp", 5010)],
  "cold-parallel": [M("picture", 0, 3000, { id: "p1" }), warm("p1", 0), M("picture", 10, 3200, { id: "p2" }), cold("p2", 10, 900), M("picture", 20, 3300, { id: "p3" }), cold("p3", 20, 900)],
  "warm-late": [M("camera", 0, 2000, { id: "c" }), cold("c", 0, 800)],
  serial: [sp("build the prompt", 0, 500, { id: "bp" }), sp("screenshot", 0, 200, { id: "s1", parent: "bp" }), sp("board screenshots", 205, 400, { id: "s2", parent: "bp" })],
  redo: [sp("describe shapes", 0, 3000, { id: "ds" }), M("describe", 0, 1400, { id: "m1", parent: "ds" }), warm("m1", 0), M("describe", 1400, 2900, { id: "m2", parent: "ds" }), warm("m2", 1400)],
  "slow-answer": [sp("build the prompt", 0, 3800, { id: "bp" }), sp("resolve references", 0, 3500, { id: "rr", parent: "bp" }), M("draw-refs", 0, 3500, { id: "mr", parent: "rr" }), warm("mr", 0), sp("board screenshots", 3510, 3700, { id: "bs", parent: "bp" })],
};
// The product as it should be: pictures as their ops land, warm processes, the resolver beside the screenshots.
const cleanTrace = [
  sp("build the prompt", 0, 3600, { id: "bp" }), sp("resolve references", 0, 3500, { id: "rr", parent: "bp" }), M("draw-refs", 0, 3500, { id: "mr", parent: "rr", chars: 700 }), warm("mr", 0),
  sp("board screenshots", 50, 300, { id: "bs1", parent: "bp" }), sp("board screenshots", 3510, 3580, { id: "bs2", parent: "bp" }),
  sp("drawing model and ops", 3600, 8600, { id: "dm" }), M("draw", 3600, 8600, { id: "d", parent: "dm", chars: 4000, events: [{ name: "first text", atMs: 4600 }] }), warm("d", 3600),
  sp("picture: hero", 5000, 9000, { id: "ph" }), M("picture", 5000, 9000, { id: "mp", parent: "ph", chars: 300 }), warm("mp", 5000),
];
check(Object.keys(PATTERNS).length === 6, `${Object.keys(PATTERNS).length} trace patterns, not 6`);
for (const [id, spans] of Object.entries(traces)) check(PATTERNS[id].detect(spans).length > 0, `the '${id}' pattern isn't detected on its synthetic spans`);
for (const [id, pat] of Object.entries(PATTERNS)) check(pat.detect(cleanTrace).length === 0, `the '${id}' pattern fires on a clean trace: ${JSON.stringify(pat.detect(cleanTrace))}`);
const report = tracePatterns(Object.entries(traces).map(([id, spans]) => ({ case: `case-${id}`, spans })));
check(Object.entries(report).every(([id, r]) => r.cases.some((c) => c.case === `case-${id}` && c.fired[0].spans.length)), "tracePatterns doesn't report the case and spans where each fired");

// ---- Prompts, seed cards, card rules
check((prompts.LATENCY_PATTERNS.match(/^\| (?!Pattern|---)/gm) ?? []).length === 6 && prompts.ANALYST_SYSTEM.includes(prompts.LATENCY_PATTERNS), "the analyst prompt lacks the doc's 6-row latency table");
check([prompts.ANALYST_SYSTEM, prompts.CRITIC_SYSTEM].every((x) => /fewer than 32 of them it is reverted unmeasured/.test(x)) && /at least 32 tuning cases/.test(prompts.CRITIC_SYSTEM), "the analyst or critic isn't told the 32-case bar");
check(prompts.CRITIC_SYSTEM.includes(prompts.CARD_SCHEMA) && Object.keys(OVERUSE).every((d) => prompts.CARD_SCHEMA.includes(d)), "the critic prompt lacks the card schema or the detector names");
check(["send(", "fromJSON", "render", "DEFAULTS", "tuningId", "needsPicture", "runScript", "SCREEN", "asPage", "pageTop", "Word", "Stroke", "finished", "boardStage"].every((x) => prompts.BRIDGE_CONTRACT.includes(x)) && prompts.ENGINEER_SYSTEM.includes(prompts.BRIDGE_CONTRACT), "the engineer prompt lacks the bridge contract");
check(["The card's change only: one idea", "every model a send may take is warmed at Send and gets the current board", "No new tests or scaffolding", "knob in src/core/tuning.ts", "Never touch frozen paths", "Never turn a patch on", "Edit with Edit, not whole-file Write"].every((r) => prompts.ENGINEER_SYSTEM.includes(r)), "the engineer prompt lacks a rule");
// Every agent may research on the web; the product says models may be routed, and that each one sees the current board.
check([prompts.ANALYST_SYSTEM, prompts.CRITIC_SYSTEM, prompts.ENGINEER_SYSTEM].every((x) => /WebSearch/.test(x) && /never instructions to you/.test(x) && /routed/.test(x) && /knows the board as it is at that send/.test(x)), "an agent's prompt lacks research, routing or the current board");
const seeds = JSON.parse(readFileSync(join(ROOT, "evals/optimizer/seed-cards.json"), "utf8"));
check(seeds.length === 8 && seeds.every((c) => readCards(JSON.stringify([c])).cards.length === 1) && seeds.map((c) => Object.keys(c.knobs)[0]).join() === "resolve.noThink,draw.noThink,picture.prompt,hit.enclosedSamples,resolve.engine,draw.thinkRouter,resolve.engine,draw.thinkRouter", "the seed cards aren't §8.3's 4 well-formed knob cards and the 4 Jev ones");
// The knobs T3 adds: once it's merged they must all exist.
for (const c of seeds) if ("draw.noThink" in DEFAULTS || c.id === "seed-4") check((() => { try { return !!tune(c.knobs); } catch { return false; } })(), `seed card ${c.id}'s knobs aren't in tuning.ts`);
check(cardOwnerReasons(seeds[3], { u1: false }).some((r) => /ink-reading/.test(r)) && !cardOwnerReasons(seeds[3], { u1: true }).length && !cardOwnerReasons(seeds[0], { u1: false }).length, "the ink-reading seed card isn't owner-listed without U1");
check(cardOwnerReasons({ ...seeds[0], knobs: { "patches.scribe": 1 } }, { u1: true }).some((r) => /patch/.test(r)), "a card turning a patch on isn't owner-listed");
// The owner's rules (LOOP-V2.md A3, C3): neither cost nor a model switch or router sends a card to the owner, every model
// knob and who resolves is measured; render.pictureBox is the owner's (LOOP-V2.md B2).
for (const k of ["picture.model", "draw.model", "describe.model", "router.fastModel", "router.fullModel", "resolve.engine", "resolve.jevModel", "draw.thinkJevModel", "router.fastMaxWords"])
  check(!cardOwnerReasons({ ...seeds[0], knobs: { [k]: 0 } }, { u1: true }).length, `a card on ${k} is owner-listed: ${cardOwnerReasons({ ...seeds[0], knobs: { [k]: 0 } }, { u1: true })}`);
check(cardOwnerReasons({ ...seeds[0], knobs: { "render.pictureBox": 0 } }, { u1: true }).some((r) => /owner's knob/.test(r)), "render.pictureBox isn't the owner's");

// ---- The search (LOOP-V2.md D1, D3, D4): sweep and combo cards, knob literals, pruning, near wins.
const search = await import("../loop/search.ts");
const kc = (o) => ({ id: "s", component: "draw", change: "c", goal: "fidelity", classGuess: "Q", dialogue: false, isPatch: false, touchesFrozen: false, risk: "r", files: [], ...o });
const faults = (o) => readCards(JSON.stringify([kc(o)])).dropped.join();
check(!faults({ kind: "sweep", sweep: { knob: "picture.fill", values: [0.8, 1] } }) && /sweep without/.test(faults({ kind: "sweep" })) && /at most 4/.test(faults({ kind: "sweep", sweep: { knob: "picture.fill", values: [0.5, 0.6, 0.7, 0.8, 1] } })), "sweep cards aren't read as well-formed, or their faults aren't caught");
check(!faults({ kind: "combo", combines: ["e1-h1", "e2-h3"] }) && /two tried ids/.test(faults({ kind: "combo", combines: ["e1-h1"] })) && /at most 3/.test(faults({ kind: "combo", combines: ["a", "b", "c", "d"] })), "combo cards aren't read as well-formed, or their faults aren't caught");
// A combo's tried patches that edit the same lines don't apply in turn: TriedConflict, so an engineer makes them by hand.
{
  const g = join(home, "combo-git"), hist = join(home, "combo-history");
  mkdirSync(join(hist, "tried"), { recursive: true });
  sh(`git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base && printf '1\\n2\\n3\\n' > a.txt && git add a.txt && git -c user.name=t -c user.email=t@t commit -q -m a`, (mkdirSync(g, { recursive: true }), g));
  for (const [id, line] of [["t1", "two"], ["t2", "deux"]]) {
    sh(`git checkout -q -B ${id} main && sed -i 's/^2$/${line}/' a.txt && git -c user.name=t -c user.email=t@t commit -qam ${id}`, g);
    writeFileSync(join(hist, "tried", `${id}.patch`), `rt-eval tried: ${id}\n---\n${sh(`git format-patch -1 --stdout ${id}`, g)}`);
  }
  sh("git checkout -q main", g);
  search.applyTried(g, ["t1"], hist, join(home, "combo-tmp"));
  check(readFileSync(join(g, "a.txt"), "utf8") === "1\ntwo\n3\n" && search.triedPatch("t2", hist).startsWith("From "), "a tried patch doesn't apply, or its text isn't read back");
  sh("git checkout -q -- . && git reset -q --hard", g);
  let conflict;
  try { search.applyTried(g, ["t1", "t2"], hist, join(home, "combo-tmp")); } catch (err) { conflict = err; }
  check(conflict instanceof search.TriedConflict && /t2 doesn't apply on today's champion after t1/.test(conflict.message), `overlapping tried patches: ${conflict}`);
}
const tsrc = readFileSync(join(ROOT, "src/core/tuning.ts"), "utf8");
const lit = (k) => search.knobLiteral(tsrc, k);
check(lit("picture.fill")?.value === DEFAULTS["picture.fill"] && lit("render.pictureBox")?.max === 1 && lit("picture.prompt")?.value === DEFAULTS["picture.prompt"] && lit("draw.prompt")?.value === DEFAULTS["draw.prompt"] && lit("resolve.jevPrompt")?.value === DEFAULTS["resolve.jevPrompt"] && lit("draw.thinkPrompt") && !lit("no.such"), "knobLiteral doesn't read today's defaults (P(role, n) prompt knobs included)");
check(lit("picture.prompt").set(1) === 'P("picture", 1)' && /K\("picture\.fill", 0\.75, /.test(lit("picture.fill").set(0.75)), "knobLiteral doesn't write a new default");
const sw = search.cardStates(5, [kc({ kind: "knob", knobs: { "picture.fill": 1 } }), kc({ kind: "sweep", change: "fill", sweep: { knob: "picture.fill", values: [1, 0.6, 0.95, DEFAULTS["picture.fill"]] } }), kc({ kind: "sweep", sweep: { knob: "no.such", values: [1] } })], tsrc);
const vals = sw.cards.filter((c) => c.sweep).map((c) => `${c.id}=${c.card.knobs["picture.fill"]}`).join();
check(sw.cards[0].id === "e5-h1" && vals === "e5-h2a=0.95,e5-h2b=1,e5-h2c=0.6" && sw.cards.every((c) => c.card.kind !== "sweep") && sw.dropped.length === 1 && /e5-h3/.test(sw.dropped[0]), `a sweep isn't run as knob cards nearest the champion's value first (the champion's own value left out): ${vals}; ${sw.dropped}`);
check(sw.cards.filter((c) => c.sweep).every((c) => c.card.sweep?.values.join() === "0.95,1,0.6"), "a sweep's knob cards don't carry the values run, which share its error");
const verdictMod = await import("../loop/verdict.ts");
check(verdictMod.sweepShift(1) === 0 && Math.abs(verdictMod.sweepShift(4) - 0.606) < 0.01 && verdictMod.sweepShift(2) < verdictMod.sweepShift(3), `a sweep's keep line isn't raised by its values (LOOP-V2.md D3): ${[1, 2, 3, 4].map(verdictMod.sweepShift)}`);
// A hedge (copies of a call) goes live on every scanned case, none from the cache: a scan or a replay can't see a copy.
const { hedgeScan } = await import("../loop/decide.ts");
const scanned = { run: "s", class: "N", mismatch: false, cases: [{ case: "c1", set: "tuning", affected: false }, { case: "c2", set: "heldout-gate", affected: false }], affected: {}, cached: ["h1"] };
const hedged = hedgeScan({ knobs: { "draw.copies": 2 } }, scanned);
check(hedged.class === "Q" && hedged.affected.tuning?.join() === "c1" && hedged.affected["heldout-gate"]?.join() === "c2" && !hedged.cached.length
  && hedgeScan({ knobs: { "draw.thinkYes": 0.8 } }, scanned) === scanned && hedgeScan({ knobs: { "picture.copyAfterMs": 400 } }, { ...scanned, class: "Q" }).cached.length === 1
  && hedgeScan({ kind: "code" }, scanned, ["jev.copies"]).class === "Q" && hedgeScan({ kind: "code" }, scanned, ["jev.model"]) === scanned,
  `a hedge card isn't measured live on every scanned case, or another card is: ${JSON.stringify(hedged)}`);
const [a, b, c2] = sw.cards.filter((c) => c.sweep);
const row = (id, verdict, looks, o = {}) => ({ id, verdict, class: "Q", reasons: [`Rule F at look ${16 * looks}`], looks: Array.from({ length: looks }, () => ({ n: 16, decisive: 10, z: -1.5 })), ...o });
const aLost = sw.cards.map((c) => (c === a ? { ...c, status: "done", verdict: "revert" } : c));
check(search.sweepSkip(sw.cards, b, []) === undefined, "a sweep value is skipped before anything was decided");
check(/pruned: e5-h2a/.test(search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 1)]) ?? ""), "a value beyond a clear first-look loss on its side isn't pruned");
// Why a decision went its way is read off its codes; a row written before them, off its reasons' words.
check(/pruned: e5-h2a/.test(search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 3, { codes: ["latency"], reasons: ["latency veto: surely slower (p 0.010 over every deciding stat), most on ttfd ×1.10"] })]) ?? "")
  && /pruned: e5-h2a/.test(search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 3, { reasons: ["latency veto: ttfd ×1.1"] })]) ?? ""), "a vetoed value, with codes or before them, doesn't prune the values beyond it");
check(search.sweepSkip(aLost, b, [row("e5-h2a", "void", 1)]) === undefined && search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 3, { codes: [], reasons: ["latency veto: ttfd ×1.1"] })]) === undefined,
  "a void, or a row whose codes say no veto whatever its words, prunes the values beyond it");
check(search.sweepSkip(aLost, c2, [row("e5-h2a", "revert", 1)]) === undefined, "a value on the other side of a loss is pruned");
check(search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 3)]) === undefined && search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 1, { class: "N" })]) === undefined, "a late loss or a no-effect value prunes the values beyond it");
check(search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 1, { looks: [{ n: 16, decisive: 10, z: -0.3 }] })]) === undefined, "a first-look revert that isn't a clear loss (Z -0.3) prunes the values beyond it");
// A latency value prunes only on a veto: its first-look revert is often noise, and its fidelity Z says nothing of speed.
check(search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 1, { goal: "latency", looks: [{ n: 16, decisive: 10, z: -1.5 }] })]) === undefined, "a latency value's first-look revert (noise 44% of the time) pruned the values beyond it");
check(/pruned: e5-h2a/.test(search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 2, { goal: "latency", reasons: ["latency veto: ttfd ×1.09"] })]) ?? ""), "a latency value's veto doesn't prune the values beyond it");
check(search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 3, { goal: "latency", reasons: ["Rule F keep at look 48", "held-out: ttfd ×1.004 isn't faster"] })]) === undefined && search.sweepSkip(aLost, b, [row("e5-h2a", "revert", 3, { goal: "latency", codes: ["floor"], reasons: ["fidelity Z -0.80 < -0.5"] })]) === undefined, "G3's direction rule or a fidelity floor on a latency value pruned the values beyond it");
check(/the sweep kept e5-h2a/.test(search.sweepSkip(sw.cards.map((c) => (c === a ? { ...c, status: "done", verdict: "keep" } : c)), c2, []) ?? ""), "a keep doesn't end its sweep");
const dec = (id, o) => ({ id, kind: "card", verdict: "revert", class: "Q", goal: "fidelity", reasons: ["Rule F at look 48"], counts: { wins: 20, losses: 15, ties: 13, exactTies: 0 }, looks: [{ n: 16 }, { n: 32 }, { n: 48 }], latency: { ttfc: { est: 1 }, ttd: { est: 1 }, ttfd: { est: 0.97 } }, card: { kind: "knob", component: "draw", change: id }, ...o });
// Every decision, newest first, with why it went the way it did (the tried index and the ledger said only "revert").
const lines5 = decisionLines([dec("w1"), dec("w5", { goal: "latency", reasons: ["latency: ttfd ×0.97 (p slower 0.4, p faster 0.2)"], counts: { wins: 0, losses: 0, ties: 48 } }), { ...dec("o1"), kind: "owner-step" }]);
check(lines5.length === 2 && /^- w5 .*latency: .* → revert: latency: ttfd ×0\.97 .*\(0-0-48, first drawing ×0\.970/.test(lines5[0]) && /^- w1 .* → revert: Rule F at look 48 \(20-15-13/.test(lines5[1]), `the decision lines: ${lines5.join(" | ")}`);
const nd = analystDigest({ championSha: "champ", checkpoint: { run: "cp1", champion: "A" }, decisions: lines5 });
check(nd.includes("# 5. Every decision so far, newest first") && nd.indexOf("# 5.") > nd.indexOf("# 2. Where the champion fails"), "the analyst's digest lacks every decision, after the champion's misses");

// ---- The engineer's canUseTool
const repo = p.repo;
mkdirSync(join(repo, "src/core"), { recursive: true });
mkdirSync(join(repo, "node_modules"), { recursive: true });
writeFileSync(join(repo, "src/core/x.ts"), "export const x = 1;\n");
writeFileSync(join(repo, ".gitignore"), "node_modules\n");
sh('git init -q -b loop/champion && git add -A && git -c user.email=c@x -c user.name=c commit -qm champion', repo);
const { worktreeOf } = await import("../loop/trees.ts");
const wt = worktreeOf("cand/e1-h0");
const can = engineerCanUseTool(wt);
const opts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
const allowed = async (tool, input) => (await can(tool, input, opts)).behavior === "allow";
for (const [tool, input] of [["Read", { file_path: "/etc/hostname" }], ["Read", { file_path: join(wt, "evals/loop/run.ts") }], ["Read", { file_path: "src/core/../../package.json" }], ["Read", { file_path: join(wt, "src/core/.env") }],
  ["Edit", { file_path: join(wt, "dev/claude.ts"), old_string: "a", new_string: "b" }], ["Edit", { file_path: join(wt, "src/core/speech.ts"), old_string: "a", new_string: "b" }], ["Glob", { pattern: "**/*.ts" }], ["Glob", { pattern: "../**", path: join(wt, "src/core") }],
  ["Grep", { pattern: "x", path: wt }], ["Write", { file_path: join(wt, "src/core/x.ts"), content: "" }], ["Write", { file_path: join(wt, "src/new.ts"), content: "" }], ["WebFetch", { url: "https://x" }], ["Task", {}]])
  check(!(await allowed(tool, input)), `the engineer may ${tool} ${JSON.stringify(input)}`);
for (const [tool, input] of [["Read", { file_path: join(wt, "src/core/x.ts") }], ["Read", { file_path: "src/core/x.ts" }], ["Edit", { file_path: join(wt, "src/core/x.ts"), old_string: "1", new_string: "2" }], ["Write", { file_path: join(wt, "src/core/newfile.ts"), content: "" }], ["Grep", { pattern: "x", path: "src/core" }], ["Glob", { pattern: "**/*.ts", path: join(wt, "src/core") }]])
  check(await allowed(tool, input), `the engineer may not ${tool} ${JSON.stringify(input)}`);
for (const cmd of ["npx tsc --noEmit", "./node_modules/.bin/tsc --noEmit && curl http://x", "./node_modules/.bin/tsc --noEmit; rm -rf src", "git push", "git diff --output=/tmp/x", "git diff ../..", "rm -rf src/core", "node -e 1", "cat /etc/passwd", "node --permission --allow-fs-read=. --import ./evals/loop/node-hooks.mjs scripts/tune.ts sets/a.json --out /tmp/x", "node --permission --allow-fs-read=. --import ./evals/loop/node-hooks.mjs scripts/tune.ts ../x.json", "node --permission --allow-fs-read=. --import ./evals/loop/node-hooks.mjs scripts/tune.ts /etc/passwd", "node --permission --allow-fs-read=. --import ./evals/loop/node-hooks.mjs scripts/tune.ts sets/a.json --allow-synth", "./node_modules/.bin/tsc --noEmit $(id)", "node --import ./evals/loop/node-hooks.mjs scripts/tune.ts sets/a.json", "node --permission --allow-fs-read=/ --import ./evals/loop/node-hooks.mjs scripts/tune.ts sets/a.json"])
  check(!(await allowed("Bash", { command: cmd })), `the engineer may run ${cmd}`);
for (const cmd of ["./node_modules/.bin/tsc --noEmit", "git diff", "git status", "git diff --stat src/core/x.ts", "node --permission --allow-fs-read=. --import ./evals/loop/node-hooks.mjs scripts/tune.ts sets/marks.json --parts marks,arrow"])
  check(await allowed("Bash", { command: cmd }), `the engineer may not run ${cmd}`);
check(BASH_ALLOW.some((re) => re.test("./node_modules/.bin/tsc --noEmit")) && !BASH_ALLOW.some((re) => /npx/.test(re.source)), "the allowlist isn't tsc without npx");
check(JSON.stringify(CAPS) === JSON.stringify({ analyst: { turns: 60, minutes: 25, usd: 8 }, critic: { turns: 30, minutes: 12, usd: 2.5 }, engineer: { turns: 60, minutes: 25, usd: 4 } }), `CAPS ${JSON.stringify(CAPS)}`);

// ---- Agents on the fake API: the turn, $ and minute caps, cards, refused tools
const token = { slot: 1, token: "sk-ant-oat01-fake-t18" };
const mockOf = (api) => ({ baseUrl: api.url, deadProxyPort: PORTS.closed });
const script = (name, turns) => (put(join(home, "scripts", name), turns), join(home, "scripts", name));
const tool = (name, input, i) => ({ content: [{ type: "text", text: `step ${i}` }, { type: "tool_use", id: `toolu_${name}_${i}`, name, input }] });
const globs = Array.from({ length: 12 }, (_, i) => tool("Glob", { pattern: "*.md", path: tree }, i));
const card = (id, kind, o = {}) => ({ id, component: "draw", kind, change: "c", ...(kind === "knob" ? { knobs: { "draw.mapWords": 30 } } : {}), goal: "fidelity", classGuess: "Q", dialogue: false, isPatch: false, touchesFrozen: false, risk: "r", files: ["src/core/draw.ts"], ...o });
const cards = [card("h1", "code"), card("h2", "knob"), card("h3", "bogus"), card("h4", "code"), card("h5", "knob"), card("h6", "code"), card("h7", "code"), card("h8", "sweep", { sweep: { knob: "draw.mapWords", values: [20, 40] } })];
const sessions = [];
const run = async (api, o) => {
  const r = await critic({ run: "e1", token, mockApi: mockOf(api), analysis: "{}", digest: "d", tried: [], tree, ...o });
  sessions.push({ api, turns: r.result.turns });
  return r;
};
const apiA = await startFakeApi({ port: PORTS.fakeA, script: script("globs.json", globs) });
const capped = await run(apiA, { caps: { turns: 3, minutes: 1, usd: 5 } });
check(capped.result.stop === "turns" && capped.result.turns === 3 && !capped.cards.length, `the turn cap: ${JSON.stringify(capped.result)}`);
const perTurn = capped.result.usd / capped.result.turns;
const pricey = await run(apiA, { caps: { turns: 20, minutes: 1, usd: perTurn * 1.5 } });
check(pricey.result.stop === "usd" && pricey.result.turns >= 1 && pricey.result.turns <= 3 && pricey.result.usd >= perTurn * 1.5, `the $ cap: ${JSON.stringify(pricey.result)} (per turn ${perTurn})`);
await apiA.close();
const apiB = await startFakeApi({ port: PORTS.fakeB, mode: "slow", slowMs: 4000, script: script("globs2.json", globs) });
const t0 = Date.now();
const slow = await run(apiB, { caps: { turns: 20, minutes: 0.02, usd: 5 } });
check(slow.result.stop === "minutes" && Date.now() - t0 < 4000, `the minute cap: ${JSON.stringify(slow.result)} after ${Date.now() - t0} ms`);
await apiB.close();
// The answer in two text blocks (e85's critic: the result's text is the last block alone, which lost the list's "[").
const said = `Here are the cards:\n\`\`\`json\n${JSON.stringify(cards)}\n\`\`\``, half = said.length >> 1;
const apiC = await startFakeApi({ port: PORTS.fakeA, script: script("cards.json", [tool("Glob", { pattern: "*.md", path: tree }, 0), { content: [{ type: "text", text: said.slice(0, half) }, { type: "text", text: said.slice(half) }] }]) });
const good = await run(apiC, {});
check(good.result.stop === "done" && good.cards.map((c) => c.id).join() === "h1,h2,h4,h5,h6,h7" && good.dropped.some((d) => /h3: kind bogus/.test(d)) && good.dropped.some((d) => /h8: over the 6-card limit/.test(d)), `the critic's cards: ${JSON.stringify({ cards: good.cards.map((c) => c.id), dropped: good.dropped, r: good.result })}`);
await apiC.close();
const apiD = await startFakeApi({ port: PORTS.fakeA, script: script("engineer.json", [tool("Read", { file_path: "/etc/hostname" }, 0), tool("Write", { file_path: "src/core/x.ts", content: "export const x = 2;\n" }, 1), tool("Bash", { command: "npx tsc --noEmit" }, 2), tool("Read", { file_path: "src/core/x.ts" }, 3), { content: [{ type: "text", text: "Changed nothing: a check." }] }]) });
const eng = await engineer({ run: "e1", token, mockApi: mockOf(apiD), card: card("h9", "code"), branch: "cand/e1-h9" });
sessions.push({ api: apiD, turns: eng.turns });
check(eng.stop === "done" && eng.text === "Changed nothing: a check." && eng.wt === p.worktree("cand/e1-h9") && existsSync(join(eng.wt, "node_modules")), `the engineer's session: ${JSON.stringify(eng)}`);
check(eng.denied.length === 3 && /^Read .*hostname/.test(eng.denied[0]) && /^Write .*Edit/.test(eng.denied[1]) && /^Bash .*npx/.test(eng.denied[2]) && readFileSync(join(eng.wt, "src/core/x.ts"), "utf8") === "export const x = 1;\n", `the engineer's refused tools: ${JSON.stringify(eng.denied)}`);
await apiD.close();
// The analyst: a read-only session that may search the web and read public pages, never this machine or its network.
const web = toolRule(tree, { root: tree, edit: false });
check(!web("WebSearch", { query: "model routing cascades" }) && !web("WebFetch", { url: "https://arxiv.org/abs/2404.14618", prompt: "p" }) && ["http://127.0.0.1:5400/status", "http://100.94.227.92:5182/", "http://localhost:5182/", "https://pgx.tail1a2b.ts.net/", "http://[::1]/", "file:///etc/passwd"].every((url) => web("WebFetch", { url, prompt: "p" })), "the web rule: search and public pages open, this machine and its network shut");
const apiF = await startFakeApi({ port: PORTS.fakeA, script: script("analyst.json", [tool("WebFetch", { url: "http://100.94.227.92:5182/", prompt: "the sends" }, 0), { content: [{ type: "text", text: '{"components": [], "hypotheses": [{"component": "draw"}]}' }] }]) });
const agentsBefore = readMeter(p.calls).filter((l) => l.agent).length;
const an = await analyst({ run: "e1", token, mockApi: mockOf(apiF), digest: "d", tree });
// An agent's replies get the eval roles' output, not the product's 4096 tokens (e86's analyst ran out thinking).
check(apiF.requests.every((r) => r.maxTokens === 128_000), `the analyst's requests ask for ${apiF.requests.map((r) => r.maxTokens)} output tokens, not 128000`);
check(an.includes('"hypotheses"') && apiF.requests.length === 2 && readMeter(p.calls).filter((l) => l.agent).length === agentsBefore + 1, `the analyst's session: ${an} (${apiF.requests.length} requests)`);
await apiF.close();
for (const s of sessions) check(s.api.requests.length === sessions.filter((x) => x.api === s.api).reduce((a, x) => a + x.turns, 0), `a fake API got ${s.api.requests.length} requests for ${s.turns} turns`);
const agentLines = readMeter(p.calls).filter((l) => l.agent);
check(agentLines.length === 6 && agentLines.every((l) => l.token === 1 && l.model === (l.role === "analyst" ? "claude-opus-5-5" : "claude-sonnet-5-5") && l.turns > 0 && l.totalCostUsd > 0 && l.usage.cacheWrite1h === 0) && agentLines.map((l) => l.role).join() === "critic,critic,critic,critic,engineer,analyst", `the agents' meter lines: ${JSON.stringify(agentLines)}`);
// A connection dropped mid-reply ends the session on an "API Error" answer (e89's analyst: ECONNRESET, so its critic read
// that as the analysis and the epoch had no cards): the session runs once more.
const apiG = await startFakeApi({ port: PORTS.fakeA, script: script("analyst-drop.json", [{ content: [{ type: "text", text: '{"components": [], "hypotheses": [{"component": "shot"}]}' }], drop: 3 }]) });
const anG = await analyst({ run: "e1", token, mockApi: mockOf(apiG), digest: "d", tree });
check(anG.includes('"shot"') && apiG.requests.filter((r) => r.dropped).length === 3, `after a dropped connection the analyst answered ${anG.slice(0, 160)} (${apiG.requests.length} requests, ${apiG.requests.filter((r) => r.dropped).length} dropped)`);
await apiG.close();

// ---- The failure analyst: one gateway call, on the gateway's token slot
mkdirSync(join(home, "replies"));
writeFileSync(join(home, "replies", `failure.${sha12(prompts.FAILURE_SYSTEM)}.txt`), 'Here: [{"case": "c1", "component": "draw", "evidence": "e", "tag": "t"}]');
const apiE = await startFakeApi({ port: PORTS.fakeC, replies: join(home, "replies") });
const tokensFile = join(home, "config", "tokens.env");
put(tokensFile, "RT_EVAL_TOKEN_1=sk-ant-oat01-fake-t18-gw\n");
chmodSync(tokensFile, 0o600);
const gw = await spawnGateway({ home, port: PORTS.gateway, tokens: tokensFile, mockApi: apiE.url, cap: 5 });
try {
  const f = await failureAnalyst(fd, "e1");
  check(f.length === 1 && f[0].component === "draw", `the failure analyst's notes: ${JSON.stringify(f)}`);
  const t = await slotToken([{ slot: 1, token: "sk-ant-oat01-fake-t18-gw" }]);
  check(t.slot === 1, "slotToken didn't pick the gateway's current slot");
  const st = await gatewayStatus();
  check(st.calls === 1 && apiE.requests.length === 1 && apiE.requests.map((r) => r.role).join() === "failure", `the gateway made ${st.calls} calls, the fake API got ${apiE.requests.length} (${apiE.requests.map((r) => r.role)})`);
} finally {
  await gw.close();
  await apiE.close();
}
const lines = readMeter(p.calls).filter((l) => !l.agent);
check(lines.length === 1 && lines.map((l) => l.role).join() === "failure" && lines.every((l) => l.token === 1 && l.cacheWrite1h === 0), `the gateway's meter lines: ${JSON.stringify(lines)}`);
check(!readFileSync(p.calls, "utf8").includes("sk-ant"), "a token reached the meter");
finish();
