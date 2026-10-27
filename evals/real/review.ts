// The owner's gold review (evals/real/README.md): each case's before (with the person's ink), what the app
// made and gold side by side, with what triage read and what gold will be judged by. Approve or reject posts
// to the review server (real.ts' serveReview), which appends review/verdicts.jsonl.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GoldCase, Verdict } from "./real.ts";
import type { Session } from "./sessions.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const said = (s: Session, n: number) => {
  const x = s.sends[n - 1];
  return typeof x.words === "string" ? x.words : x.label;
};

/** Only the send log keeps strokes: an older send's ink survives as the app's reading of it, not on the image. */
const beforeCaption = (x: Session["sends"][number]) =>
  x.strokes.length ? "before, with their ink" : x.replay === "ink" ? "before (their ink wasn't saved: the Ink line above is all that's left)" : "before (no ink)";

function card(g: GoldCase & { verdict?: Verdict; note?: string }, ss: { dir: string; s: Session } | undefined): string {
  if (!ss) return "";
  const { s } = ss;
  const x = s.sends[g.n - 1];
  const imgs = (() => {
    try {
      return JSON.parse(readFileSync(join(ss.dir, "img", "index.json"), "utf8"))[x.key] as { before: string; after: string } | undefined;
    } catch {
      return undefined;
    }
  })();
  const img = (src: string | undefined, cap: string) => `<figure>${src ? `<a href="${esc(src)}" target="_blank" title="full size"><img loading="lazy" src="${esc(src)}" alt="${esc(cap)}"></a>` : `<div class="none">none</div>`}<figcaption>${esc(cap)}</figcaption></figure>`;
  const checks = (g.gold?.checks ?? []).map((c, i) => {
    const a = g.appChecks[i], o = g.goldChecks[i];
    return `<tr><td><code>${esc(JSON.stringify(c))}</code></td><td class="${a?.pass ? "ok" : "bad"}">${a?.pass ? "passes" : `fails${a?.why ? `: ${esc(a.why)}` : ""}`}</td><td class="${o?.pass ? "ok" : "bad"}">${o?.pass ? "passes" : `fails${o?.why ? `: ${esc(o.why)}` : ""}`}</td></tr>`;
  }).join("");
  const state = g.verdict?.verdict ?? (g.batch > 1 ? "auto" : "open");
  return `<article id="${esc(g.key)}" data-state="${state}" data-key="${esc(g.key)}">
  <header><h2>${esc(s.project.name)} <span>send ${g.n} of ${s.sends.length} · ${s.admin ? "owner" : "tester"} · ${esc(x.replay)}${g.batch > 1 ? ` · batch ${g.batch}` : ""}</span></h2>
  <p class="said">“${esc(said(s, g.n) || "(nothing said)")}”</p>
  ${x.marks.length ? `<p class="marks">Ink: ${esc(x.marks.join("; "))}</p>` : ""}</header>
  <div class="row">${img(imgs && `sessions/${s.id}/img/${imgs.before}`, beforeCaption(x))}${img(imgs && `sessions/${s.id}/img/${imgs.after}`, "what the app made")}${img(g.gold ? `gold/${g.key.replace("#", "-")}/gold.jpg` : undefined, "gold")}</div>
  <dl>
    <dt>Meant</dt><dd>${esc(g.meant)}</dd>
    <dt>Missed</dt><dd><b>${esc(g.categories.join(", "))}</b> ${esc(g.evidence)}</dd>
    ${g.gold ? `<dt>Gold</dt><dd>${esc(g.gold.why)}</dd>
    <dt>Should</dt><dd><ul>${g.gold.rubric.should.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></dd>
    <dt>Must not</dt><dd><ul>${g.gold.rubric.mustNot.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></dd>` : `<dt>Error</dt><dd class="bad">${esc(g.error)}</dd>`}
    ${g.problems.length ? `<dt>Problems</dt><dd class="bad">${g.problems.map(esc).join("<br>")}</dd>` : ""}
  </dl>
  ${checks ? `<table><thead><tr><th>Free check</th><th>On the app's result</th><th>On gold</th></tr></thead><tbody>${checks}</tbody></table>` : ""}
  <footer>
    <textarea placeholder="Note (optional, saved as you type): what's wrong with gold">${esc(g.note ?? "")}</textarea>
    <button data-v="approve">Approve</button><button data-v="reject">Reject</button>
    <span class="saved"></span><span class="state">${state === "open" ? "" : state === "auto" ? "goes in unless rejected" : `${esc(state)}d`}</span>
  </footer>
</article>`;
}

export function reviewPage(cases: (GoldCase & { verdict?: Verdict; note?: string })[], sessionOf: (key: string) => { dir: string; s: Session } | undefined): string {
  const open = cases.filter((g) => !g.verdict && g.batch === 1).length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gold Review</title>
<style>
:root { --bg: #fafaf8; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e1dc; --card: #fff; --ok: #1f7a3a; --bad: #b3261e; --accent: #2b5fd9; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe6; --muted: #9b9a94; --line: #34332f; --card: #1f1f1d; --ok: #6cc489; --bad: #f08a80; --accent: #8fb0ff; } }
* { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 1400px; margin: 0 auto; padding: 16px; }
h1 { font-size: 22px; margin: 8px 0 4px; } .top { color: var(--muted); margin-bottom: 16px; } .top label { margin-left: 12px; }
article { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 20px; }
article[data-state="approve"] { border-color: var(--ok); } article[data-state="reject"] { border-color: var(--bad); }
body.hide-done article[data-state="approve"], body.hide-done article[data-state="reject"] { display: none; }
h2 { font-size: 17px; margin: 0; } h2 span { font-weight: 400; color: var(--muted); font-size: 14px; }
.said { font-size: 16px; margin: 6px 0; } .marks { color: var(--muted); margin: 0 0 6px; font-size: 13px; }
.row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 10px 0; }
@media (max-width: 800px) { .row { grid-template-columns: 1fr; } }
figure { margin: 0; } img { width: 100%; border: 1px solid var(--line); border-radius: 6px; display: block; background: #fff; }
.none { aspect-ratio: 1.6; display: grid; place-items: center; border: 1px dashed var(--line); border-radius: 6px; color: var(--muted); }
figcaption { color: var(--muted); font-size: 13px; text-align: center; }
dl { display: grid; grid-template-columns: 90px 1fr; gap: 4px 12px; margin: 8px 0; } dt { color: var(--muted); } dd { margin: 0; } ul { margin: 0; padding-left: 18px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; } td, th { border-top: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
code { font-size: 12px; word-break: break-all; } .ok { color: var(--ok); } .bad { color: var(--bad); }
footer { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
textarea { flex: 1 1 300px; min-height: 36px; font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
.saved { color: var(--muted); font-size: 13px; } button[data-v="approve"]:hover { border-color: var(--ok); } button[data-v="reject"]:hover { border-color: var(--bad); } .state { color: var(--muted); }
</style></head><body><main>
<h1>Gold review</h1>
<div class="top">${cases.length} cases · <b>${open}</b> of batch 1 still to look at · approved cases go into the real-use bench; a rejected one stays out.
<label><input type="checkbox" id="hide"> hide decided</label></div>
${cases.map((g) => card(g, sessionOf(g.key))).join("\n")}
</main>
<script>
document.getElementById("hide").addEventListener("change", (e) => document.body.classList.toggle("hide-done", e.target.checked));
// A note saves on its own, a moment after typing stops and when the box loses focus: never only with a verdict.
const timers = new WeakMap();
const saveNote = async (t) => {
  clearTimeout(timers.get(t));
  const a = t.closest("article"), s = a.querySelector(".saved");
  if (t.value === t.dataset.sent) return;
  const note = t.value;
  const res = await fetch("/api/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: a.dataset.key, note }) }).catch(() => undefined);
  if (res?.ok) { t.dataset.sent = note; s.textContent = "note saved"; } else s.textContent = "note not saved: try again";
};
for (const t of document.querySelectorAll("article textarea")) {
  t.dataset.sent = t.value;
  t.addEventListener("input", () => { t.closest("article").querySelector(".saved").textContent = "…"; clearTimeout(timers.get(t)); timers.set(t, setTimeout(() => saveNote(t), 700)); });
  t.addEventListener("blur", () => saveNote(t));
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-v]"); if (!b) return;
  const a = b.closest("article"); const note = a.querySelector("textarea").value.trim();
  const res = await fetch("/api/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: a.dataset.key, verdict: b.dataset.v, note }) });
  const s = a.querySelector(".state");
  if (!res.ok) { s.textContent = "not saved: " + (await res.text()); return; }
  a.dataset.state = b.dataset.v; s.textContent = b.dataset.v + "d";
  const t = a.querySelector("textarea"); t.dataset.sent = t.value;
});
</script></body></html>`;
}
