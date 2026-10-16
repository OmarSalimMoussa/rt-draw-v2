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
import { systemPrompt } from "../core/driver.ts";
import { SYSTEM as JUDGE_SYSTEM } from "../judge/prompts.ts";
import { paths } from "../loop/paths.ts";
import { stubReply } from "../loop/stubs.ts";
import { ANALYST_SYSTEM, FAILURE_SYSTEM } from "../optimizer/prompts.ts";
import { startFakeApi } from "./fake-api.ts";

/** Median ms, first-text ms and output tokens per role: CONTEXT.md's logged v2 calls, §6.1 where none were logged. */
const MEDIANS: Record<string, [number, number, number]> = {
  draw: [5060, 2935, 388], "draw-refs": [3576, 2927, 454], picture: [6911, 2176, 662], driver: [3759, 2900, 189],
  judge: [2900, 2200, 210], failure: [12000, 3000, 800], analyst: [12000, 3000, 800], probe: [900, 700, 2],
};
/** Spread around each median, so paired latencies vary as real ones do. */
const SPREAD = [0.7, 0.85, 1, 1.2, 1.5];

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

/** The stored driver replies predate `meant` (they say `intent`): renamed, or V6 voids every send as "meant is empty". */
function meant(reply: string): string {
  try {
    const { intent, ...turn } = JSON.parse(reply);
    return JSON.stringify(intent === undefined ? turn : { ...turn, meant: turn.meant ?? intent });
  } catch {
    return reply; // prose around the object: parseTurn's job, as with a real reply
  }
}

/** One reply for every judge role (they share a system prompt): a verdict, an expectation and a miss check. */
const judgeReplies = () =>
  ["left", "right", "left", "tie", "right", "left", "right"].map((winner, i) =>
    JSON.stringify({ winner, confidence: [2, 3, 1, 2, 3, 2, 3][i], why: `dry ${winner}`, should: ["the asked change is made"], mustNot: ["nothing else moves"], met: ["yes", "partly", "no", "yes"][i % 4] }));

export function writeDry(dir: string) {
  const replies = join(dir, "replies");
  mkdirSync(replies, { recursive: true });
  const put = (role: string, system: string, texts: string[]) => writeFileSync(join(replies, `${role}.${sha12(system)}.json`), JSON.stringify(texts));
  for (const v of PROMPTS.draw) put("draw", v.system(true, SCREEN.w, SCREEN.h, 0, SCREEN.w), drawReplies());
  for (const v of PROMPTS.resolve) put("draw-refs", v.system, ['{"refs": []}']);
  for (const v of PROMPTS.picture) put("picture", v.system(DEFAULTS), [stubReply("picture")]);
  put("driver", systemPrompt(), readFileSync(DRIVER_REPLIES, "utf8").split("\n").filter(Boolean).map((l) => meant((JSON.parse(l) as { reply: string }).reply)));
  put("judge", JUDGE_SYSTEM, judgeReplies());
  put("failure", FAILURE_SYSTEM, ["[]"]);
  put("analyst", ANALYST_SYSTEM, ["dry run: nothing to propose"]);
  put("probe", "Answer with one word.", ["ready"]);
  const latency = join(dir, "latency.jsonl");
  writeFileSync(latency, Object.entries(MEDIANS).flatMap(([from, [ms, firstMs, outTokens]]) => SPREAD.map((k) => JSON.stringify({ from, ms: Math.round(ms * k), firstMs: Math.round(firstMs * k), outTokens, waitMs: 0 }))).join("\n") + "\n");
  const tokens = join(dir, "tokens.env");
  writeFileSync(tokens, [1, 2, 3].map((n) => `RT_EVAL_TOKEN_${n}=sk-ant-oat01-dry-run-${n}-${randomBytes(6).toString("hex")}`).join("\n") + "\n", { mode: 0o600 });
  return { replies, latency, tokens };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--port");
  const dir = join(paths().home, "dry");
  const { replies, latency, tokens } = writeDry(dir);
  const api = await startFakeApi({ port: i > 0 ? Number(process.argv[i + 1]) : 0, replies, latency });
  console.log(`READY ${api.url} (tokens ${tokens}, latency ${latency})`);
}
