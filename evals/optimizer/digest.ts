// What the optimizer reads (spec §8.2): digests of at most 40k tokens, built by frozen
// code from what the bank and the runs already hold (0 calls), never with a held-out
// case (only cases whose case.json says "tuning" are ever read). Where the champion
// itself fails comes first: candidate losses alone say what a candidate broke, so
// after the seed cards the analyst would be guessing from noise.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRows } from "../loop/metrics.ts";
import { paths } from "../loop/paths.ts";
import { caseDir, put, runFile } from "../loop/record.ts";
import type { Arm, ArmResult, ArmTiming, CaseInfo, CaseInput, ChampionOutcome, Judged, Meant, Miss, Packet, Rating, Readings, RecordedReply, SpanJSON } from "../loop/types.ts";
import { tracePatterns } from "./patterns.ts";

/** Frozen numbers of the digests. */
export const DIGEST = {
  maxTokens: 40_000,
  /** Conservative: prose and JSON run 3.5–4.5 characters a token. */
  charsPerToken: 3.5,
  /** Each section's share of maxTokens, in order: champion misses, candidate losses, the rest. */
  share: { misses: 0.5, losses: 0.3, rest: 0.2 },
  /** Cases in a failure analyst's digest. */
  failureCases: 12,
  /** Lines of the draw reply a failure digest shows. */
  drawLines: 30,
  /** Longest spans a loss shows; cases shown per trace pattern; steps in the latency list. */
  spans: 3, examples: 3, steps: 15,
  /** Characters of said, meant and judge text per case line. */
  textChars: 220,
};
export const tokensOf = (s: string) => Math.ceil(s.length / DIGEST.charsPerToken);

const read = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};
const cut = (s: string | undefined, n = DIGEST.textChars) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, " ");
const q = (s?: string) => `"${cut(s)}"`;

/** A banked case's folder: the bank, or the archive it retired to. */
const bankDir = (id: string) => (existsSync(paths().bankCase(id)) ? paths().bankCase(id) : join(paths().bankArchive, id));
const bank = <T>(id: string, f: string) => read<T>(join(bankDir(id), f));
/** Only tuning cases (the bank's, refreshes' and top-ups') are ever digested: held-out ones would teach the optimizer the yardstick. */
const tuningInfo = (id: string) => {
  const info = bank<CaseInfo>(id, "case.json");
  return info?.set === "tuning" || info?.set === "fresh" ? info : undefined;
};
const saidOf = (id: string) => {
  const w = bank<CaseInput>(id, "input.json")?.words;
  return typeof w === "string" ? w : (w ?? []).map((x) => x.word).join(" ");
};
const tags = (i: CaseInfo) => `ask ${i.ask} · beat ${i.beat ?? "-"} · start ${i.start} · ${i.persona}`;
const judgeWhy = (run: string, id: string) => (["fidelity-1.json", "fidelity-2.json", "craft.json"] as const)
  .map((f) => read<Judged>(join(caseDir(run, id), "judge", f))).filter((j): j is Judged => !!j).map((j) => cut(j.why, 160)).join(" / ");
/** A cached reply's text (cache.ts writes `text`). */
const replyText = (r?: RecordedReply) => (r ? read<{ text?: string }>(paths().reply(r.cacheFile.replace(/\.json$/, "")))?.text : undefined);
/** A role's component, as the cards name them. */
const componentOf = (role: string) => (/refs|resolve/.test(role) ? "resolve" : role);

/** Lines up to `chars`, then a note of what didn't fit: no section can push the next one out. */
function fit(head: string[], items: string[], chars: number): string {
  const out = [...head];
  let used = out.join("\n").length;
  let i = 0;
  // 40 characters kept for the note.
  for (; i < items.length && used + items[i].length + 1 <= chars - 40; i++) {
    out.push(items[i]);
    used += items[i].length + 1;
  }
  if (i < items.length) out.push(`(+${items.length - i} more not shown)`);
  return out.join("\n");
}

/** Counts per value of one dimension, most first: `value misses/cases`. */
function table(title: string, rows: { key: string; hit: boolean }[]): string {
  const by = new Map<string, [number, number]>();
  for (const r of rows) {
    const c = by.get(r.key) ?? [0, 0];
    by.set(r.key, [c[0] + (r.hit ? 1 : 0), c[1] + 1]);
  }
  const lines = [...by].filter(([, c]) => c[0]).sort((a, b) => b[1][0] - a[1][0] || a[0].localeCompare(b[0])).map(([k, [h, n]]) => `${k} ${h}/${n}`);
  return `By ${title}: ${lines.join(", ") || "none"}`;
}

// ---- 1. Champion misses over the tuning bank

export type ChampionMiss = { id: string; info: CaseInfo; score: number; why: string[]; components: string[] };
/** The last checkpoint's run and the arm the champion held in it. */
export type CheckpointRef = { run: string; champion: Arm };

/**
 * Every tuning case where the champion fails, worst first: the driver rated it ≤ 2, the miss check said no
 * or partly, the champion lost it to the anchor at the last checkpoint (B1's tuning cases), the send was
 * empty, or ops or pictures failed.
 */
export function championMisses(checkpoint?: CheckpointRef): { cases: CaseInfo[]; misses: ChampionMiss[] } {
  const lost = new Map<string, string>();
  if (checkpoint) for (const r of readRows(checkpoint.run)) if (!r.void && r.s === (checkpoint.champion === "A" ? 1 : -1)) lost.set(r.case, judgeWhy(checkpoint.run, r.case));
  const dir = paths().bankCases;
  const banked = existsSync(dir) ? readdirSync(dir).filter((id) => existsSync(join(dir, id, "done"))) : [];
  const cases = [...new Set([...banked, ...lost.keys()])].map(tuningInfo).filter((i): i is CaseInfo => !!i);
  const misses: ChampionMiss[] = [];
  for (const info of cases) {
    const id = info.id;
    const rating = bank<Rating>(id, "rating.json");
    const miss = bank<Miss>(id, "miss.json");
    const champ = bank<ChampionOutcome>(id, "champion.json");
    const why: string[] = [];
    const components = new Set<string>();
    let score = 0;
    // Each signal adds its weight; a component when the signal names one.
    const add = (weight: number, text: string, component?: string) => {
      score += weight;
      why.push(text);
      if (component) components.add(component);
    };
    if (rating && rating.satisfaction <= 2) add(3 - rating.satisfaction, `driver rated ${rating.satisfaction}/5, saw ${q(rating.saw)}`);
    if (miss && miss.met !== "yes") add(miss.met === "no" ? 2 : 1, `miss check ${miss.met}: ${cut(miss.why, 160)}`);
    if (lost.has(id)) add(2, `lost to the anchor at the last checkpoint${lost.get(id) ? `: ${lost.get(id)}` : ""}`);
    if (champ?.empty) add(2, "empty send", "draw");
    if (champ?.opsFailed) add(1, `${champ.opsFailed} failed ops`, "draw");
    if (champ?.picsFailed) add(1, `${champ.picsFailed} failed pictures`, "picture");
    if (!score) continue;
    if (!components.size) components.add("unattributed");
    misses.push({ id, info, score, why, components: [...components] });
  }
  misses.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { cases, misses };
}

/** Section 1: the champion's misses with counts per beat, ask type, start and component, then the cases worst first. */
export function missSection(championSha: string, checkpoint?: CheckpointRef, chars = DIGEST.maxTokens * DIGEST.share.misses * DIGEST.charsPerToken): string {
  const { cases, misses } = championMisses(checkpoint);
  const hit = new Set(misses.map((m) => m.id));
  const n = (re: RegExp) => misses.filter((m) => m.why.some((w) => re.test(w))).length;
  const head = [
    `# 1. Where the champion fails (tuning bank, champion ${championSha})`,
    `${misses.length} of ${cases.length} tuning cases miss: driver rating ≤ 2: ${n(/^driver rated/)}, miss check no or partly: ${n(/^miss check/)}, lost to the anchor at the last checkpoint: ${n(/^lost to/)}, empty: ${n(/^empty/)}, failed ops: ${n(/failed ops/)}, failed pictures: ${n(/failed pictures/)}.`,
    table("beat", cases.map((c) => ({ key: c.beat ?? "-", hit: hit.has(c.id) }))),
    table("ask type", cases.map((c) => ({ key: c.ask, hit: hit.has(c.id) }))),
    table("start", cases.map((c) => ({ key: c.start, hit: hit.has(c.id) }))),
    table("component", misses.flatMap((m) => m.components.map((key) => ({ key, hit: true })))),
    "Cases, worst first:",
  ];
  const items = misses.map((m) => `- ${m.id} [${m.score}] ${tags(m.info)}: said ${q(saidOf(m.id))}; meant ${q(bank<Meant>(m.id, "meant.json")?.meant)}; ${m.why.join("; ")}`);
  return fit(head, items, chars);
}

/** Writes the champion-miss digest to $RT_EVAL_HOME/digests/<sha>.md (bank build, refresh, checkpoints). */
export function writeMissDigest(championSha: string, checkpoint?: CheckpointRef): string {
  const text = missSection(championSha, checkpoint);
  put(paths().digest(championSha), `${text}\n`);
  return text;
}

// ---- 2. Candidate losses in a decision's run (A the champion, B the candidate)

const arm = <T>(run: string, id: string, a: Arm, f: string) => read<T>(join(caseDir(run, id), a, f));
/** The roles whose requests differ between the arms: the components the card touched in this case. */
function differs(run: string, id: string): string[] {
  const [a, b] = (["A", "B"] as const).map((x) => arm<ArmResult>(run, id, x, "result.json")?.calls ?? []);
  const key = (c: ArmResult["calls"]) => new Map(c.map((x) => [x.role, x.reqHash]));
  const [ka, kb] = [key(a), key(b)];
  return [...new Set([...ka.keys(), ...kb.keys()])].filter((r) => ka.get(r) !== kb.get(r)).map(componentOf);
}
const topSpans = (spans: SpanJSON[] = []) => [...spans].sort((x, y) => y.endMs - y.startMs - (x.endMs - x.startMs)).slice(0, DIGEST.spans).map((s) => `${s.name} ${Math.round(s.endMs - s.startMs)} ms`).join(", ");

/** Section 2 for one run: lost, then tied, affected tuning cases. */
export function lossSection(run: string, chars = DIGEST.maxTokens * DIGEST.share.losses * DIGEST.charsPerToken): string {
  const rows = readRows(run).filter((r) => !r.void && r.affected && r.s <= 0 && tuningInfo(r.case)).sort((a, b) => a.s - b.s || a.case.localeCompare(b.case));
  const infos = new Map(rows.map((r) => [r.case, tuningInfo(r.case)!]));
  const comps = new Map(rows.map((r) => [r.case, differs(run, r.case)]));
  const lost = (r: (typeof rows)[number]) => r.s < 0;
  const head = [
    `## Run ${run}: ${rows.filter(lost).length} losses, ${rows.filter((r) => !lost(r)).length} ties`,
    table("beat", rows.map((r) => ({ key: r.beat ?? "-", hit: lost(r) }))),
    table("persona", rows.map((r) => ({ key: infos.get(r.case)!.persona, hit: lost(r) }))),
    table("fixture", rows.map((r) => ({ key: infos.get(r.case)!.start, hit: lost(r) }))),
    table("component", rows.flatMap((r) => (comps.get(r.case)!.length ? comps.get(r.case)! : ["scene only"]).map((key) => ({ key, hit: lost(r) })))),
  ];
  const items = rows.map((r) => {
    const info = infos.get(r.case)!;
    const ch = (a: Arm) => (read<string[]>(join(caseDir(run, r.case), a, "changes.json")) ?? []).join(", ") || "nothing";
    const failed = (arm<ArmResult>(run, r.case, "B", "result.json")?.ops ?? []).filter((o) => !o.ok).map((o) => `${cut(o.line, 60)} (${cut(o.error, 60)})`);
    const said = read<Packet>(join(caseDir(run, r.case), "judge", "packet.json"))?.said ?? saidOf(r.case);
    return [
      `- ${r.case} ${lost(r) ? "LOST" : "tie"} ${tags(info)}: said ${q(said)}; meant ${q(bank<Meant>(r.case, "meant.json")?.meant)}`,
      `  A changed: ${cut(ch("A"), 300)} | B changed: ${cut(ch("B"), 300)}`,
      `  ${failed.length ? `B's failed ops: ${failed.join("; ")} | ` : ""}judge: ${judgeWhy(run, r.case) || "-"} | B's top spans: ${topSpans(arm<SpanJSON[]>(run, r.case, "B", "spans.json")) || "-"} | thinking A ${r.thought[0]} B ${r.thought[1]} | differs in: ${comps.get(r.case)!.join(", ") || "scene only"}`,
    ].join("\n");
  });
  return fit(head, items, chars);
}

/** Writes a decision's candidate-loss digest to runs/<run>/digest.md. */
export function writeLossDigest(run: string): string {
  const text = lossSection(run);
  put(runFile(run, "digest.md"), `${text}\n`);
  return text;
}

// ---- 3. The champion's traces: patterns and latency per component

/** The champion's spans per tuning case in these runs. */
function championSpans(runs: CheckpointRef[]): { case: string; spans: SpanJSON[] }[] {
  return runs.flatMap(({ run, champion }) => {
    const dir = runFile(run, "cases");
    return (existsSync(dir) ? readdirSync(dir) : []).filter((id) => tuningInfo(id)).map((id) => ({ case: id, spans: arm<SpanJSON[]>(run, id, champion, "spans.json") ?? [] }));
  });
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
/** Median ms per step and per model role, by total time (the latency share). */
function spanMedians(cases: { spans: SpanJSON[] }[]): string[] {
  const by = new Map<string, number[]>();
  for (const s of cases.flatMap((c) => c.spans)) {
    const name = s.name.startsWith("model call · ") ? `model call · ${componentOf(String(s.attributes.from ?? s.name.split(" · ")[1]))}` : s.name.replace(/^picture: .*/, "picture: *");
    by.set(name, [...(by.get(name) ?? []), s.endMs - s.startMs]);
  }
  return [...by].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0)).slice(0, DIGEST.steps).map(([k, v]) => `${k}: median ${Math.round(median(v))} ms over ${v.length}`);
}

export type DigestInput = {
  championSha: string;
  checkpoint?: CheckpointRef;
  /** The last decisions' runs. */
  runs?: string[];
  /** The failure analysts' answers, the ledger's one-liners, the tried index (title, component, diff hash, verdict). */
  failures?: string[]; ledger?: string[]; tried?: string[];
  /** What the coordinator would drop unrun now (paused components, --quality-only, owner-only kinds). */
  wont?: string[];
  /** Reverted cards that leaned the right way without proving it (run.ts' nearWins): to combine or retry. */
  nearWins?: string[];
};

/** The analyst's input: champion misses first, then candidate losses, trace patterns, latency, failures, ledger, tried. */
export function analystDigest(o: DigestInput): string {
  const budget = (share: number) => DIGEST.maxTokens * share * DIGEST.charsPerToken;
  const runs = o.runs ?? [];
  const losses = runs.length
    ? fit(["# 2. Candidate losses (the last decisions)"], runs.map((r) => lossSection(r, budget(DIGEST.share.losses) / runs.length - 20)), budget(DIGEST.share.losses))
    : "# 2. Candidate losses (the last decisions)\nnone yet";
  const spans = championSpans([...(o.checkpoint ? [o.checkpoint] : []), ...runs.map((run) => ({ run, champion: "A" as const }))]);
  const report = Object.values(tracePatterns(spans)).map((p) => `- ${p.title} (fix: ${p.fix}): ${p.cases.length} cases${p.cases.length ? `, e.g. ${p.cases.slice(0, DIGEST.examples).map((c) => `${c.case} [${c.fired[0].spans.join(" → ")}: ${c.fired[0].note}]`).join("; ")}` : ""}`);
  const rest = fit(["# 3. The champion's traces", "Patterns:", ...report, "Latency by step (median):", ...spanMedians(spans)],
    [
      ...(o.nearWins?.length ? ["# 4. Near wins (reverted, but leaning the right way: combine them in a combo card, or retry with what differs)", ...o.nearWins] : []),
      ...(o.failures?.length ? ["# 5. Failure analysts", ...o.failures] : []), ...(o.ledger?.length ? ["# 6. Ledger", ...o.ledger] : []), ...(o.tried?.length ? ["# 7. Tried (don't repeat without saying what differs)", ...o.tried] : []),
    ],
    budget(DIGEST.share.rest));
  const wont = o.wont?.length ? `# 0. What the loop won't run now (don't propose it)\n${o.wont.map((w) => `- ${w}`).join("\n")}` : undefined;
  return [...(wont ? [wont] : []), missSection(o.championSha, o.checkpoint), losses, rest].join("\n\n");
}

// ---- The failure analyst's digest: at most 12 cases in full

/** A case in full: a run's case (B's side, against A) or, without a run, the champion's banked send. */
export function failureDigest(items: { case: string; run?: string }[]): string {
  return items.filter((i) => tuningInfo(i.case)).slice(0, DIGEST.failureCases).map(({ case: id, run }) => {
    const info = tuningInfo(id)!;
    const readings = bank<Readings>(id, "readings.json");
    const rating = bank<Rating>(id, "rating.json");
    const miss = bank<Miss>(id, "miss.json");
    const replies = bank<RecordedReply[]>(id, "replies.json") ?? [];
    const result = run ? arm<ArmResult>(run, id, "B", "result.json") : undefined;
    const timing = (a: Arm) => (run ? arm<ArmTiming>(run, id, a, "timing.json") : undefined);
    const fmt = (t?: ArmTiming) => (t ? `first drawing ${t.ttfdMs ?? "-"} ms (first text ${t.firstTextMs ?? "-"}, resolver ${t.resolverMs ?? "-"}, pictures ${t.picturesMs ?? "-"}), render p90 ${t.renderP90Ms ?? "-"} ms (max ${t.renderMaxMs ?? "-"}), TTFC ${t.ttfcMs ?? "-"} ms, TTD ${t.ttdMs} ms` : "-");
    const draw = run ? result?.reply : replyText(replies.find((r) => r.role === "draw"));
    const thinking = run ? (result?.calls ?? []).filter((c) => (c.thinkingTokens ?? 0) > 0).map((c) => c.role) : replies.filter((r) => (read<{ stats?: { thinkingTokens?: number } }>(paths().reply(r.cacheFile.replace(/\.json$/, "")))?.stats?.thinkingTokens ?? 0) > 0).map((r) => r.role);
    return [
      `## ${id} (${run ? `run ${run}, the candidate's send` : "the champion's banked send"}) ${tags(info)}`,
      `said: ${q(saidOf(id))}`,
      `meant: ${q(bank<Meant>(id, "meant.json")?.meant)}`,
      `ink: ${(readings?.marks ?? []).map((m) => `[ink ${m.n}] ${m.kind} (${m.how}) → ${m.targets.join(", ") || "nothing"}`).join("; ") || "none"}`,
      `resolver: ${(readings?.refs ?? []).map((r) => `"${r.phrase}" → ${r.ids.join(", ")}`).join("; ") || "-"}`,
      `draw reply (first ${DIGEST.drawLines} lines):\n${(draw ?? "").split("\n").slice(0, DIGEST.drawLines).join("\n") || "(none)"}`,
      ...(result ? [`failed ops: ${result.ops.filter((o) => !o.ok).map((o) => `${o.line} (${o.error})`).join("; ") || "none"}`, `judge: ${judgeWhy(run!, id) || "-"}`] : []),
      ...(!run && miss ? [`miss check: ${miss.met}: ${miss.why}`] : []),
      `driver: ${rating ? `${rating.satisfaction}/5, saw ${q(rating.saw)}` : "-"}`,
      ...(run ? [`timing A: ${fmt(timing("A"))} | B: ${fmt(timing("B"))}`] : []),
      `thinking: ${thinking.join(", ") || "none"}`,
    ].join("\n");
  }).join("\n\n");
}
