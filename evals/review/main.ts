// Eval HQ's intake and review (evals/real/README.md): where the last pulls' sends are, how well they're labeled, and
// the queue of cards. A card is one tester's or the owner's send with everything its verdict needs: the board before
// (their ink numbered), what the app made then, today's champion on it, gold, their words with timings, the meaning and
// expectation it will be judged by (edit either and approve: the edit is pinned), and gold's free checks then, now and
// on gold. The reviewer shows one card at a time over the whole window and the next at once: approve (A, with any
// edits), reject for a reason (1–6), step (J, K); a card joins after its look window unless rejected. /evals/review/#go
// opens it on the cards waiting. Everything comes from GET /api/eval/intake and /api/eval/card (evals/real/review.ts) on
// the PGX; the page keeps nothing but the filters (in the address).
import { $ } from "../../src/ui.ts";
import { frame, legend } from "../progress/charts.ts";
import { hq } from "../progress/hq.ts";

hq("review", "Intake: new sends are pulled every 30 minutes, labeled between the loop's epochs (triage for every send, gold for each clear miss) and proposed here. A card joins the bank after its look window unless you reject it; approve it sooner, or edit what's wrong first.");

type State = "labeled" | "proposed" | "admitted" | "rejected" | "skipped";
type Rubric = { should: string[]; mustNot: string[] };
type Row = {
  key: string; state: State; tester: boolean; split: "tune" | "hold"; project: string; at: string; said: string; landed?: string; categories: string[]; gold: boolean;
  skip?: string; proposedAt?: string; admitAt?: string; verdict?: "approve" | "reject"; reason?: string; edited: { meant: boolean; expectation: boolean };
};
type Check = { pass: boolean; why: string };
type Card = Row & {
  lookDays: number; reasons: Record<string, string>;
  send: { n: number; of: number; kind: string; replay: string; words: { word: string; t0: number }[] | string; label: string; marks: string[]; refs?: string; status?: string };
  previous?: { said: string; at: string }; feedback: { at: string; text: string }[];
  images: { before?: string; then?: string; champion?: string; gold?: string };
  triage?: { meant: string; landed: string; categories: string[]; evidence: string };
  meant: { now: string; drafted: string; pinned: boolean };
  expectation: { now?: Rubric; from?: "owner" | "gold" | "judge"; pinned: boolean };
  gold?: { why?: string; error?: string; problems: string[]; checks: { check: unknown; then?: Check; now?: Check; gold?: Check }[] };
  champion?: { sha: string; run: string };
  review: { verdict?: string; reason?: string; note?: string };
};
type Intake = {
  lookDays: number; reasons: Record<string, string>;
  pull: Record<"live" | "local", { pulledAt?: string; snapshot?: string }>;
  states: Record<string, number>; skipped: Record<string, number>; rejected: Record<string, number>;
  quality: { week: string; decided: number; rejected: number; meant: number; expectation: number }[];
  cards: Row[];
};

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ago = (iso?: string) => {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  return ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 172_800_000 ? `${(ms / 3_600_000).toFixed(1)} h ago` : `${Math.round(ms / 86_400_000)} days ago`;
};
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : "");
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const post = async (body: unknown) => {
  const r = await fetch("/api/eval/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};

// ---- Filters, kept in the address so a reload or a link keeps them

const params = new URLSearchParams(location.search);
const filters = { state: params.get("state") ?? "proposed", who: params.get("who") ?? "all", landed: params.get("landed") ?? "all", reason: params.get("reason") ?? "all" };
/** Triage's word that a send asked for nothing drawn (cases.ts NOT_DRAWING): approving it reopens it. */
const NOT_DRAWING = "not a drawing request";
const saveFilters = () => history.replaceState(null, "", `?${new URLSearchParams(filters)}${location.hash}`);
const shown = (rows: Row[]) =>
  rows
    .filter((r) => filters.state === "all" || r.state === filters.state)
    .filter((r) => filters.who === "all" || (filters.who === "tester") === r.tester)
    .filter((r) => filters.landed === "all" || (filters.landed === "missed" ? r.landed !== "yes" : r.landed === "yes"))
    .filter((r) => filters.reason === "all" || r.skip === filters.reason || r.reason === filters.reason)
    // Proposed: the next to join first. The rest: the newest first.
    .sort((a, b) => (filters.state === "proposed" ? (a.admitAt ?? "").localeCompare(b.admitAt ?? "") : b.at.localeCompare(a.at)));

// ---- Panels

const panel = (name: string, wide = false) => {
  const c = document.createElement("section");
  c.className = `card${wide ? " wide" : ""}`;
  c.dataset.panel = name;
  $("#panels").append(c);
  return c;
};

function funnel(d: Intake) {
  const host = panel("funnel", true);
  const n = (s: string) => d.states[s] ?? 0;
  const skipped = Object.entries(d.skipped).sort((a, b) => b[1] - a[1]);
  host.innerHTML = `<h2>From the pull to the bank</h2>
    <div class="funnel">
      <span>pulled: live ${esc(ago(d.pull.live.pulledAt))}, local ${esc(ago(d.pull.local.pulledAt))}</span>
      <span><b>${n("pulled")}</b>new</span><span><b>${n("labeled")}</b>being labeled</span><span><b>${n("proposed")}</b>proposed</span>
      <span><b>${n("admitted")}</b>admitted</span><span><b>${n("rejected")}</b>rejected</span><span><b>${n("skipped")}</b>skipped</span>
    </div>
    ${skipped.length ? `<details><summary class="muted">Why ${n("skipped")} sends are no case</summary><ul>${skipped.map(([why, k]) => `<li>${k}: ${esc(why)}</li>`).join("")}</ul></details>` : ""}
    <p class="muted">New sends are labeled between the loop's epochs, or every 30 minutes while it's stopped. A proposed card joins after ${d.lookDays} days unless you reject it.</p>`;
}

function quality(d: Intake) {
  const host = panel("quality");
  const chart = document.createElement("div");
  chart.className = "chart";
  host.append(chart);
  const rows = d.quality;
  if (!rows.length) return void (chart.innerHTML = `<h2>How well cards are labeled</h2><p class="muted">The share of cards you edit or reject, per week, once you've judged some.</p>`);
  const f = frame(chart, { title: "How well cards are labeled: the share you edit or reject, per week", height: 220, x: [0, Math.max(1, rows.length - 1)], y: [0, 1], xTicks: rows.map((r, i) => ({ at: i, label: r.week.slice(5) })), yFormat: (v) => `${Math.round(v * 100)}%` });
  const series: [string, keyof (typeof rows)[number], string][] = [["meaning edited", "meant", "#1971c2"], ["expectation edited", "expectation", "#2b8a3e"], ["rejected", "rejected", "#c92a2a"]];
  for (const [, k, color] of series) {
    const pts = rows.map((r, i) => [i, r.decided ? (r[k] as number) / r.decided : 0] as [number, number]);
    f.line(pts, { color, width: 2, data: { series: String(k) } });
    f.dots(pts.map(([px, py], i) => ({ x: px, y: py, id: `${k}-${rows[i].week}` })), color);
  }
  legend(chart, series.map(([label, , c]) => [label, c] as [string, string]));
  const reasons = Object.entries(d.rejected).sort((a, b) => b[1] - a[1]);
  chart.insertAdjacentHTML("beforeend", `<div class="stat muted">${rows.reduce((a, r) => a + r.decided, 0)} cards judged${reasons.length ? `; rejected as ${reasons.map(([r, k]) => `${esc(d.reasons[r] ?? r)} ${k}`).join(", ")}` : ""}. The next revision of the triage and expectation prompts starts from these.</div>`);
}

function queue(d: Intake) {
  const host = panel("queue", true);
  const opt = (name: keyof typeof filters, values: [string, string][]) => `<label>${name} <select data-filter="${name}">${values.map(([v, l]) => `<option value="${v}"${filters[name] === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>`;
  const rows = shown(d.cards);
  host.innerHTML = `<h2>Cards</h2>
    <div class="filters">${opt("state", [["proposed", `proposed (${d.states.proposed ?? 0})`], ["labeled", `being labeled (${d.states.labeled ?? 0})`], ["admitted", `admitted (${d.states.admitted ?? 0})`], ["rejected", `rejected (${d.states.rejected ?? 0})`], ["skipped", `skipped (${d.states.skipped ?? 0})`], ["all", "all"]])}
      ${opt("who", [["all", "everyone"], ["tester", "testers"], ["owner", "you"]])}${opt("landed", [["all", "landed or missed"], ["missed", "missed"], ["landed", "landed"]])}
      ${opt("reason", [["all", "any reason"], ...Object.entries(d.rejected).map(([k, n]) => [k, `rejected: ${d.reasons[k] ?? k} (${n})`] as [string, string]), ...Object.entries(d.skipped).map(([why, n]) => [why, `skipped: ${why} (${n})`] as [string, string])])}
      <span class="muted">${rows.length} shown</span>${rows.length ? `<button class="primary" data-go>${filters.state === "proposed" ? `Review the ${rows.length} waiting` : `Go through these ${rows.length}`} <kbd>Enter</kbd></button>` : ""}</div>
    <div class="queue">${rows.map((r) => `<button class="item" data-key="${esc(r.key)}"><span class="chip ${r.state}">${r.state === "proposed" ? `joins ${esc(day(r.admitAt))}` : r.state === "labeled" ? "being labeled" : r.state === "skipped" ? `skipped: ${esc(r.skip)}` : esc(r.state)}</span><span class="said">“${esc(r.said)}”</span><span class="muted">${r.landed === "yes" ? "landed" : r.landed ? `missed${r.gold ? " · gold" : ""}` : ""}</span><span class="meta muted">${esc(r.project)} · ${r.tester ? `tester${r.split === "hold" ? " (R-hold: R1 only)" : ""}` : "you"} · ${esc(day(r.at))}${r.categories.length ? ` · ${esc(r.categories.join(", "))}` : ""}${r.edited.meant || r.edited.expectation ? " · edited" : ""}${r.reason ? ` · ${esc(d.reasons[r.reason] ?? r.reason)}` : ""}</span></button>`).join("") || '<p class="muted">No card here.</p>'}</div>`;
  host.querySelectorAll<HTMLSelectElement>("select[data-filter]").forEach((s) =>
    s.addEventListener("change", () => {
      filters[s.dataset.filter as keyof typeof filters] = s.value;
      saveFilters();
      draw();
    }),
  );
  const keys = rows.map((r) => r.key);
  host.querySelectorAll<HTMLButtonElement>("button[data-key]").forEach((b) => b.addEventListener("click", () => review(keys, keys.indexOf(b.dataset.key!))));
  host.querySelector("[data-go]")?.addEventListener("click", () => review(keys));
}

// ---- The reviewer: one card at a time over the whole window, the next ones fetched ahead, a key per verdict

type Which = "before" | "then" | "champion" | "gold";
type Loaded = { card: Card; urls: Partial<Record<Which, string>> };
/** Cards fetched ahead of the one shown, images included, so a verdict shows the next at once. */
const AHEAD = 2;

const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
const checkCell = (c?: Check) => (c ? `<td class="${c.pass ? "ok" : "bad"}">${c.pass ? "✓" : `✗ ${esc(c.why)}`}</td>` : '<td class="muted">-</td>');
const wordsHtml = (w: Card["send"]["words"], label: string) =>
  typeof w === "string" ? `<span>${esc(w || label || "(nothing said)")}</span>` : w.length ? w.map((x) => `<span><i>${(x.t0 / 1000).toFixed(1)}s</i>${esc(x.word)}</span>`).join("") : `<span>${esc(label || "(nothing said)")}</span>`;
const shots = (c: Card): [Which, string][] => [["before", "before, their ink numbered"], ["then", "what the app made then"], ["champion", c.champion ? `today's champion (${c.champion.sha.slice(0, 7)})` : "today's champion"], ["gold", "gold"]];

/** A card and its images as blobs: the server sends them no-store, so the browser's cache can't hold the next ones ready. */
async function fetchCard(key: string): Promise<Loaded> {
  const r = await fetch(`/api/eval/card?${new URLSearchParams({ key })}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  const card: Card = await r.json();
  const urls: Loaded["urls"] = {};
  await Promise.all(
    (Object.entries(card.images) as [Which, string | undefined][]).map(async ([w, src]) => {
      const b = src ? await fetch(src).then((x) => (x.ok ? x.blob() : undefined), () => undefined) : undefined;
      if (b) urls[w] = URL.createObjectURL(b);
    }),
  );
  return { card, urls };
}
const forget = (p: Promise<Loaded>) => void p.then((l) => Object.values(l.urls).forEach((u) => URL.revokeObjectURL(u)), () => {});

const statusOf = (c: Card) =>
  c.state === "proposed" ? `joins ${day(c.admitAt)} unless rejected` : c.state === "labeled" ? "still being labeled: it can't be judged yet" : c.state === "rejected" ? `rejected: ${c.reasons[c.review.reason ?? ""] ?? c.review.reason ?? ""}` : c.state === "skipped" ? `skipped: ${c.skip}` : "admitted";

function cardHtml(l: Loaded) {
  const c = l.card;
  const e = c.expectation.now;
  const checks = c.gold?.checks ?? [];
  const failing = (k: "then" | "now" | "gold") => checks.filter((x) => x[k] && !x[k]!.pass).length;
  return `<div class="rv-shots">${shots(c).map(([w, cap]) => `<figure><figcaption>${esc(cap)}</figcaption>${l.urls[w] ? `<img src="${l.urls[w]}" alt="${esc(cap)}" data-zoom="${w}">` : `<div class="none">${w === "gold" ? "no gold: the expectation judges it" : "none"}</div>`}</figure>`).join("")}</div>
    <div class="rv-side">
      <div class="row"><span class="chip ${c.state}">${esc(statusOf(c))}</span><span class="muted">${esc(c.project)} · send ${c.send.n} of ${c.send.of} · ${c.tester ? `a tester's${c.split === "hold" ? " (R-hold: R1 only)" : ""}` : "yours"} · ${esc(new Date(c.at).toLocaleString())}${c.send.kind === "build" ? " · a preview click" : ""}${c.send.status && c.send.status !== "done" ? ` · ${esc(c.send.status)}` : ""}</span></div>
      <div class="words">${wordsHtml(c.send.words, c.send.label)}</div>
      ${c.previous ? `<p class="muted">The send before: “${esc(c.previous.said)}”</p>` : ""}${c.send.marks.length ? `<p class="muted">Ink, as the app read it: ${esc(c.send.marks.join("; "))}</p>` : ""}${c.send.refs ? `<p class="muted">What the app took them to mean: ${esc(c.send.refs)}</p>` : ""}
      ${c.feedback.length ? `<p class="muted">Their written feedback on the project: ${c.feedback.map((f) => `“${esc(f.text)}”`).join("; ")}</p>` : ""}
      ${c.triage ? `<p><b>Triage</b>: ${c.triage.landed === "yes" ? "landed" : c.triage.landed === "partly" ? "partly landed" : "missed"}${c.triage.categories.length ? ` · ${esc(c.triage.categories.join(", "))}` : ""} · ${esc(c.triage.evidence)}</p>` : ""}
      <section><h3>Meant${c.meant.pinned ? " · your edit" : ""}</h3><textarea data-edit="meant" rows="2">${esc(c.meant.now)}</textarea>${c.meant.pinned && c.meant.drafted ? `<p class="muted">Triage said: ${esc(c.meant.drafted)} (clear yours to take it back)</p>` : ""}</section>
      <section><h3>Expectation${c.expectation.from === "owner" ? " · your edit" : c.expectation.from === "gold" ? " · gold's rubric" : c.expectation.from === "judge" ? " · drafted by the judge" : ""}</h3>
        <label class="muted">Should, one a line</label><textarea data-edit="should" rows="3">${esc(e?.should.join("\n") ?? "")}</textarea>
        <label class="muted">Must not, one a line</label><textarea data-edit="mustNot" rows="2">${esc(e?.mustNot.join("\n") ?? "")}</textarea>${c.expectation.pinned ? '<p class="muted">Clear both to take your edit back.</p>' : ""}</section>
      ${c.gold ? `<p><b>Gold</b>: ${esc(c.gold.why ?? c.gold.error ?? "")}</p>${c.gold.problems.length ? `<p class="bad">${c.gold.problems.map(esc).join("<br>")}</p>` : ""}` : ""}
      ${checks.length ? `<details><summary>Gold's free checks: ${checks.length}, failing then ${failing("then")}, now ${failing("now")}, on gold ${failing("gold")}</summary><div class="scroll"><table class="marks"><thead><tr><th>Check</th><th>then</th><th>now</th><th>gold</th></tr></thead><tbody>${checks.map((k) => `<tr><td><code>${esc(JSON.stringify(k.check))}</code></td>${checkCell(k.then)}${checkCell(k.now)}${checkCell(k.gold)}</tr>`).join("")}</tbody></table></div></details>` : ""}
      <textarea data-note rows="2" placeholder="A note for yourself (N; saved as you type, kept with your verdicts under real/)">${esc(c.review.note ?? "")}</textarea>
    </div>`;
}

function actsHtml(c: Card) {
  if (c.state === "labeled") return `<span class="muted">Still being labeled: verdicts open once it's proposed.</span>`;
  if (c.state === "skipped") return c.skip === NOT_DRAWING ? `<button class="primary" data-act="approve">It is a drawing request: reopen it <kbd>A</kbd></button>` : `<span class="muted">Skipped sends aren't cases: nothing to judge.</span>`;
  // Each reason by its short name, so the bar stays one line; the button's title has the whole sentence.
  const reasons = Object.entries(c.reasons).map(([k, v], n) => `<button data-reject="${esc(k)}" title="${esc(v)}"${c.review.reason === k ? ' class="on"' : ""}><kbd>${n + 1}</kbd> ${esc(k.replace(/-/g, " "))}</button>`).join("");
  return `<button class="primary" data-act="approve" title="A, or Ctrl+Enter from a field">Approve <kbd>A</kbd></button><span class="muted">or reject:</span>${reasons}`;
}

/**
 * Reviews `keys` from `start`: A approves (with any edits), 1–6 reject for that reason, J and K step, Z zooms an image,
 * E edits the meaning, N the note, Esc closes. A verdict shows the next card at once and saves behind it; a save that
 * fails says so, and K goes back to it.
 */
function review(keys: string[], start = 0) {
  let i = start, changed = false, current: Loaded | undefined, zoomed: Which | undefined, loading: ReturnType<typeof setTimeout> | undefined;
  const tally = { approved: 0, rejected: 0, failed: 0 };
  const cache = new Map<string, Promise<Loaded>>();
  const get = (k: string) => {
    let p = cache.get(k);
    if (!p) cache.set(k, (p = fetchCard(k))), p.catch(() => cache.delete(k));
    return p;
  };
  const host = document.createElement("div");
  host.className = "reviewer";
  host.innerHTML = `<header class="rv-bar"><b>Review</b><button data-step="-1" title="back (K)">‹ <kbd>K</kbd></button><span data-pos></span><button data-step="1" title="next (J)"><kbd>J</kbd> ›</button><span class="rv-meter"><span data-meter></span></span><span class="muted" data-tally></span><span class="rv-last" data-toast></span><button data-close aria-label="Close">✕</button></header>
    <div class="rv-main" data-main></div><footer class="rv-acts"><span class="rv-do" data-acts></span><span class="muted rv-keys">Z zoom · E edit · N note · Esc close</span></footer><div class="rv-zoom" data-zoomed hidden></div>`;
  document.body.append(host);
  document.body.classList.add("reviewing");
  const $$ = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
  const main = $$("[data-main]"), acts = $$("[data-acts]"), toast = $$("[data-toast]"), zoom = $$("[data-zoomed]");
  const say = (text: string, bad = false) => {
    toast.textContent = text;
    toast.classList.toggle("bad", bad);
  };
  const bar = () => {
    $$("[data-pos]").textContent = i < keys.length ? `${i + 1} of ${keys.length}` : `${keys.length} of ${keys.length}`;
    $$("[data-meter]").style.width = `${(100 * Math.min(i, keys.length)) / Math.max(1, keys.length)}%`;
    $$("[data-tally]").textContent = [tally.approved && `${tally.approved} approved`, tally.rejected && `${tally.rejected} rejected`, tally.failed && `${tally.failed} not saved`].filter(Boolean).join(" · ");
  };

  const go = (j: number) => {
    if (j < 0 || j > keys.length) return;
    i = j;
    unzoom();
    bar();
    // The window kept: the one before (to go back) to AHEAD after; the rest let go.
    for (const [k, p] of cache) {
      const at = keys.indexOf(k);
      if (at < i - 1 || at > i + AHEAD) cache.delete(k), forget(p);
    }
    if (i === keys.length) return finish();
    for (let x = i; x <= Math.min(i + AHEAD, keys.length - 1); x++) void get(keys[x]);
    clearTimeout(loading);
    // A card fetched ahead shows within this task; only one still on its way says so, after a moment.
    loading = setTimeout(() => ((main.innerHTML = '<p class="muted rv-wait">Loading…</p>'), (acts.innerHTML = "")), 150);
    const want = i;
    get(keys[i]).then(
      (l) => want === i && (clearTimeout(loading), render(l)),
      (err: Error) => want === i && (clearTimeout(loading), (main.innerHTML = `<p class="bad rv-wait">${esc(err.message)}</p>`), (acts.innerHTML = "")),
    );
  };

  let note: { el: HTMLTextAreaElement; sent: string; timer?: ReturnType<typeof setTimeout> } | undefined;
  const saveNote = async (key: string, n = note) => {
    if (!n) return;
    clearTimeout(n.timer);
    if (n.el.value === n.sent) return;
    const text = n.el.value;
    try {
      await post({ key, note: text });
      n.sent = text;
    } catch (err) {
      say(`note not saved: ${(err as Error).message}`, true);
    }
  };
  const render = (l: Loaded) => {
    current = l;
    const c = l.card;
    main.innerHTML = cardHtml(l);
    main.scrollTop = 0;
    acts.innerHTML = actsHtml(c);
    const el = main.querySelector<HTMLTextAreaElement>("[data-note]")!;
    const n: NonNullable<typeof note> = { el, sent: el.value };
    note = n;
    el.addEventListener("input", () => (clearTimeout(n.timer), (n.timer = setTimeout(() => void saveNote(c.key, n), 700))));
    el.addEventListener("blur", () => void saveNote(c.key, n));
  };
  // Approve carries the edits: its label says so once a field differs from the card as shown.
  main.addEventListener("input", () => {
    const c = current?.card;
    const b = acts.querySelector<HTMLButtonElement>('[data-act="approve"]');
    if (c && b && c.state !== "skipped") b.innerHTML = `${Object.keys(edits(c)).length ? "Save my edits and approve" : "Approve"} <kbd>A</kbd>`;
  });
  const val = (f: string) => main.querySelector<HTMLTextAreaElement>(`[data-edit="${f}"]`)?.value ?? "";
  /** Only what differs from the card as shown: an untouched field keeps its label, and where it came from. */
  const edits = (c: Card) => {
    const out: Record<string, unknown> = {};
    if (val("meant").trim() !== c.meant.now.trim()) out.meant = val("meant");
    const now = { should: lines(val("should")), mustNot: lines(val("mustNot")) };
    // Both cleared: the owner's edit taken back, so gold's rubric or the judge's draft judges the card again.
    if (!now.should.length && !now.mustNot.length) {
      if (c.expectation.pinned) out.expectation = null;
    } else if (JSON.stringify(now) !== JSON.stringify({ should: c.expectation.now?.should ?? [], mustNot: c.expectation.now?.mustNot ?? [] })) out.expectation = now;
    return out;
  };

  const verdict = async (a: "approve" | "reject", reason?: string) => {
    const c = current?.card;
    if (!c || c.key !== keys[i]) return;
    const reopens = c.state === "skipped" && c.skip === NOT_DRAWING;
    if (c.state === "labeled" || (c.state === "skipped" && !(reopens && a === "approve"))) return;
    const ed = a === "approve" && !reopens ? edits(c) : {};
    const body = { key: c.key, note: note?.el.value ?? "", verdict: a, ...(reason ? { reason } : {}), ...ed };
    const what = a === "reject" ? `rejected: ${c.reasons[reason!] ?? reason}` : reopens ? "reopened: it's labeled and proposed with the next intake" : Object.keys(ed).length ? "approved with your edits" : "approved";
    if (note) clearTimeout(note.timer);
    changed = true;
    // The cached copy is the card as it was: going back fetches it as it is now.
    const old = cache.get(c.key);
    cache.delete(c.key);
    go(i + 1);
    if (old) forget(old);
    const said = `“${c.said.slice(0, 60)}${c.said.length > 60 ? "…" : ""}”`;
    try {
      await post(body);
      tally[a === "reject" ? "rejected" : "approved"]++;
      say(`${said} ${what}`);
    } catch (err) {
      tally.failed++;
      say(`${said} not saved (${(err as Error).message}): K goes back to it`, true);
    }
    bar();
    if (i === keys.length) finish();
  };

  const finish = () => {
    current = undefined;
    main.innerHTML = `<div class="rv-done"><h2>That's all ${keys.length}</h2><p>${tally.approved} approved · ${tally.rejected} rejected${tally.failed ? ` · <span class="bad">${tally.failed} not saved</span>` : ""}</p><p class="muted">Rejected cards never join. Approved ones join the bank now; the rest after their look window.</p></div>`;
    acts.innerHTML = '<button class="primary" data-close>Back to the queue <kbd>Esc</kbd></button><span class="muted">or K to go back to the last card</span>';
  };

  const zoomTo = (w: Which | undefined) => {
    const l = current;
    const have = l ? shots(l.card).filter(([x]) => l.urls[x]) : [];
    const at = have.find(([x]) => x === w) ?? have.at(-1);
    if (!l || !at) return;
    zoomed = at[0];
    zoom.innerHTML = `<p>${esc(at[1])} <span class="muted">· ${have.indexOf(at) + 1} of ${have.length} · ← → the others · Esc or a click closes</span></p><img src="${l.urls[at[0]]}" alt="${esc(at[1])}">`;
    zoom.hidden = false;
  };
  const zoomStep = (by: number) => {
    const l = current!;
    const have = shots(l.card).filter(([x]) => l.urls[x]).map(([x]) => x);
    zoomTo(have[(have.indexOf(zoomed!) + by + have.length) % have.length]);
  };
  function unzoom() {
    zoomed = undefined;
    zoom.hidden = true;
  }

  const close = () => {
    window.removeEventListener("keydown", onKey);
    if (current && note) void saveNote(current.card.key);
    host.remove();
    document.body.classList.remove("reviewing");
    for (const p of cache.values()) forget(p);
    if (location.hash === "#go") history.replaceState(null, "", location.pathname + location.search);
    if (changed) void refresh();
  };

  const onKey = (e: KeyboardEvent) => {
    const field = (e.target as HTMLElement).closest<HTMLElement>("textarea, input, select");
    if (field) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.preventDefault(), void verdict("approve");
      else if (e.key === "Escape") e.preventDefault(), field.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (zoomed) {
      if (k === "ArrowRight" || k === "l") zoomStep(1);
      else if (k === "ArrowLeft" || k === "h") zoomStep(-1);
      else if (k === "Escape" || k === "z" || k === " ") unzoom();
      else return;
    } else if (k === "Escape") close();
    else if (k === "a") void verdict("approve");
    else if (/^[1-9]$/.test(k) && current) {
      const r = Object.keys(current.card.reasons)[Number(k) - 1];
      if (!r || current.card.state === "skipped") return;
      void verdict("reject", r);
    } else if (k === "j" || k === "ArrowRight") go(i + 1);
    else if (k === "k" || k === "ArrowLeft") go(i - 1);
    else if (k === "z" || k === " ") zoomTo("gold");
    else if (k === "e") main.querySelector<HTMLTextAreaElement>('[data-edit="meant"]')?.focus();
    else if (k === "n") main.querySelector<HTMLTextAreaElement>("[data-note]")?.focus();
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  host.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-zoomed]")) return unzoom();
    if (t.closest("[data-close]")) return close();
    const img = t.closest<HTMLElement>("[data-zoom]");
    if (img) return zoomTo(img.dataset.zoom as Which);
    const b = t.closest<HTMLElement>("button");
    if (b?.dataset.act) void verdict("approve");
    else if (b?.dataset.reject) void verdict("reject", b.dataset.reject);
    else if (b?.dataset.step) go(i + Number(b.dataset.step));
  });
  go(start);
}

// ---- Load and draw

let data: Intake | undefined;
function draw() {
  if (!data) return;
  $("#panels").replaceChildren();
  funnel(data);
  quality(data);
  queue(data);
}
const reviewing = () => document.body.classList.contains("reviewing");
async function refresh() {
  try {
    const r = await fetch("/api/eval/intake");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    data = await r.json();
    draw();
    // Eval HQ's links to the cards waiting land in the reviewer, not on the queue.
    const keys = shown(data!.cards).map((c) => c.key);
    if (location.hash === "#go" && keys.length && !reviewing()) review(keys);
  } catch (err) {
    $("#panels").innerHTML = `<section class="card wide"><h2>Can't read intake</h2><p class="muted">${esc((err as Error).message)}. Intake and review are served on the PGX only (evals/pages.vite.config.ts).</p></section>`;
  }
}
// Enter on the page starts the reviewer on the queue as filtered.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || reviewing() || (e.target as HTMLElement).closest("button, select, input, textarea, a")) return;
  document.querySelector<HTMLButtonElement>("[data-go]")?.click();
});
let resizing = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(() => draw());
});
void document.fonts.load("15px Excalifont").then(refresh, refresh);
