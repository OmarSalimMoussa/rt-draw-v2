// The eval pages' endpoints (frozen measuring side), in the owner's dev server
// (vite.config.ts) and the harness pages server (evals/pages.vite.config.ts):
// the history the progress page charts, the run files behind a decision, the
// owner's calibration labels and his recorded sends. Reads only inside
// $RT_EVAL_HOME (and the eval/history branch), writes only labels/ and human/
// there, makes no model call and starts nothing until a request comes.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, statfsSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { LOOP } from "../loop/config.ts";
import { paths } from "../loop/paths.ts";
import type { Arm, Packet } from "../loop/types.ts";

/** The tracked files the progress page reads (§5.3), plus the owner list for its open count. */
export const HISTORY_FILES = ["epochs.jsonl", "decisions.jsonl", "checkpoints.jsonl", "budget.jsonl", "health.jsonl", "anchors.json", "eras.json", "markers.jsonl", "owner-list.md"];
/** What /api/eval/file may serve: run files, banked cases, the reply cache and its images, digests. */
const SERVED_DIRS = ["runs", "bank", "cache", "digests"];
/** Disk growth is re-measured at most this often: it walks cache/, runs/ and trees/. */
const GROWTH_EVERY_MS = 10 * 60_000;
const WEEK_MS = 7 * 86_400_000;

/**
 * One calibration pair, as calibrate.ts lists them in labels/pairs.json: the packet at
 * runs/<run>/cases/<case>/judge/packet.json, asked as `question`. `swap` shows its sides the
 * other way round (repeats). The packet's positions never leave the server.
 */
export type PairRef = { id: string; run: string; case: string; question: "fidelity" | "craft"; subset?: string; swap?: boolean };
/** One line of labels/labels.jsonl; `label` is the arm the owner preferred. An undo appends { undo: id, at }. */
export type Label = { id: string; pair: string; packet: string; subset?: string; question: "fidelity" | "craft"; side: "left" | "right" | "tie" | "skip";
  label: Arm | "tie" | "skip"; strength: "clear" | "slight" | null; ms: number; at: string };

type Q = URLSearchParams;
type Handler = (q: Q, req: IncomingMessage) => Promise<Reply> | Reply;
type Reply = { status?: number; type?: string; body: string | Buffer };

const json = (v: unknown, status = 200): Reply => ({ status, type: "application/json", body: JSON.stringify(v) });
const refuse = (status: number, error: string): Reply => json({ error }, status);
const readJson = (f: string) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};
const lines = <T>(f: string): T[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const body = (req: IncomingMessage) =>
  new Promise<any>((ok, no) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      try {
        ok(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch (err) {
        no(err);
      }
    });
    req.on("error", no);
  });
/** A relative path with no way out of its folder: no "..", no absolute start, no hidden file (.env, a config dir). */
const safeRel = (p: string) => !!p && !p.startsWith("/") && p.split(/[\\/]/).every((s) => s && s !== ".." && !s.startsWith("."));
const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".json": "application/json" };

/** A tracked history file: from the $RT_EVAL_HOME/history worktree when it exists, else `git show eval/history:<f>` in `repo`. */
export function historyFile(name: string, repo: string): { text?: string; source: "worktree" | "git" } {
  let dir: string | undefined;
  try {
    dir = paths().history;
  } catch {} // no usable RT_EVAL_HOME here (the owner's laptop may have none): the branch alone
  if (dir && existsSync(dir)) {
    const f = join(dir, name);
    return { text: existsSync(f) ? readFileSync(f, "utf8") : undefined, source: "worktree" };
  }
  try {
    return { text: execFileSync("git", ["-C", repo, "show", `eval/history:${name}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 }), source: "git" };
  } catch {
    return { source: "git" }; // no branch, or no such file on it
  }
}

let growth: { at: number; bytes: number } | undefined;
/** Free disk at the home, and the bytes cache/, runs/ and trees/ gained in the last week (hard-linked node_modules skipped). */
function disk(home: string) {
  const fs = statfsSync(home);
  if (!growth || Date.now() - growth.at > GROWTH_EVERY_MS) {
    let bytes = 0;
    const since = Date.now() - WEEK_MS;
    const walk = (dir: string) => {
      for (const e of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
        const p = join(dir, e.name);
        if (e.isDirectory()) e.name !== "node_modules" && walk(p);
        else if (e.isFile()) {
          const s = statSync(p);
          if (s.mtimeMs > since) bytes += s.size;
        }
      }
    };
    for (const d of ["cache", "runs", "trees"]) walk(join(home, d));
    growth = { at: Date.now(), bytes };
  }
  const freeGb = (fs.bavail * fs.bsize) / 1e9;
  const perDayGb = growth.bytes / 1e9 / 7;
  // Days until the loop pauses new cases (LOOP.diskPauseGb), at last week's pace.
  return { freeGb, weekGrowthGb: growth.bytes / 1e9, daysLeft: perDayGb > 0 ? Math.max(0, (freeGb - LOOP.diskPauseGb) / perDayGb) : null, ownerGb: LOOP.diskOwnerGb, pauseGb: LOOP.diskPauseGb };
}

/** GET /api/eval/history: every §5.3 file's text (null when absent) and the loop's live status; ?f=<file> one tracked file. */
function history(repo: string): Handler {
  return (q) => {
    const one = q.get("f");
    if (one !== null) {
      if (!safeRel(one)) return refuse(403, "not a history file");
      const { text } = historyFile(one, repo);
      return text === undefined ? refuse(404, `no ${one} in eval/history`) : { type: TYPES[extname(one)] ?? "text/plain; charset=utf-8", body: text };
    }
    const files: Record<string, string | null> = {};
    let source = "none";
    for (const name of HISTORY_FILES) {
      const got = historyFile(name, repo);
      files[name] = got.text ?? null;
      if (got.text !== undefined || got.source === "worktree") source = got.source;
    }
    let status: Record<string, unknown> = {};
    try {
      const p = paths();
      status = { heartbeat: readJson(p.heartbeat), state: readJson(p.state), disk: existsSync(p.home) ? disk(p.home) : undefined };
    } catch (err) {
      status = { error: (err as Error).message };
    }
    return json({ source, files, status: { ...status, now: Date.now() } });
  };
}

/** Resolves a file request inside the home: "refused" for anything outside it (symlinks included), undefined when absent. */
function homeFile(q: Q): string | "refused" | undefined {
  const [run, kase, f] = [q.get("run"), q.get("case"), q.get("f") ?? ""];
  if (![run ?? "x", kase ?? "x", f].every(safeRel)) return "refused";
  // A run's case file, else that case's banked file (before-ink.jpg lives with the bank); f alone is home-relative.
  const rels = run ? [join("runs", run, ...(kase ? ["cases", kase] : []), f), ...(kase ? [join("bank", "cases", kase, f)] : [])] : kase ? [join("bank", "cases", kase, f)] : [f];
  const home = realpathSync(paths().home);
  for (const rel of rels) {
    if (!SERVED_DIRS.includes(rel.split(sep)[0])) return "refused";
    const abs = resolve(home, rel);
    if (!abs.startsWith(home + sep)) return "refused";
    if (!existsSync(abs)) continue;
    const real = realpathSync(abs);
    if (!real.startsWith(home + sep) || !statSync(real).isFile()) return "refused";
    return real;
  }
}

/** GET /api/eval/file?run=&case=&f=: one file of a run, a banked case or the reply cache, never outside $RT_EVAL_HOME. */
const file: Handler = (q) => {
  const f = homeFile(q);
  if (f === "refused") return refuse(403, "outside the eval home");
  if (!f) return refuse(404, "no such file");
  return { type: TYPES[extname(f)] ?? "text/plain; charset=utf-8", body: readFileSync(f) };
};

/** GET /api/eval/calls?run=&case=: that case's lines of meter/calls.jsonl (both arms), for the drill-down. */
const calls: Handler = (q) => {
  const [run, kase] = [q.get("run"), q.get("case")];
  if (!run || !kase) return refuse(400, "run and case are required");
  const f = paths().calls;
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  const parse = (l: string) => {
    try {
      return JSON.parse(l);
    } catch {} // a line the gateway is still writing
  };
  return json(text.split("\n").filter((l) => l.includes(kase)).map(parse).filter((c) => c?.run === run && c.case === kase));
};

// ---- Calibration labels (§4.5)

const pairsFile = () => join(dirname(paths().labels), "pairs.json");
/** Labels still standing: every line not undone later. */
export function standingLabels(file: string): Label[] {
  const all = lines<Label & { undo?: string }>(file);
  const undone = new Set(all.filter((l) => l.undo).map((l) => l.undo));
  return all.filter((l) => !l.undo && !undone.has(l.id));
}
const packetOf = (p: PairRef): Packet => JSON.parse(readFileSync(join(paths().run(p.run), "cases", p.case, "judge", "packet.json"), "utf8"));
const url = (p: PairRef, f: string) => `/api/eval/file?${new URLSearchParams({ run: p.run, case: p.case, f })}`;

/** GET /api/eval/pairs: the pairs left to label, fidelity before craft, as the judge saw them minus the positions. */
const pairs: Handler = () => {
  const all: PairRef[] = readJson(pairsFile()) ?? [];
  const done = standingLabels(paths().labels);
  const seen = new Set(done.map((l) => l.pair));
  const clear = done.filter((l) => l.question === "fidelity" && l.strength === "clear").length;
  const craft = done.filter((l) => l.question === "craft" && l.label !== "skip").length;
  // Labelling stops at 60 clear fidelity labels and 30 craft labels.
  const want = { fidelity: clear < LOOP.calib.clear, craft: craft < LOOP.calib.craftPairs };
  const left = all.filter((p) => !seen.has(p.id) && want[p.question]).sort((a, b) => Number(a.question === "craft") - Number(b.question === "craft"));
  return json({
    total: all.length,
    progress: { clear, clearGoal: LOOP.calib.clear, craft, craftGoal: LOOP.calib.craftPairs, labelled: done.length },
    pairs: left.map((p) => {
      const k = packetOf(p);
      const sides = [{ image: url(p, k.images.left), changes: k.changes.left }, { image: url(p, k.images.right), changes: k.changes.right }];
      const [l, r] = p.swap ? [sides[1], sides[0]] : sides;
      // The craft pass shows the screens only: no words, no change lists.
      if (p.question === "craft") return { id: p.id, question: p.question, left: { image: l.image }, right: { image: r.image } };
      return { id: p.id, question: p.question, said: k.said, meant: k.meant, hedged: k.hedged, targetParts: k.targetParts, before: url(p, k.images.before), left: l, right: r };
    }),
  });
};

/** POST /api/eval/label {pair, question, side, strength, ms} appends one label (the side mapped to its arm here); {undo: true} undoes the last one. */
const label: Handler = async (_q, req) => {
  const b = await body(req);
  const file = paths().labels;
  mkdirSync(dirname(file), { recursive: true });
  const at = new Date().toISOString();
  if (b.undo) {
    // The last label still standing, so undo keeps working after a reload (the page holds nothing).
    const last = standingLabels(file).at(-1);
    if (!last) return refuse(404, "nothing to undo");
    appendFileSync(file, `${JSON.stringify({ undo: last.id, at })}\n`);
    return json({ undone: last.id, pair: last.pair });
  }
  const p = ((readJson(pairsFile()) ?? []) as PairRef[]).find((x) => x.id === b.pair);
  if (!p) return refuse(404, `no pair ${b.pair}`);
  if (b.question !== p.question || !["left", "right", "tie", "skip"].includes(b.side)) return refuse(400, "question or side doesn't fit the pair");
  const pos = packetOf(p).positions;
  const [left, right] = p.swap ? [pos.right, pos.left] : [pos.left, pos.right];
  const strength = b.side === "left" || b.side === "right" ? (b.strength === "slight" ? "slight" : "clear") : null;
  const line: Label = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, pair: p.id, packet: `runs/${p.run}/cases/${p.case}/judge/packet.json`, subset: p.subset,
    question: p.question, side: b.side, label: b.side === "left" ? left : b.side === "right" ? right : b.side, strength, ms: Math.round(Number(b.ms) || 0), at };
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  return json({ id: line.id });
};

// ---- The owner's recorded sends (§2.8, human set U1)

const sendFile = (id: string) => (/^h-[\w-]+$/.test(id) ? join(paths().human, `${id}.json`) : undefined);

/** POST /api/eval/record {input, strokes, scene, view, at}: one real send from the playground's ?record=1, as human/<id>.json. */
const record: Handler = async (_q, req) => {
  const b = await body(req);
  if (b.input === undefined || !b.scene) return refuse(400, "a send needs input and scene");
  const id = `h-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(paths().human, { recursive: true });
  writeFileSync(sendFile(id)!, JSON.stringify({ id, ...b, recordedAt: new Date().toISOString() }));
  return json({ id });
};

/** GET /api/eval/human: the recorded sends, oldest first. POST {id, meant}: writes what he meant into that send. */
const human: Handler = async (_q, req) => {
  const dir = paths().human;
  if (req.method === "POST") {
    const b = await body(req);
    const f = sendFile(String(b.id));
    if (!f || !existsSync(f)) return refuse(404, `no send ${b.id}`);
    // Written aside then renamed, so a crash never leaves half a send.
    writeFileSync(`${f}.tmp`, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), meant: String(b.meant ?? "").trim(), meantAt: new Date().toISOString() }));
    renameSync(`${f}.tmp`, f);
    return json({ ok: true });
  }
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => /^h-[\w-]+\.json$/.test(n)).sort() : [];
  return json(names.map((n) => JSON.parse(readFileSync(join(dir, n), "utf8"))));
};

/** The /api/eval/* endpoints. `git show` reads the branch from the repo this server serves. */
export function evalPages(): Plugin {
  return {
    name: "eval-pages",
    apply: "serve",
    configureServer(server) {
      const routes: Record<string, Handler> = { "GET /history": history(server.config.root), "GET /file": file, "GET /calls": calls, "GET /pairs": pairs, "POST /label": label, "POST /record": record, "GET /human": human, "POST /human": human };
      server.middlewares.use("/api/eval", async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const u = new URL(req.url ?? "/", "http://x");
        const route = routes[`${req.method} ${u.pathname}`];
        if (!route) return next();
        let r: Reply;
        try {
          r = await route(u.searchParams, req);
        } catch (err) {
          r = refuse(500, (err as Error).message);
        }
        res.statusCode = r.status ?? 200;
        res.setHeader("content-type", r.type ?? "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(r.body);
      });
    },
  };
}
