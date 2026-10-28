// Eval HQ's intake and review (evals/real/README.md): where the last pulls' sends are, how well they're labeled, and
// the queue of cards. A card is one tester's or the owner's send with everything its verdict needs: the board before
// (their ink numbered), what the app made then, today's champion on it, gold, their words with timings, the meaning and
// expectation it will be judged by (edit either and approve: the edit is pinned), and gold's free checks then, now and
// on gold. Approve (A), edit then approve (E), or reject with a reason (R); a card joins after its look window unless
// rejected. Everything comes from GET /api/eval/intake and /api/eval/card (evals/real/review.ts) on the PGX; the page
// keeps nothing but the filters (in the address).
import { openModal } from "../../src/modal.ts";
import { $ } from "../../src/ui.ts";
import { frame, legend } from "../progress/charts.ts";
import { hq } from "../progress/hq.ts";

hq("review", "Intake: new sends are pulled every 30 minutes, labeled between the loop's epochs (triage for every send, gold for each clear miss) and proposed here. A card joins the bank after its look window unless you reject it; approve it sooner, or edit what's wrong first.");

type State = "labeled" | "proposed" | "admitted" | "rejected";
type Rubric = { should: string[]; mustNot: string[] };
type Row = {
  key: string; state: State; tester: boolean; split: "tune" | "hold"; project: string; at: string; said: string; landed?: string; categories: string[]; gold: boolean;
  proposedAt?: string; admitAt?: string; verdict?: "approve" | "reject"; reason?: string; edited: { meant: boolean; expectation: boolean };
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
const filters = { state: params.get("state") ?? "proposed", who: params.get("who") ?? "all", landed: params.get("landed") ?? "all" };
const saveFilters = () => history.replaceState(null, "", `?${new URLSearchParams(filters)}${location.hash}`);
const shown = (rows: Row[]) =>
  rows
    .filter((r) => filters.state === "all" || r.state === filters.state)
    .filter((r) => filters.who === "all" || (filters.who === "tester") === r.tester)
    .filter((r) => filters.landed === "all" || (filters.landed === "missed" ? r.landed !== "yes" : r.landed === "yes"))
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
    <div class="filters">${opt("state", [["proposed", `proposed (${d.states.proposed ?? 0})`], ["labeled", `being labeled (${d.states.labeled ?? 0})`], ["admitted", `admitted (${d.states.admitted ?? 0})`], ["rejected", `rejected (${d.states.rejected ?? 0})`], ["all", "all"]])}
      ${opt("who", [["all", "everyone"], ["tester", "testers"], ["owner", "you"]])}${opt("landed", [["all", "landed or missed"], ["missed", "missed"], ["landed", "landed"]])}
      <span class="muted">${rows.length} shown · J and K step through them in a card</span></div>
    <div class="queue">${rows.map((r) => `<button class="item" data-key="${esc(r.key)}"><span class="chip ${r.state}">${r.state === "proposed" ? `joins ${esc(day(r.admitAt))}` : r.state === "labeled" ? "being labeled" : esc(r.state)}</span><span class="said">“${esc(r.said)}”</span><span class="muted">${r.landed === "yes" ? "landed" : r.landed ? `missed${r.gold ? " · gold" : ""}` : ""}</span><span class="meta muted">${esc(r.project)} · ${r.tester ? `tester${r.split === "hold" ? " (R-hold: R1 only)" : ""}` : "you"} · ${esc(day(r.at))}${r.categories.length ? ` · ${esc(r.categories.join(", "))}` : ""}${r.edited.meant || r.edited.expectation ? " · edited" : ""}${r.reason ? ` · ${esc(d.reasons[r.reason] ?? r.reason)}` : ""}</span></button>`).join("") || '<p class="muted">No card here.</p>'}</div>`;
  host.querySelectorAll<HTMLSelectElement>("select[data-filter]").forEach((s) =>
    s.addEventListener("change", () => {
      filters[s.dataset.filter as keyof typeof filters] = s.value;
      saveFilters();
      draw();
    }),
  );
  host.querySelectorAll<HTMLButtonElement>("button[data-key]").forEach((b) => b.addEventListener("click", () => void show(b.dataset.key!, rows.map((r) => r.key))));
}

// ---- One card

const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
const checkCell = (c?: Check) => (c ? `<td class="${c.pass ? "ok" : "bad"}">${c.pass ? "✓" : `✗ ${esc(c.why)}`}</td>` : '<td class="muted">-</td>');
const fig = (src: string | undefined, cap: string) => `<figure><figcaption>${esc(cap)}</figcaption>${src ? `<a href="${esc(src)}" target="_blank"><img loading="lazy" src="${esc(src)}" alt="${esc(cap)}"></a>` : '<div class="none">none</div>'}</figure>`;
const wordsHtml = (w: Card["send"]["words"], label: string) =>
  typeof w === "string" ? `<span>${esc(w || label || "(nothing said)")}</span>` : w.length ? w.map((x) => `<span><i>${(x.t0 / 1000).toFixed(1)}s</i>${esc(x.word)}</span>`).join("") : `<span>${esc(label || "(nothing said)")}</span>`;

function cardHtml(c: Card) {
  const e = c.expectation.now;
  const status = c.state === "proposed" ? `joins ${day(c.admitAt)} unless rejected` : c.state === "labeled" ? "still being labeled: it can't be judged yet" : c.state === "rejected" ? `rejected: ${c.reasons[c.review.reason ?? ""] ?? c.review.reason ?? ""}` : "admitted";
  return `<div class="sheet">
    <div class="row"><span class="chip ${c.state}">${esc(status)}</span><span class="muted">${esc(c.project)} · send ${c.send.n} of ${c.send.of} · ${c.tester ? `a tester's${c.split === "hold" ? " (R-hold: R1 only, never the bank)" : ""}` : "yours"} · ${esc(new Date(c.at).toLocaleString())} · ${esc(c.send.replay)}${c.send.kind === "build" ? " · a preview click" : ""}${c.send.status && c.send.status !== "done" ? ` · ${esc(c.send.status)}` : ""}</span></div>
    <div><div class="words">${wordsHtml(c.send.words, c.send.label)}</div>
      ${c.send.marks.length ? `<p class="muted">Ink, as the app read it: ${esc(c.send.marks.join("; "))}</p>` : ""}${c.send.refs ? `<p class="muted">What the app took them to mean: ${esc(c.send.refs)}</p>` : ""}
      ${c.previous ? `<p class="muted">The send before: “${esc(c.previous.said)}”</p>` : ""}${c.feedback.length ? `<p class="muted">Their written feedback on the project: ${c.feedback.map((f) => `“${esc(f.text)}”`).join("; ")}</p>` : ""}</div>
    <div class="shots">${fig(c.images.before, "before, their ink numbered")}${fig(c.images.then, "what the app made then")}${fig(c.images.champion, c.champion ? `today's champion (${c.champion.sha.slice(0, 7)})` : "today's champion")}${c.gold || c.images.gold ? fig(c.images.gold, "gold") : ""}</div>
    <div class="labels">
      <section><h3>Meant${c.meant.pinned ? " · your edit" : ""}</h3><textarea data-edit="meant" rows="3">${esc(c.meant.now)}</textarea>${c.meant.pinned && c.meant.drafted ? `<p class="muted">Triage said: ${esc(c.meant.drafted)} (clear yours to take it back)</p>` : ""}</section>
      <section><h3>Expectation${c.expectation.from === "owner" ? " · your edit" : c.expectation.from === "gold" ? " · gold's rubric" : c.expectation.from === "judge" ? " · drafted by the judge" : ""}</h3>
        <label class="muted">Should, one a line</label><textarea data-edit="should" rows="3">${esc(e?.should.join("\n") ?? "")}</textarea>
        <label class="muted">Must not, one a line</label><textarea data-edit="mustNot" rows="2">${esc(e?.mustNot.join("\n") ?? "")}</textarea>${c.expectation.pinned ? '<p class="muted">Clear both to take your edit back.</p>' : ""}</section>
    </div>
    ${c.triage ? `<p><b>Triage</b>: ${c.triage.landed === "yes" ? "landed" : c.triage.landed === "partly" ? "partly landed" : "missed"}${c.triage.categories.length ? ` · ${esc(c.triage.categories.join(", "))}` : ""} · ${esc(c.triage.evidence)}</p>` : ""}
    ${c.gold ? `<div><p><b>Gold</b>: ${esc(c.gold.why ?? c.gold.error ?? "")}</p>${c.gold.problems.length ? `<p class="bad">${c.gold.problems.map(esc).join("<br>")}</p>` : ""}
      ${c.gold.checks.length ? `<div class="scroll"><table class="marks"><thead><tr><th>Free check</th><th>then</th><th>now</th><th>gold</th></tr></thead><tbody>${c.gold.checks.map((k) => `<tr><td><code>${esc(JSON.stringify(k.check))}</code></td>${checkCell(k.then)}${checkCell(k.now)}${checkCell(k.gold)}</tr>`).join("")}</tbody></table></div>` : ""}</div>` : ""}
    <textarea data-note rows="2" placeholder="A note for yourself (saved as you type; stays with your verdicts under real/)">${esc(c.review.note ?? "")}</textarea>
    <div class="acts">${c.state === "labeled" ? '<span class="muted">Verdicts open once it is proposed.</span>' : `
      <button class="primary" data-act="approve">Approve<kbd>A</kbd></button>
      <button data-act="edit">Save my edits and approve<kbd>E</kbd></button>
      <select data-reason><option value="">reject because…</option>${Object.entries(c.reasons).map(([k, v]) => `<option value="${k}"${c.review.reason === k ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>
      <button data-act="reject">Reject<kbd>R</kbd></button>`}
      <span class="muted" data-said></span></div>
  </div>`;
}

/** A card in a sheet over the queue; J and K step through `keys`, A, E and R act. A verdict moves on to the next card. */
async function show(key: string, keys: string[]) {
  let current = key, changed = false;
  let act: ((a: string) => Promise<void>) | undefined;
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("textarea, input, select")) return;
    const k = e.key.toLowerCase();
    if (k === "j") step(1);
    else if (k === "k") step(-1);
    else if (k === "a" || k === "e" || k === "r") void act?.({ a: "approve", e: "edit", r: "reject" }[k]);
  };
  const m = openModal("Card", () => {
    window.removeEventListener("keydown", onKey);
    if (changed) void refresh();
  });
  window.addEventListener("keydown", onKey);
  const step = (by: number) => {
    const i = keys.indexOf(current) + by;
    if (i >= 0 && i < keys.length) void load((current = keys[i]));
  };
  const load = async (k: string) => {
    act = undefined;
    m.body.innerHTML = '<div class="sheet"><p class="muted">Loading…</p></div>';
    const r = await fetch(`/api/eval/card?${new URLSearchParams({ key: k })}`);
    if (!r.ok) return void (m.body.innerHTML = `<div class="sheet"><p class="bad">${esc((await r.json().catch(() => ({}))).error ?? r.status)}</p></div>`);
    const c: Card = await r.json();
    m.body.innerHTML = cardHtml(c);
    act = wire(c, k);
  };
  /** The card's note (saved as it's typed) and its verdict buttons; returns what A, E and R do. */
  const wire = (c: Card, k: string) => {
    const said = m.body.querySelector<HTMLElement>("[data-said]")!;
    const val = (f: string) => m.body.querySelector<HTMLTextAreaElement>(`[data-edit="${f}"]`)!.value;
    const note = m.body.querySelector<HTMLTextAreaElement>("[data-note]")!;
    const reason = m.body.querySelector<HTMLSelectElement>("[data-reason]");
    let timer: ReturnType<typeof setTimeout> | undefined, sent = note.value;
    const saveNote = async () => {
      clearTimeout(timer);
      if (note.value === sent) return;
      try {
        await post({ key: k, note: note.value });
        sent = note.value;
        said.textContent = "note saved";
      } catch (err) {
        said.textContent = `note not saved: ${(err as Error).message}`;
      }
    };
    note.addEventListener("input", () => {
      said.textContent = "…";
      clearTimeout(timer);
      timer = setTimeout(saveNote, 700);
    });
    note.addEventListener("blur", () => void saveNote());
    const verdict = async (a: string) => {
      if (c.state === "labeled") return;
      const body: Record<string, unknown> = { key: k, note: note.value };
      if (a === "reject") {
        if (!reason?.value) return void ((said.textContent = "pick why first"), reason?.focus());
        Object.assign(body, { verdict: "reject", reason: reason.value });
      } else {
        body.verdict = "approve";
        if (a === "edit") {
          // Only what differs from the card as shown: an untouched field keeps its label, and where it came from.
          if (val("meant").trim() !== c.meant.now.trim()) body.meant = val("meant");
          const now = { should: lines(val("should")), mustNot: lines(val("mustNot")) };
          // Both cleared: the owner's edit taken back, so gold's rubric or the judge's draft judges the card again.
          if (!now.should.length && !now.mustNot.length) {
            if (c.expectation.pinned) body.expectation = null;
          } else if (JSON.stringify(now) !== JSON.stringify({ should: c.expectation.now?.should ?? [], mustNot: c.expectation.now?.mustNot ?? [] })) body.expectation = now;
        }
      }
      try {
        await post(body);
        clearTimeout(timer);
        sent = note.value;
        changed = true;
        said.textContent = a === "reject" ? "rejected" : "approved";
        step(1);
      } catch (err) {
        said.textContent = `not saved: ${(err as Error).message}`;
      }
    };
    m.body.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => b.addEventListener("click", () => void verdict(b.dataset.act!)));
    return verdict;
  };
  await load(key);
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
async function refresh() {
  try {
    const r = await fetch("/api/eval/intake");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    data = await r.json();
    draw();
  } catch (err) {
    $("#panels").innerHTML = `<section class="card wide"><h2>Can't read intake</h2><p class="muted">${esc((err as Error).message)}. Intake and review are served on the PGX only (evals/pages.vite.config.ts).</p></section>`;
  }
}
let resizing = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(() => draw());
});
void document.fonts.load("15px Excalifont").then(refresh, refresh);
