// T27's acceptance check: Eval HQ's reviewer (evals/review/) goes through the cards waiting with a key per verdict and
// shows the next at once. /evals/review/#go opens it on the next card to join; the next cards and their images are
// fetched ahead; A approves and the next card is up before the save returns; 1–6 reject for that reason; an edit rides
// on Ctrl+Enter's approve; K goes back to a card as it is now; Z zooms in place and Esc only closes the zoom; the last
// verdict ends on a tally; Esc closes and the queue is read again; a queue row opens the reviewer at that card. The card,
// its actions and its four images fit a laptop's window (a median card without scrolling, the longest as one page with
// the actions pinned), no panel or field scrolls on its own, what was said has no timestamps, and a phone's window has
// no sideways scroll. Synthetic cards on stubs, sized like the real ones: no tester's send, 0 model calls.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t27-review.mjs
import { join } from "node:path";
import { createServer } from "vite";
import { openChrome } from "./cdp.mjs";
import { ROOT, check, fail, finish, tempHome } from "./lib.mjs";

const PORT = 5270; // this task's ports are 5270–5279
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = tempHome();

const REASONS = { meaning: "the meaning is wrong", expectation: "the expectation is wrong", detail: "it asks for more detail than they did", fixed: "already fixed", "not-drawing": "not a drawing failure", unclear: "unclear" };
const day = (d) => new Date(Date.UTC(2026, 9, 28 + d, 12)).toISOString();
// Four waiting, listed out of order (the reviewer takes the next to join first), and one already in.
// The cards run the real sizes: k1 and k2 the median, k3 the 90th percentile, k4 the longest (a rambling send, every list full).
const filler = "and then the other part which I think should sit lower because it looks crowded next to the picture so maybe the whole thing wants more room around it and also the colors feel too loud for a bakery".split(" ");
const text = (n, pad = filler) => Array.from({ length: n }, (_, i) => pad[i % pad.length]).join(" ");
const said = { k1: "make the title bigger", k2: "put a sun in the corner", k3: `move these two together ${text(28)}`, k4: `a button that says buy ${text(141)}`, k5: "darker background" };
const items = (n, chars) => Array.from({ length: n }, (_, i) => `${["the title is visibly larger than the body text", "the two cards sit side by side with an even gap", "nothing else on the board moves or changes colour", "the button reads buy and stays inside the page frame", "the sun is drawn in the top right corner, not on the title"][i % 5]} ${text(Math.max(0, Math.round((chars - 50) / 6)))}`.trim());
const SIZE = {
  k1: { should: items(4, 108), mustNot: items(2, 110), meant: 75, evidence: 183, why: 0 },
  k2: { should: items(4, 108), mustNot: items(2, 110), meant: 75, evidence: 183, why: 0 },
  k3: { should: items(5, 113), mustNot: items(5, 61), meant: 146, evidence: 342, why: 306 },
  k4: { should: items(5, 138), mustNot: items(5, 68), meant: 204, evidence: 530, why: 442 },
  k5: { should: ["the change is made"], mustNot: ["the camera moves"], meant: 40, evidence: 40, why: 20 },
};
const cut = (n) => text(Math.ceil(n / 5), filler.slice(0, 12)).slice(0, n);
const rows = [
  { key: "k3", admitAt: day(3) }, { key: "k1", admitAt: day(1) }, { key: "k4", admitAt: day(4) }, { key: "k2", admitAt: day(2) }, { key: "k5", state: "admitted", admitAt: day(0) },
].map((r) => ({ state: "proposed", tester: true, split: "tune", project: "Bakery", at: day(-1), said: said[r.key], landed: "no", categories: ["layout"], gold: r.key !== "k2", proposedAt: day(-1), edited: { meant: false, expectation: false }, ...r }));
const intake = { lookDays: 2, reasons: REASONS, pull: { live: { pulledAt: day(-1) }, local: {} }, bank: { driver: 3, real: 1 }, states: { proposed: 4, admitted: 1 }, skipped: {}, rejected: {}, quality: [], cards: rows };
const img = (key, which) => `/api/eval/card-image?${new URLSearchParams({ key, which })}`;
const card = (key) => {
  const r = rows.find((x) => x.key === key);
  const z = { ...SIZE[key], meant: cut(SIZE[key].meant) };
  const decided = verdicts.findLast((v) => v.key === key && v.verdict);
  return {
    ...r, state: decided ? (decided.verdict === "reject" ? "rejected" : "admitted") : r.state, lookDays: 2, reasons: REASONS,
    // Seconds from the session's start, as the real ones are: they must not reach the screen.
    send: { n: 2, of: 3, kind: "send", replay: "timed", words: said[key].split(" ").map((word, i) => ({ word, t0: 7831700 + 400 * i })), label: "", marks: ["loop around [ink 1]"] },
    previous: { said: "a bakery page with a big photo of bread at the top", at: day(-1) }, feedback: key === "k4" ? [{ text: "the colours are too loud on the phone" }, { text: "I could not find where to order from the front page" }] : [],
    images: { before: img(key, "before"), then: img(key, "then"), champion: img(key, "champion"), ...(r.gold ? { gold: img(key, "gold") } : {}) },
    triage: { meant: z.meant, landed: "no", categories: ["layout"], evidence: cut(z.evidence) },
    meant: { now: z.meant, drafted: z.meant, pinned: false },
    expectation: { now: { should: z.should, mustNot: z.mustNot }, from: r.gold ? "gold" : "judge", pinned: false },
    gold: r.gold ? { why: z.why ? cut(z.why) : undefined, problems: key === "k4" ? ["the sun overlaps the title", "the gold has no button", "two labels collide", "the frame is cropped"] : [], checks: Array.from({ length: key === "k4" ? 4 : key === "k3" ? 4 : 1 }, (_, i) => ({ check: { kind: "exists", id: `title-${i}` }, then: { pass: false, why: "no title" }, now: { pass: true, why: "" }, gold: { pass: true, why: "" } })) } : undefined,
    champion: { sha: "c".repeat(40), run: "run-1" },
    review: decided ?? {},
  };
};

const verdicts = [];
const asked = { card: [], image: [] };
let jpeg;
const json = (o, status = 200) => ({ status, type: "application/json", body: JSON.stringify(o) });
const stubs = {
  "/api/eval/intake": () => json(intake),
  "/api/eval/card": ({ url }) => {
    const key = new URL(url).searchParams.get("key");
    asked.card.push(key);
    return rows.some((r) => r.key === key) ? json(card(key)) : json({ error: "no such card" }, 404);
  },
  "/api/eval/card-image": ({ url }) => {
    const q = new URL(url).searchParams;
    asked.image.push(`${q.get("key")}/${q.get("which")}`);
    return { type: "image/jpeg", body: jpeg };
  },
  // A slow save: the next card must be up long before it returns.
  "/api/eval/verdict": async ({ body }) => {
    const b = JSON.parse(body);
    verdicts.push(b);
    await sleep(b.verdict ? 800 : 0);
    return json({ ...b, at: new Date().toISOString() });
  },
};

const server = await createServer({ root: ROOT, configFile: join(ROOT, "evals/pages.vite.config.ts"), cacheDir: join(home, "vite-cache"), logLevel: "error", clearScreen: false, server: { port: PORT, strictPort: true, host: "127.0.0.1", watch: null } });
await server.listen();
const c = await openChrome({ width: 1280, height: 800, stubs });
const { page } = c;
await page.goto("about:blank");
jpeg = await page.shot({ format: "jpeg", quality: 80, clip: { x: 0, y: 0, width: 640, height: 400, scale: 1 } });

const waitFor = async (expr, what, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await page.eval(expr)) return;
  fail(`timed out waiting for ${what}`);
};
const key = (k, opts = {}, on = "document.activeElement || document.body") => page.eval(`(${on}).dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, ...${JSON.stringify(opts)} }))`);
const R = `(() => { const r = document.querySelector(".reviewer"); return r && { pos: r.querySelector("[data-pos]").textContent, words: r.querySelector(".words")?.textContent ?? "", tally: r.querySelector("[data-tally]").textContent,
  last: r.querySelector("[data-toast]").textContent, approve: r.querySelector('[data-act="approve"]')?.textContent ?? "", zoom: r.querySelector("[data-zoomed]").checkVisibility(), zoomed: r.querySelector("[data-zoomed] p")?.textContent ?? "",
  done: r.querySelector(".rv-done")?.textContent ?? "", imgs: r.querySelectorAll(".rv-shots img").length, bar: r.querySelector(".rv-bar").getBoundingClientRect().height, loaded: [...r.querySelectorAll(".rv-shots img")].every((i) => i.complete && i.naturalWidth === 640) }; })()`;
/** How the card on screen sits: the page alone scrolls, every field shows all of its text, the actions stay in view and uncovered. */
const SHAPE = `(() => { const r = document.querySelector(".reviewer"), b = (s) => r.querySelector(s).getBoundingClientRect(), a = b('[data-act="approve"]');
  return { over: document.documentElement.scrollHeight - innerHeight, wide: document.documentElement.scrollWidth - innerWidth, nested: [...r.querySelectorAll("*")].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY + getComputedStyle(e).overflowX)).map((e) => e.className || e.tagName),
    clipped: [...r.querySelectorAll("textarea")].filter((t) => t.scrollHeight > t.clientHeight + 1).map((t) => t.dataset.edit ?? "note"), fields: r.querySelectorAll("textarea").length, stamps: /\d\.\ds/.test(r.querySelector(".words").textContent),
    acts: b(".rv-acts").bottom <= innerHeight + 1 && b(".rv-acts").height < 52, bar: b(".rv-bar").top >= 0, onTop: !!document.elementFromPoint(a.x + a.width / 2, a.y + a.height / 2)?.closest('[data-act="approve"]'),
    shots: b(".rv-shots").bottom, imgW: Math.round(r.querySelector(".rv-shots img").getBoundingClientRect().width), zoom: r.querySelector("[data-zoomed]").checkVisibility() }; })()`;
/** A real click at the middle of `sel`: whatever is on top there gets it, as a person's would. */
const mouse = async (sel) => {
  const at = await page.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
};
/** Every word said in `k` is on the card shown. */
/** Until the stubs have `n` verdicts: a POST reaches them a moment after its key. */
const posted = async (n) => {
  for (const end = Date.now() + 3000; verdicts.length < n && Date.now() < end; ) await sleep(25);
};
const shows = (r, k) => !!r && said[k].split(" ").every((w) => r.words.includes(w));

// ---- #go opens the reviewer on the next card to join, with the next two fetched ahead, images and all.
await page.goto(`http://127.0.0.1:${PORT}/evals/review/#go`);
await waitFor(`!!document.querySelector(".reviewer .words")`, "the reviewer on #go");
let r = await page.eval(R);
check(r.pos === "1 of 4" && shows(r, "k1"), `#go opens on k1, 1 of 4: ${JSON.stringify(r)}`);
await waitFor(`document.querySelectorAll(".reviewer .rv-shots img").length === 4 && [...document.querySelectorAll(".reviewer .rv-shots img")].every((i) => i.complete && i.naturalWidth === 640)`, "k1's four images");
for (let end = Date.now() + 5000; Date.now() < end && !["k2", "k3"].every((k) => asked.image.filter((x) => x.startsWith(`${k}/`)).length === (k === "k2" ? 3 : 4)); ) await sleep(25);
check(JSON.stringify([...new Set(asked.card)].sort()) === JSON.stringify(["k1", "k2", "k3"]) && asked.image.filter((x) => x.startsWith("k2/")).length === 3 && asked.image.filter((x) => x.startsWith("k3/")).length === 4 && !asked.image.some((x) => x.startsWith("k4/")),
  `fetched ahead: cards ${JSON.stringify(asked.card)}, images ${JSON.stringify(asked.image)}`);

// The window holds a median card: all four images, the meaning, the expectation and the actions, with no scrolling at all.
let fit = await page.eval(SHAPE);
check(fit.over <= 0 && fit.wide <= 0 && !fit.nested.length && !fit.clipped.length && fit.fields >= 6 && !fit.stamps && fit.acts && fit.bar && fit.onTop && !fit.zoom, `at 1280×800 a median card doesn't fit without scrolling, whole in its fields, actions on one line and uncovered: ${JSON.stringify(fit)}`);

// ---- A approves: the next card is up while the save is still on its way.
await sleep(200); // the blobs asked for above, in
await key("a");
r = await page.eval(R);
check(r.pos === "2 of 4" && shows(r, "k2") && r.tally === "", `after A, k2 is up before the save returns: ${JSON.stringify(r)}`);
await waitFor(`document.querySelectorAll(".reviewer .rv-shots img").length === 3 && [...document.querySelectorAll(".reviewer .rv-shots img")].every((i) => i.complete && i.naturalWidth === 640)`, "k2's three images (no gold) at once", 300);
await posted(1);
check(JSON.stringify(verdicts[0]) === JSON.stringify({ key: "k1", note: "", verdict: "approve" }), `A posted ${JSON.stringify(verdicts[0])}`);
await waitFor(`/1 approved/.test(document.querySelector(".reviewer [data-tally]").textContent)`, "the approve saved");
r = await page.eval(R);
check(/make the title bigger” approved$/.test(r.last) && r.bar < 52, `the bar says what was done on one line: "${r.last}", ${r.bar} px high`);

// ---- 2 rejects k2 for the expectation, the second reason.
await key("2");
r = await page.eval(R);
check(r.pos === "3 of 4" && shows(r, "k3"), `after 2, k3 is up: ${JSON.stringify(r)}`);
await posted(2);
check(JSON.stringify(verdicts[1]) === JSON.stringify({ key: "k2", note: "", verdict: "reject", reason: "expectation" }), `2 posted ${JSON.stringify(verdicts[1])}`);

// ---- k3 is the 90th percentile: it fits a 1440×900 window too.
await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await waitFor(`[...document.querySelectorAll(".reviewer .rv-shots img")].length === 4 && [...document.querySelectorAll(".reviewer .rv-shots img")].every((i) => i.complete)`, "k3's images");
fit = await page.eval(SHAPE);
check(fit.over <= 0 && !fit.nested.length && !fit.clipped.length && !fit.stamps && fit.acts && fit.onTop, `at 1440×900 a p90 card doesn't fit without scrolling: ${JSON.stringify(fit)}`);
await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

// ---- An edit to the meaning, approved with Ctrl+Enter from the field: the button says so first.
await page.eval(`(() => { const t = document.querySelector('.reviewer [data-edit="meant"]'); t.focus(); t.value = "group the two cards side by side"; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
r = await page.eval(R);
const actsHigh = await page.eval(`document.querySelector(".reviewer .rv-acts").getBoundingClientRect().height`);
check(/^Save my edits and approve/.test(r.approve) && actsHigh < 52, `the approve button after an edit: "${r.approve}", the actions ${actsHigh} px high`);
await key("a", {}, `document.querySelector('.reviewer [data-edit="meant"]')`);
check((await page.eval(R)).pos === "3 of 4", "A typed in a field acted as a verdict");
await key("Enter", { ctrlKey: true }, `document.querySelector('.reviewer [data-edit="meant"]')`);
r = await page.eval(R);
await posted(3);
check(r.pos === "4 of 4" && JSON.stringify(verdicts[2]) === JSON.stringify({ key: "k3", note: "", verdict: "approve", meant: "group the two cards side by side" }), `Ctrl+Enter posted ${JSON.stringify(verdicts[2])}, at ${r.pos}`);

// ---- A list is edited in place: Enter adds an item, Backspace on an empty one drops it.
const listed = await page.eval(`document.querySelectorAll('.reviewer [data-edit="should"]').length`);
await key("Enter", {}, `document.querySelector('.reviewer [data-edit="should"]')`);
r = await page.eval(`(() => ({ items: document.querySelectorAll('.reviewer [data-edit="should"]').length, on: document.activeElement.dataset.edit, pos: document.querySelector(".reviewer [data-pos]").textContent }))()`);
check(r.items === listed + 1 && r.on === "should" && r.pos === "4 of 4", `Enter in a list adds an item: ${JSON.stringify(r)}`);
await key("Backspace");
r = await page.eval(`document.querySelectorAll('.reviewer [data-edit="should"]').length`);
check(r === listed, `Backspace on an empty item drops it: ${r}`);
await key("Escape");

// ---- K goes back to k3 as it is now (fetched again), J forward.
await waitFor(`/2 approved · 1 rejected/.test(document.querySelector(".reviewer [data-tally]").textContent)`, "three verdicts saved");
const k3Asks = asked.card.filter((k) => k === "k3").length;
await key("k");
await waitFor(`document.querySelector(".reviewer [data-pos]").textContent === "3 of 4" && !!document.querySelector(".reviewer .chip.admitted")`, "k3 again, admitted");
check(asked.card.filter((k) => k === "k3").length === k3Asks + 1, `going back fetched k3 again: ${JSON.stringify(asked.card)}`);
await key("j");
await waitFor(`document.querySelector(".reviewer [data-pos]").textContent === "4 of 4" && /buy/.test(document.querySelector(".reviewer .words").textContent)`, "k4 after J");

// ---- k4 is the longest card: the page scrolls as one, the actions stay in view, nothing else scrolls.
fit = await page.eval(SHAPE);
check(fit.over > 100 && !fit.nested.length && !fit.clipped.length && !fit.stamps && fit.acts && fit.bar && fit.onTop, `the longest card at 1280×800 should scroll the page alone, actions pinned: ${JSON.stringify(fit)}`);
await page.eval(`scrollTo(0, document.documentElement.scrollHeight)`);
fit = await page.eval(SHAPE);
check(fit.acts && fit.bar && fit.onTop && (await page.eval(`scrollY`)) > 100, `scrolled to the end of the longest card the actions are still in view: ${JSON.stringify(fit)}`);
await page.eval(`scrollTo(0, 0)`);

// ---- Z zooms in place (gold first), the arrows go round the four, Esc closes the zoom only.
await key("z");
r = await page.eval(R);
check(r.zoom && /^gold · 4 of 4/.test(r.zoomed), `Z zooms gold: ${JSON.stringify([r.zoom, r.zoomed])}`);
await key("ArrowRight");
check(/^before, their ink numbered · 1 of 4/.test((await page.eval(R)).zoomed), `→ in the zoom goes round to before: ${(await page.eval(R)).zoomed}`);
await key("Escape");
r = await page.eval(R);
check(r && !r.zoom && r.pos === "4 of 4", `Esc closed the zoom, not the reviewer: ${JSON.stringify(r)}`);
await mouse('.reviewer .rv-shots img[data-zoom="then"]');
r = await page.eval(R);
check(r.zoom && /^what the app made then/.test(r.zoomed), `a click on an image zooms it: ${JSON.stringify([r.zoom, r.zoomed])}`);
await mouse(".reviewer [data-zoomed] img");
check(!(await page.eval(R)).zoom, "a click on the zoom closes it");

// ---- The last verdict (a click on Approve) ends on the tally; Esc closes and the queue is read again; a row opens the reviewer there.
await mouse('.reviewer [data-act="approve"]');
await waitFor(`/3 approved · 1 rejected/.test(document.querySelector(".reviewer .rv-done")?.textContent ?? "")`, "the tally at the end");
const intakes = c.counts()["/api/eval/intake"];
await key("Escape");
await waitFor(`!document.querySelector(".reviewer") && !document.body.classList.contains("reviewing")`, "the reviewer closed");
for (let end = Date.now() + 3000; Date.now() < end && c.counts()["/api/eval/intake"] === intakes; ) await sleep(25);
check(c.counts()["/api/eval/intake"] === intakes + 1 && (await page.eval("location.hash")) === "", `after Esc: intake read ${c.counts()["/api/eval/intake"] - intakes} more times, hash "${await page.eval("location.hash")}"`);
const queue = await page.eval(`[...document.querySelectorAll('[data-panel="queue"] button[data-key]')].map((b) => b.dataset.key)`);
check(JSON.stringify(queue) === JSON.stringify(["k1", "k2", "k3", "k4"]), `the queue, the next to join first: ${JSON.stringify(queue)}`);
await page.eval(`document.querySelector('[data-panel="queue"] button[data-key="k3"]').click()`);
await waitFor(`document.querySelector(".reviewer [data-pos]")?.textContent === "3 of 4" && /together/.test(document.querySelector(".reviewer .words")?.textContent ?? "")`, "a queue row opening the reviewer at k3");
await key("Escape");
await waitFor(`!document.querySelector(".reviewer")`, "the reviewer closed again");
await key("Enter", {}, "document.body");
await waitFor(`document.querySelector(".reviewer [data-pos]")?.textContent === "1 of 4"`, "Enter on the page starting the reviewer");

// ---- A phone's window: no sideways scroll, the actions reachable.
await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(200);
const phone = await page.eval(`(() => { const r = document.querySelector(".reviewer"), b = (s) => r.querySelector(s).getBoundingClientRect(); return { over: Math.max(r.scrollWidth, document.documentElement.scrollWidth) - innerWidth, main: r.querySelector(".rv-main").scrollWidth - r.querySelector(".rv-main").clientWidth,
  acts: b(".rv-acts").bottom <= innerHeight + 1, stacked: b(".rv-side").top >= b(".rv-shots").bottom - 1 }; })()`);
check(phone.over <= 0 && phone.main <= 0 && phone.acts && phone.stacked, `at 390 px: ${JSON.stringify(phone)}`);

const n = c.counts();
check(n.seen === n.stubbed && !n["/api/model"], `seen ${n.seen} != stubbed ${n.stubbed}: ${JSON.stringify(n)}`);
check(!c.errors.length, `page errors: ${c.errors.join(" | ")}`);
const left = await c.close();
check(left === 0, `${left} Chrome processes left`);
await server.close();
finish();
