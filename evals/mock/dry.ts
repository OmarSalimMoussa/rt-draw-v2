// The fake API for a dry run (evals/README.md, "Rehearsing at 0 calls"): every role the chain
// calls (product draw, resolver and pictures, driver, judges, failure analyst, analyst, probe)
// answered with canned replies by its system prompt (fake-api.ts --replies), on the real median
// timings of v2's logged calls (CONTEXT, §6.1) per role (--latency), so the bank, checkpoint,
// calibration and loop steps run their whole path at real speed and 0 real calls.
//   node --import ./evals/loop/node-hooks.mjs evals/mock/dry.ts [--port n]
// writes $RT_EVAL_HOME/dry/{replies/, latency.jsonl, tokens.env (3 fake tokens, mode 600)},
// prints "READY <url>" and serves until killed; GET <url>/_log lists every request with its role.
// Not answered: the critic's and engineer's tool sessions (the seed cards need neither).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCREEN } from "../../src/core/board.ts";
import { PROMPTS } from "../../src/core/prompts.ts";
import { DEFAULTS } from "../../src/core/tuning.ts";
import { HEDGE, systemPrompt } from "../core/driver.ts";
import { SYSTEM as JUDGE_SYSTEM } from "../judge/prompts.ts";
import { paths } from "../loop/paths.ts";
import { stubReply } from "../loop/stubs.ts";
import { ANALYST_SYSTEM, FAILURE_SYSTEM } from "../optimizer/prompts.ts";
import { startFakeApi } from "./fake-api.ts";

/**
 * Median ms, first-text ms and output tokens per role: CONTEXT.md's logged v2 calls, §6.1 where none were logged, and the
 * resolver with thinking off from §6.5's real pilot (first text 1.2 s). One line each, no spread: in turn, a spread
 * handed the two arms different draws of it, and a no-op read 1.2× slower.
 */
const MEDIANS: Record<string, [number, number, number]> = {
  draw: [5060, 2935, 388], "draw-refs": [3576, 2927, 454], "draw-refs:off": [1850, 1200, 454], picture: [6911, 2176, 662], driver: [3759, 2900, 189],
  judge: [2900, 2200, 210], failure: [12000, 3000, 800], analyst: [12000, 3000, 800], probe: [900, 700, 2],
};

const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const DRIVER_REPLIES = fileURLToPath(new URL("../checks/data/driver-replies.jsonl", import.meta.url));

/** Drawing replies in turn: 0, 1, 2 and 3 new pictures (1.5 a send, §6's assumed row), new ids so every reply changes the page. */
function drawReplies(): string[] {
  const subjects = ["toy robot", "red kite", "teddy bear", "spinning top"];
  return Array.from({ length: 12 }, (_, k) => {
    const n = k % 4;
    const lines = [`shape(dry-note-${k}, rect, ${120 + 40 * n} ${160 + 30 * n} 420 80, "a short note card the dry run adds", fill:${["#ffe3e3", "#d0ebff", "#d3f9d8", "#fff3bf"][n]})`, `text(dry-note-${k}, "Note ${k}")`];
    for (let j = 0; j < n; j++) lines.push(`shape(dry-pic-${k}-${j}, rect, ${120 + 300 * j} 320 240 200, "a framed picture of a ${subjects[j]}", stroke:none)`, `drawing(dry-pic-${k}-${j}, "${subjects[j]}")`);
    return lines.join("\n");
  });
}

/**
 * The stored driver replies predate `meant` (they say `intent`): renamed, or V6 voids every send as "meant is empty".
 * None stops, so a rehearsal's sessions run their planned sends (8 of 80 stopped, and a smoke session ended after one),
 * and hedged ones are left out (V5 voids them in held-out sets, so the small yardstick's size would vary run to run).
 */
function meant(reply: string): string {
  try {
    const { intent, ...turn } = JSON.parse(reply);
    return JSON.stringify({ ...turn, meant: turn.meant ?? intent, stop: false });
  } catch {
    return reply; // prose around the object: parseTurn's job, as with a real reply
  }
}

/**
 * One reply for every judge role (they share a system prompt): a verdict, an expectation and a miss check. Always a tie:
 * canned left/right picks can't follow the arms when the second order swaps them, so they flipped on half the audited
 * cases and voided checkpoint 0.
 */
const judgeReplies = () =>
  ["yes", "partly", "no", "yes"].map((met) => JSON.stringify({ winner: "tie", confidence: 2, why: "dry: both alike", should: ["the asked change is made"], mustNot: ["nothing else moves"], met }));

/** The dry run's files in `dir`; with `pictures` (0–3), every drawing reply adds that many (the ladder's fixed shape). */
export function writeDry(dir: string, o: { pictures?: number } = {}) {
  const replies = join(dir, "replies");
  mkdirSync(replies, { recursive: true });
  const put = (role: string, system: string, texts: string[]) => writeFileSync(join(replies, `${role}.${sha12(system)}.json`), JSON.stringify(texts));
  const draws = drawReplies();
  for (const v of PROMPTS.draw) put("draw", v.system(true, SCREEN.w, SCREEN.h, 0, SCREEN.w), o.pictures === undefined ? draws : [draws[o.pictures]]);
  for (const v of PROMPTS.resolve) put("draw-refs", v.system, ['{"refs": []}']);
  for (const v of PROMPTS.picture) put("picture", v.system(DEFAULTS), [stubReply("picture")]);
  const driver = readFileSync(DRIVER_REPLIES, "utf8").split("\n").filter(Boolean).map((l) => meant((JSON.parse(l) as { reply: string }).reply));
  put("driver", systemPrompt(), driver.filter((r) => !HEDGE.test(JSON.parse(r).meant ?? "")));
  put("judge", JUDGE_SYSTEM, judgeReplies());
  put("failure", FAILURE_SYSTEM, ["[]"]);
  put("analyst", ANALYST_SYSTEM, ["dry run: nothing to propose"]);
  put("probe", "Answer with one word.", ["ready"]);
  const latency = join(dir, "latency.jsonl");
  writeFileSync(latency, Object.entries(MEDIANS).map(([role, [ms, firstMs, outTokens]]) => {
    const [from, off] = role.split(":");
    return JSON.stringify({ from, ...(off ? { thinking: "off" } : {}), ms, firstMs, outTokens, waitMs: 0 });
  }).join("\n") + "\n");
  const tokens = join(dir, "tokens.env");
  writeFileSync(tokens, [1, 2, 3].map((n) => `RT_EVAL_TOKEN_${n}=sk-ant-oat01-dry-run-${n}-${randomBytes(6).toString("hex")}`).join("\n") + "\n", { mode: 0o600 });
  return { replies, latency, tokens };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--port");
  const dir = join(paths().home, "dry");
  const { replies, latency, tokens } = writeDry(dir);
  // Replies by prompt, not in turn: in turn, two arms sending one prompt got alternate replies, and a dry draw.noThink read 6% slower.
  const api = await startFakeApi({ port: i > 0 ? Number(process.argv[i + 1]) : 0, replies, latency, pick: "hash" });
  console.log(`READY ${api.url} (tokens ${tokens}, latency ${latency})`);
}
