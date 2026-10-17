// G0, the free gates every candidate passes before any paid stage (spec §1.2, §8.4):
// the path and UX gate, the magic-number lint, no new network or speech, no patch
// default changed, then ./node_modules/.bin/tsc in the candidate's tree (which holds
// the harness's evals/, so a broken bridge contract fails here) and, when scene.ts
// changed, every banked before-scene through the candidate's Scene.fromJSON. 0 model
// calls. "owner" findings go to the owner list and never back to an engineer
// ($1.5–2.5 a session): the contract, the frozen side and the bank are the owner's.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { KNOBS } from "../../src/core/tuning.ts";
import { paths } from "../loop/paths.ts";
import type { HypothesisCard } from "../loop/types.ts";

/** A diff here goes to the owner list: the measuring side, and what an arm never runs (its vite.config.ts and dev/). */
export const FROZEN = ["evals/**", "dev/**", "vite.config.ts", "package.json", "package-lock.json", "tsconfig.json", "src/fixtures/**", "scripts/**", "playgrounds/**"];
/** A diff here is rejected: the editor's look and feel is never the loop's to change. */
export const UX = ["src/ui.ts", "src/ui.css", "src/modal.ts", "src/boardStage.ts", "src/callsView.ts", "src/latencyView.ts", "src/fonts/**", "index.html", "playgrounds/*/index.html"];
/** The only place a candidate may change, minus speech (no voice in the loop). */
export const ALLOWED = "src/core/**";
const SPEECH = "src/core/speech.ts";
/** Where src/core keeps its numbers: anywhere else a new literal must become a knob. */
const NUMBER_HOMES = ["src/core/tuning.ts", "src/core/prompts.ts"];
/** The children's env: this node first on PATH (tsc's shebang wants a node; a systemd unit's PATH may have none). */
const env = () => ({ PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "" });
/** Literals that are arithmetic, not decisions (−1 is a 1 after a minus). */
const PLAIN = new Set([0, 1, 2]);
const SPEECH_WORDS = new Set(["tts", "stt", "scribe"]);
const NETWORK = /\b(WebSocket|EventSource|XMLHttpRequest|sendBeacon)\b/;
/** Ink readers: synthetic ink alone can't be trusted for them (§8.4). */
const INK_PARTS = ["marks", "arrow", "hit", "link"];

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);
const matches = (path: string, patterns: string[]) => patterns.some((p) => glob(p).test(path));

export type FileDiff = { path: string; from?: string; added: string[]; removed: string[] };
export type Finding = { verdict: "reject" | "owner"; why: string };
export type G0Result = { verdict: "pass" | "reject" | "owner"; reasons: string[]; /** set when scene.ts changed */ scenes?: { loaded: number; failed: string[] } };

/** A unified diff (git diff) per file: its path (and a rename's source), added and removed lines. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let f: FileDiff | undefined;
  let hunk = false;
  for (const line of text.split("\n")) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      files.push((f = { path: head[2], ...(head[1] !== head[2] ? { from: head[1] } : {}), added: [], removed: [] }));
      hunk = false;
    } else if (!f) continue;
    else if (line.startsWith("@@")) hunk = true;
    else if (!hunk && line.startsWith("rename from ")) f.from = line.slice(12);
    else if (!hunk && line.startsWith("rename to ")) f.path = line.slice(10);
    else if (hunk && line.startsWith("+")) f.added.push(line.slice(1));
    else if (hunk && line.startsWith("-")) f.removed.push(line.slice(1));
  }
  return files;
}

/** The candidate's diff against its base, as G0 reads it. */
export function diffOf(repo: string, base: string, cand: string): string {
  const r = spawnSync("git", ["-C", repo, "diff", "--no-color", "--no-ext-diff", "-M", base, cand], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git diff ${base} ${cand}: ${r.stderr}`);
  return r.stdout;
}

const touched = (f: FileDiff) => [f.path, ...(f.from ? [f.from] : [])];

export function pathGate(files: FileDiff[]): Finding[] {
  return files.flatMap((f) => touched(f)).flatMap((path): Finding[] => {
    if (matches(path, UX)) return [{ verdict: "reject", why: `UX file ${path}: the editor's look is never the loop's to change` }];
    if (matches(path, FROZEN)) return [{ verdict: "owner", why: `frozen path ${path}: a fix there is the owner's` }];
    if (path === SPEECH) return [{ verdict: "reject", why: `${path}: no voice in the loop` }];
    if (!matches(path, [ALLOWED])) return [{ verdict: "reject", why: `${path} is outside ${ALLOWED}` }];
    return [];
  });
}

/**
 * A line's code with strings, regexes and comments blanked out, and the strings it held. Per line, so a
 * line inside a block comment is recognized by its leading "*".
 */
export function codeOf(line: string): { code: string; strings: string[] } {
  if (/^\s*(\*|\/\*)/.test(line)) return { code: "", strings: [] };
  let code = "";
  const strings: string[] = [];
  const stack: string[] = []; // "`" in a template's text, "{" in code inside ${} or braces within it
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (stack.at(-1) === "`") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && line[i + 1] === "{") (stack.push("{"), i++);
      else strings[strings.length - 1] += c;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") break;
    if (c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
      code += " ";
    } else if (c === '"' || c === "'") {
      let s = "";
      for (i++; i < line.length && line[i] !== c; i++) s += line[i] === "\\" ? line[++i] : line[i];
      strings.push(s);
      code += " ";
    } else if (c === "`") {
      stack.push("`");
      strings.push("");
      code += " ";
    } else if (c === "/" && /(^|[(,=:[!&|?{};]|\breturn)\s*$/.test(code)) {
      // A regex literal: its quantifiers aren't numbers anyone tunes.
      for (let cls = false, j = i + 1; j < line.length; j++) {
        if (line[j] === "\\") j++;
        else if (line[j] === "[") cls = true;
        else if (line[j] === "]") cls = false;
        else if (line[j] === "/" && !cls) {
          i = j;
          while (/[a-z]/i.test(line[i + 1] ?? "")) i++;
          break;
        }
      }
      code += " ";
    } else {
      if (c === "{" && stack.length) stack.push("{");
      if (c === "}" && stack.at(-1) === "{") {
        stack.pop();
        if (stack.at(-1) === "`") continue;
      }
      code += c;
    }
  }
  return { code, strings };
}

const NUMBER = /(?<![\w$.])(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+)n?(?![\w$])/gi;

/** The doc's lint: a numeric literal other than 0, 1, −1 or 2 added in src/core outside tuning.ts and prompts.ts. */
export function lint(files: FileDiff[]): Finding[] {
  return files
    .filter((f) => f.path.startsWith("src/core/") && /\.[cm]?[jt]s$/.test(f.path) && !NUMBER_HOMES.includes(f.path))
    .flatMap((f) => f.added.flatMap((line) => {
      const bad = (codeOf(line).code.match(NUMBER) ?? []).filter((n) => !PLAIN.has(Number(n.replace(/_|n$/g, ""))));
      return bad.length ? [{ verdict: "reject" as const, why: `magic number ${bad.join(", ")} in ${f.path}: make it a knob in src/core/tuning.ts (range, step, doc): "${line.trim().slice(0, 120)}"` }] : [];
    }));
}

/** Words of an identifier: camelCase, PascalCase and snake_case split. */
const wordsOf = (id: string) => id.split(/_|(?<=[a-z\d])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).map((w) => w.toLowerCase());

/** No voice and no new network: fetch( only to /api/model, no other endpoint, no tts, stt or Scribe identifier, no path into evals/. */
export function networkGate(files: FileDiff[]): Finding[] {
  return files.flatMap((f) => f.added.flatMap((line): Finding[] => {
    const { code, strings } = codeOf(line);
    const out: Finding[] = [];
    const at = `in ${f.path}: "${line.trim().slice(0, 120)}"`;
    if (/\bfetch\s*\(/.test(code) && !strings.includes("/api/model")) out.push({ verdict: "reject", why: `a fetch( to something other than /api/model ${at}` });
    if (NETWORK.test(code)) out.push({ verdict: "reject", why: `new network ${at}` });
    const endpoint = strings.find((s) => /\/api\//.test(s) && s !== "/api/model");
    if (endpoint) out.push({ verdict: "reject", why: `new endpoint ${endpoint} ${at}` });
    const speech = (code.match(/[A-Za-z_$][\w$]*/g) ?? []).find((id) => wordsOf(id).some((w) => SPEECH_WORDS.has(w)));
    if (speech) out.push({ verdict: "reject", why: `speech identifier ${speech} ${at}` });
    // The harness imports src/core in node: product code that reached into evals/ could rewrite the measuring side.
    if (strings.some((x) => /(^|\/)evals\//.test(x))) out.push({ verdict: "reject", why: `product code naming the frozen evals/ ${at}` });
    return out;
  }));
}

/** The Sketchbook look's constants in src/core/render.ts: the font, the paper and the ink. */
const LOOK = /\b(FONT|BOARD|INK)\b/g;
/** Knobs whose low values stop the page looking hand-drawn, and the share of today's default below which that's the owner's. */
const HAND_DRAWN = ["render.roughness", "render.strokeWidth", "picture.roughness"];
const HAND_DRAWN_MIN = 0.8;
/** Where outlines get their wobble and width: set there other than from those knobs, the page can stop looking hand-drawn. */
const OUTLINE_FILES = ["src/core/render.ts", "src/core/picture.ts", "src/core/ops.ts"];
const OUTLINE_SET = /\b(roughness|strokeWidth)\s*(:|=(?!=))/;

/**
 * The editor's look is never the loop's (the owner's hard rule), and only prompt text guarded it: render.ts' FONT, BOARD
 * and INK can't be redefined or dropped, no text gets a font of its own (the grid labels' monospace aside), and these go
 * to the owner (a crisp page could win the craft judge): a hand-drawn knob set under 0.8× today's value, an outline's
 * roughness or width set in render.ts, picture.ts or ops.ts other than from its knob, a dropped read of one of those knobs, and
 * a prompt line about roughness or stroke width (the drawing model's ops can set both per shape).
 */
export function lookGate(files: FileDiff[]): Finding[] {
  const out: Finding[] = [];
  const r = files.find((f) => f.path === "src/core/render.ts");
  const uses = (ls: string[]) => ls.reduce((n, l) => n + (codeOf(l).code.match(LOOK)?.length ?? 0), 0);
  if (r && ([...r.added, ...r.removed].some((l) => /\bconst\s+(FONT|BOARD|INK)\b/.test(l)) || uses(r.added) < uses(r.removed)))
    out.push({ verdict: "reject", why: "src/core/render.ts' FONT, BOARD and INK are the Sketchbook look: the loop never redefines or drops them" });
  for (const f of files.filter((x) => x.path.startsWith("src/core/")))
    for (const l of f.added) if (/font-?family|fontFamily/i.test(l) && !/\bFONT\b|monospace|Excalifont/.test(l)) out.push({ verdict: "reject", why: `a font of its own in ${f.path} (the Sketchbook look is Excalifont): "${l.trim().slice(0, 120)}"` });
  for (const l of files.find((f) => f.path === "src/core/tuning.ts")?.added ?? []) {
    const m = /\bK\("([\w.]+)",\s*(-?[\d.]+)/.exec(l);
    const k = m && HAND_DRAWN.includes(m[1]) ? KNOBS.find((x) => x.key === m[1]) : undefined;
    if (k && Number(m![2]) < HAND_DRAWN_MIN * k.value) out.push({ verdict: "owner", why: `${k.key} ${m![2]} is under ${HAND_DRAWN_MIN}× today's ${k.value}: how hand-drawn the page looks is the owner's` });
  }
  const knobRead = (l: string) => codeOf(l).strings.some((x) => HAND_DRAWN.includes(x));
  for (const f of files.filter((x) => OUTLINE_FILES.includes(x.path)))
    for (const l of f.added) if (OUTLINE_SET.test(codeOf(l).code) && !knobRead(l)) out.push({ verdict: "owner", why: `an outline's roughness or width set without its knob in ${f.path}: "${l.trim().slice(0, 120)}"` });
  const core = files.filter((f) => f.path.startsWith("src/core/") && f.path !== "src/core/tuning.ts");
  const reads = (ls: string[]) => ls.filter(knobRead).length;
  if (reads(core.flatMap((f) => f.added)) < reads(core.flatMap((f) => f.removed))) out.push({ verdict: "owner", why: `a read of ${HAND_DRAWN.join(", ")} dropped: how hand-drawn the page looks is the owner's` });
  for (const l of files.find((f) => f.path === "src/core/prompts.ts")?.added ?? [])
    if (/rough|stroke.?width/i.test(l)) out.push({ verdict: "owner", why: `a prompt line about roughness or stroke width in src/core/prompts.ts: "${l.trim().slice(0, 120)}"` });
  return out;
}

/** Patch knobs are never the loop's to turn on or move: any changed line about them in tuning.ts. */
export function patchGate(files: FileDiff[]): Finding[] {
  const t = files.find((f) => f.path === "src/core/tuning.ts");
  const lines = t ? [...t.added, ...t.removed].filter((l) => /\bpatch/.test(codeOf(l).code + codeOf(l).strings.join(" "))) : [];
  return lines.length ? [{ verdict: "reject", why: `a patches.* knob changed in src/core/tuning.ts (patches are the owner's): "${lines[0].trim().slice(0, 120)}"` }] : [];
}

/** ./node_modules/.bin/tsc --noEmit in the candidate's tree: an error under evals/ is a broken bridge contract. */
export function typecheck(tree: string): Finding[] {
  const r = spawnSync("./node_modules/.bin/tsc", ["--noEmit"], { cwd: tree, encoding: "utf8", env: env(), maxBuffer: 16 << 20 });
  if (r.status === 0) return [];
  const errors = `${r.stdout}${r.stderr}`.split("\n").filter((l) => /^\S.*\(\d+,\d+\): error TS\d+/.test(l));
  const contract = errors.filter((l) => l.startsWith("evals/"));
  if (contract.length) return [{ verdict: "owner", why: `broken bridge contract (the owner moves it: update evals/bridge on master): ${contract.slice(0, 3).join(" | ")}` }];
  return [{ verdict: "reject", why: `typecheck: ${(errors.length ? errors : [`${r.stdout}${r.stderr}`.trim() || `tsc exited ${r.status}`]).slice(0, 3).join(" | ")}` }];
}

/** Every banked case's before-scene. */
export function bankedScenes(): string[] {
  const dir = paths().bankCases;
  return existsSync(dir) ? readdirSync(dir).map((id) => join(dir, id, "before.scene.json")).filter((f) => existsSync(join(f, "..", "done")) && existsSync(f)) : [];
}

// Runs in the candidate's tree, in its own process: the candidate's code never runs inside the harness.
const ROUND_TRIP = `
import { readFileSync } from "node:fs";
const files = JSON.parse(readFileSync(0, "utf8"));
const { Scene } = await import(process.argv[1]);
const failed = [];
for (const f of files) {
  try {
    const text = JSON.stringify(JSON.parse(readFileSync(f, "utf8")));
    if (JSON.stringify(Scene.fromJSON(JSON.parse(text)).toJSON()) !== text) failed.push(f + ": changed by the round trip");
  } catch (e) { failed.push(f + ": " + (e && e.message)); }
}
console.log(JSON.stringify({ loaded: files.length - failed.length, failed }));`;

/**
 * The banked before-scenes through the tree's Scene.fromJSON and back (R4's round trip). The candidate's code runs under
 * node's permission model: it reads its tree and the scenes, writes nothing (evals/, the tokens file) and spawns nothing.
 */
export function sceneRoundTrip(tree: string, files: string[]): { loaded: number; failed: string[] } {
  const reads = [tree, ...new Set(files.map((f) => dirname(dirname(f))))].map((d) => `--allow-fs-read=${d}`);
  const r = spawnSync(process.execPath, ["--permission", ...reads, "--import", join(tree, "evals/loop/node-hooks.mjs"), "--input-type=module", "-e", ROUND_TRIP, pathToFileURL(join(tree, "src/core/scene.ts")).href],
    { cwd: tree, input: JSON.stringify(files), encoding: "utf8", env: env(), maxBuffer: 16 << 20 });
  try {
    return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  } catch {
    return { loaded: 0, failed: [`scene.ts didn't load: ${r.stderr.trim().slice(0, 300)}`] };
  }
}

/**
 * G0 on a candidate: the diff's checks first (cheapest), then, given its tree, the typecheck and the scene round trip.
 * Any finding stops it: a reject wins over an owner item.
 */
export function g0(o: { diff: string; tree?: string; scenes?: string[] }): G0Result {
  const files = parseDiff(o.diff);
  const found = [...pathGate(files), ...lint(files), ...networkGate(files), ...patchGate(files), ...lookGate(files)];
  let scenes: G0Result["scenes"];
  if (!found.length && o.tree) {
    found.push(...typecheck(o.tree));
    if (!found.length && files.some((f) => touched(f).includes("src/core/scene.ts"))) {
      scenes = sceneRoundTrip(o.tree, o.scenes ?? bankedScenes());
      if (scenes.failed.length) found.push({ verdict: "owner", why: `scene format: ${scenes.failed.length} banked before-scenes don't load through the candidate's Scene.fromJSON (${scenes.failed[0]})` });
    }
  }
  return { verdict: found.some((f) => f.verdict === "reject") ? "reject" : found.length ? "owner" : "pass", reasons: found.map((f) => f.why), ...(scenes ? { scenes } : {}) };
}

/**
 * The card rules of §8.4 that send a card to the owner list (the coordinator applies them: a patch or cost
 * question with its A/B evidence, the rest before anything is built).
 */
export function cardOwnerReasons(card: HypothesisCard, o: { u1: boolean }): string[] {
  const keys = Object.keys(card.knobs ?? {});
  const patch = card.isPatch || keys.some((k) => k.startsWith("patches.") || KNOBS.find((x) => x.key === k)?.patches);
  return [
    ...(patch ? ["a patch knob proposed: the owner turns patches on"] : []),
    ...(card.raisesCost ? ["cost-raising change"] : []),
    ...(card.touchesFrozen ? ["needs a frozen area"] : []),
    ...(keys.some((k) => k.endsWith(".model")) ? ["model switch: needs calibration evidence"] : []),
    ...(card.kind === "op" && !card.generality?.trim() ? ["new op without a generality note"] : []),
    ...(!o.u1 && [card.component, ...keys.map((k) => k.split(".")[0])].some((c) => INK_PARTS.includes(c)) ? ["ink-reading change and no U1 to check it on"] : []),
  ];
}
