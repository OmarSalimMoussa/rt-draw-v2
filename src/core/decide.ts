// Jev's typed questions (TypeSafe AI's decision model, through /api/model like
// any call): many yes/no answers about one state in a single call of about a
// tenth of a second, each a calibrated probability. The wording of every
// question is a prompt like any other (src/core/prompts.ts), so the loop can
// tune it.
import { type JevVersion, type ModelStats, callModel } from "./model.ts";
import type { TraceContext } from "./trace.ts";

/** A yes/no question: `criteria` says what counts as each answer. */
export type YesNo = { type: "noul"; instructions: string; criteria: { yes: string; no: string } };
export type Decision = { yes: Record<string, number | undefined>; stats: ModelStats; reply: string; prompt: { user: string } };

export async function decide(version: JevVersion, state: unknown, questions: Record<string, YesNo>, from: string, parent?: TraceContext): Promise<Decision> {
  const user = JSON.stringify({ state, questions }, null, 1);
  const { text, stats } = await callModel({ model: version, system: "", user, from }, undefined, undefined, parent);
  return { yes: yesOf(text), stats, reply: text, prompt: { user } };
}

/** Each answer's probability of yes, by question id; undefined where the reply has none. */
export function yesOf(reply: string): Record<string, number | undefined> {
  let answers: Record<string, { noul?: unknown }> = {};
  try {
    answers = JSON.parse(reply) as typeof answers;
  } catch {}
  return Object.fromEntries(Object.entries(answers ?? {}).map(([k, v]) => [k, typeof v?.noul === "number" ? v.noul : undefined]));
}
