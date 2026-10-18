// T8's acceptance check: the driver's shared prompt, its parser on the 80 stored
// real replies and on crafted ones, history without coordinates, the scenario
// table (plans, quotas, coverage, coherence, held-out order) and the §2.3 gates.
// Pure functions: 0 model calls, no Chrome, no server.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t8-driver.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, check, finish, tempHome } from "./lib.mjs";

tempHome();
const D = await import("../core/driver.ts");
const P = await import("../core/personas.ts");
const S = await import("../core/scenarios.ts");
const { DRIVE_VIEW } = await import("../loop/config.ts");
const START = { x: 0, y: -60, w: 1280, h: 800 };
const k = START.w / DRIVE_VIEW.screenW;
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---- The 80 stored real replies (50 from the dev server's log, 30 from the driver pilot) parse with 0 throws.
const stored = readFileSync(join(ROOT, "evals/checks/data/driver-replies.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check(stored.length === 80, `${stored.length} stored replies, not 80`);
let throws = 0;
const parsed = [];
for (const { reply, src } of stored) {
  try {
    parsed.push(D.parseTurn(reply, START));
  } catch (err) {
    throws++;
    check(false, `stored reply ${src} throws: ${err.message}`);
  }
}
check(throws === 0 && parsed.length === 80, `${throws} of 80 stored replies throw`);
check(parsed.reduce((n, p) => n + p.turn.steps.length, 0) > 300, "the stored replies parse into almost no steps");

// ---- One system prompt for every scenario: no arguments, nothing of a persona, style or target in it.
const sys = D.systemPrompt();
check(D.systemPrompt.length === 0 && D.systemPrompt() === sys, "systemPrompt() takes arguments or changes between calls");
const scenarios = [...S.TUNING, ...S.HELDOUT_GATE, ...S.HELDOUT_CHART, ...[0, 1, 2, 3].flatMap(S.fresh)];
const leaked = [...P.PERSONAS.map((p) => p.who), ...P.TARGETS.flatMap((t) => [t.memory, t.parts]), ...P.STYLES.map((s) => s.name), ...S.BEATS.map((b) => (typeof b.text === "string" ? b.text : b.text("left", 1)))].filter((t) => sys.includes(t));
check(!leaked.length, `the system prompt holds per-session text: ${leaked[0]}`);
check(!/okay so|bigger/i.test(sys), "the system prompt still primes \"okay so\" or \"bigger\"");
for (const want of ['{"say": "<words>"}, {"draw": "<kind>", ...}', '"meant"', '"testing"', '"beat_done"', '{"undo": true}', '"sketch"', '"scroll"', '"look"', `${DRIVE_VIEW.screenW}×${DRIVE_VIEW.screenH}`]) check(sys.includes(want), `the system prompt lacks ${want}`);

// ---- History and moves by kind and coarse place: no coordinates reach the driver.
const coords = /\d+(\.\d+)?\s*,\s*-?\d|\[\s*-?\d/;
const past = parsed.filter((p) => p.turn.steps.some((s) => "draw" in s)).map((p) => ({ said: "make this one bigger", marks: D.describeMarks(p.turn.steps, START), meant: "the box gets bigger", satisfaction: 3, feeling: "meh" }));
const marks = past.flatMap((p) => p.marks);
check(marks.length > 100 && marks.every((m) => !/\d/.test(m)), `a mark description holds a number: ${marks.find((m) => /\d/.test(m))}`);
const moves = parsed.flatMap((p) => p.turn.steps.filter((s) => "scroll" in s || "zoom" in s || "look" in s)).concat([{ scroll: [300, -40] }, { zoom: "out" }, { look: [100, 100, 200, 100] }, { undo: true }]).map((s) => D.describeMove(s, START));
check(moves.every((m) => !/\d/.test(m)), `a move description holds a number: ${moves.find((m) => /\d/.test(m))}`);
const lines = D.describePast(past);
check(lines.every((l) => !coords.test(l) && !/\d/.test(l.replace(/^\d+\. /, "").replace(/ \d\/5:/, ""))), `a history line holds coordinates: ${lines.find((l) => coords.test(l))}`);
const card = { persona: P.personaOf("first-timer"), style: P.styleOf("pointer"), target: P.targetOf("bakery") };
const msg = D.userMessage(card, past.slice(0, 4), { id: "two-cand", text: "say this" }, "move", 2, moves.slice(0, 3));
check(!coords.test(msg), "the user message holds coordinates");
check(msg.includes(P.targetOf("bakery").memory) && !msg.includes(P.targetOf("bakery").parts), "a first-timer's message holds the target's parts, or not its memory");
check(msg.includes("This send's twist: say this") && msg.includes("move something somewhere else") && msg.includes("You point with the pen"), "the user message lacks the beat, the ask or the pen lines");
const talker = D.userMessage({ persona: P.personaOf("breaker"), style: P.styleOf("talker") }, [], undefined, "add", 5);
check(talker.includes("you almost never draw") && !talker.includes("You point with the pen") && talker.includes('Fill "testing"'), "a pen-less breaker's message keeps the pen lines or lacks the testing ask");

// ---- plan() over 1,000 seeds: the §2.2 ask quotas within 3 points, every beat used.
const quota = { "first-timer": S.quotaOf("first-timer"), other: S.quotaOf("explorer") };
const asks = { "first-timer": S.ASKS.map(() => 0), other: S.ASKS.map(() => 0) };
const beatsUsed = new Set();
const tuningTargets = P.TARGETS.filter((t) => !t.heldOut).map((t) => t.id);
const random = [];
for (let seed = 0; seed < 1000; seed++) {
  const persona = ["first-timer", "first-timer", "explorer", "breaker"][seed % 4];
  const c = P.COHERENT[persona];
  random.push({ id: `r${seed}`, set: "tuning", persona, style: c.styles[Math.floor(seed / 4) % c.styles.length], start: c.starts[Math.floor(seed / 7) % c.starts.length], target: persona === "first-timer" ? tuningTargets[seed % tuningTargets.length] : undefined, sends: 5, seed });
}
for (const s of random) {
  check(S.incoherent(s) === undefined, `the check's own scenario ${s.id} is incoherent: ${S.incoherent(s)}`);
  for (const p of S.plan(s)) {
    asks[s.persona === "first-timer" ? "first-timer" : "other"][S.ASKS.indexOf(p.ask)]++;
    if (p.beat) beatsUsed.add(p.beat.id);
  }
}
for (const g of ["first-timer", "other"]) {
  const n = asks[g].reduce((a, b) => a + b, 0);
  S.ASKS.forEach((a, i) => check(Math.abs(asks[g][i] / n - quota[g][i]) <= 0.03, `${g} asks: ${a} is ${((asks[g][i] / n) * 100).toFixed(1)}% against a quota of ${quota[g][i] * 100}%`));
}
check(S.BEATS.every((b) => beatsUsed.has(b.id)), `plan() never uses ${S.BEATS.filter((b) => !beatsUsed.has(b.id)).map((b) => b.id)}`);
check(JSON.stringify(S.plan(S.TUNING[3])) === JSON.stringify(S.plan({ ...S.TUNING[3] })), "plan() isn't deterministic");
const noBeat = random.flatMap(S.plan).filter((p) => !p.beat).length / (random.length * 5);
check(noBeat > 0.25 && noBeat < 0.45, `${Math.round(noBeat * 100)}% of sends have no beat (about 40% wanted)`);

// ---- The lists: 32 tuning, 8 + 8 held-out on their own seeds, coherent, in build order.
check(S.TUNING.length === 32 && S.TUNING.every((s) => s.set === "tuning" && s.sends === 5 && (s.seed < 9000 || s.seed > 9999)), "the tuning list isn't 32 sessions of 5 sends off the held-out seeds");
check(S.HELDOUT_GATE.length === 8 && S.HELDOUT_GATE.every((s) => s.set === "heldout-gate" && s.sends === 4 && s.seed >= 9000 && s.seed <= 9499), "H-gate isn't 8 sessions of 4 sends on seeds 9000–9499");
check(S.HELDOUT_CHART.length === 8 && S.HELDOUT_CHART.every((s) => s.set === "heldout-chart" && s.sends === 4 && s.seed >= 9500 && s.seed <= 9999), "H-chart isn't 8 sessions of 4 sends on seeds 9500–9999");
check(S.fresh(3).length === 8 && S.fresh(3).every((s) => s.seed >= 10000) && JSON.stringify(S.fresh(3)) === JSON.stringify(S.fresh(3)), "fresh() isn't 8 deterministic sessions on new seeds");
const ids = scenarios.map((s) => s.id);
check(new Set(ids).size === ids.length && new Set(scenarios.map((s) => s.seed)).size === scenarios.length, "scenario ids or seeds repeat");
const mix = (p) => S.TUNING.filter((s) => s.persona === p).length;
check(mix("first-timer") === 16 && mix("explorer") === 8 && mix("breaker") === 8, "the tuning persona mix isn't 50/25/25");
check(S.HELDOUT_CHART.filter((s) => s.persona !== "first-timer").every((s) => s.start === "grid" || /^site:(notion|uber|lesson)$/.test(s.start)), "an H-chart explorer or breaker starts off grid and the held-out sites");
check(["first-timer", "explorer", "breaker"].every((p) => S.HELDOUT_GATE.some((s) => s.persona === p) && S.HELDOUT_CHART.some((s) => s.persona === p)), "a held-out set lacks a persona");
const heldStarts = new Set([...S.HELDOUT_GATE, ...S.HELDOUT_CHART].map((s) => s.start));
check(["grid", "toyshop-cart", "messy-zoomed-out"].every((st) => heldStarts.has(st)) && [...heldStarts].some((st) => st.startsWith("site:")), "the held-out sets miss a held-out-only start");
check(S.TUNING.every((s) => !heldStarts.has(s.start) || s.start === "blank") && S.TUNING.every((s) => !s.target || !P.targetOf(s.target).heldOut), "a tuning session uses a held-out start or target");
for (const list of [S.HELDOUT_GATE, S.HELDOUT_CHART]) {
  check(S.outOfOrder(list) === undefined, `held-out order: ${S.outOfOrder(list)}`);
  const ft = list.findIndex((s) => s.persona === "first-timer" && list.some((o) => o.start === `site:${s.target}`));
  check(ft >= 0 && list.filter((s) => s.start.startsWith("site:")).every((s) => list.findIndex((o) => o === s) > list.findIndex((o) => o.persona === "first-timer" && `site:${o.target}` === s.start)), "a site:<target> session comes before its first-timer");
}
const swapped = [...S.HELDOUT_CHART].reverse();
check(S.outOfOrder(swapped) !== undefined, "outOfOrder() misses a site:<target> start before its first-timer");

// ---- Coherence (§2.2, D15): every listed scenario; pen-less styles get no ink beat; first-timers stay on their own site; breakers draw.
for (const s of scenarios) check(S.incoherent(s) === undefined, `${s.id}: ${S.incoherent(s)}`);
const INK = new Set(["amb-arrow", "amb-shape", "two-cand", "sketch"]);
const all = [...scenarios, ...random];
check(all.filter((s) => P.styleOf(s.style).pen < P.PEN_MIN).flatMap(S.plan).every((p) => !INK.has(p.beat?.id)), "a pen-less style got an ink beat");
check(all.filter((s) => s.persona === "first-timer").every((s) => s.start === "blank" || s.start === `resume:${s.target}`), "a first-timer starts on another target's site");
check(all.filter((s) => s.persona === "breaker").every((s) => P.styleOf(s.style).pen >= P.PEN_MIN), "a breaker got a pen-less style");
const bad = [
  { ...S.TUNING[0], start: "site:notion" }, { ...S.TUNING[0], start: "resume:music" }, { ...S.TUNING[24], style: "talker" },
  { ...S.TUNING[16], start: "grid" }, { ...S.HELDOUT_CHART[4], start: "toyshop-cart" }, { ...S.TUNING[0], target: "uber" },
];
check(bad.every((s) => S.incoherent(s) !== undefined), `incoherent() accepts ${JSON.stringify(bad.find((s) => !S.incoherent(s)))}`);
check(P.TARGETS.length === 10 && P.TARGETS.every((t) => t.memory && t.parts && t.memory !== t.parts) && ["notion", "uber"].every((id) => P.targetOf(id)), "the 10 targets with memory and parts aren't there");

// ---- The lists' planned coverage leaves room for non-compliance under the §2.3 gates.
const planned = (list) => list.flatMap((s) => S.plan(s).map((p) => ({ s, p })));
const T = planned(S.TUNING);
const H = planned([...S.HELDOUT_GATE, ...S.HELDOUT_CHART]);
for (const b of S.BEATS) {
  const n = (xs) => xs.filter((x) => x.p.beat?.id === b.id).length;
  // An undo applies only after a send rated 3 or less: about half (the pilot's ratings).
  const [t, h] = b.id === "undo" ? [n(T) / 2, n(H) / 2] : [n(T), n(H)];
  check(t >= 8 && h >= 3, `beat ${b.id}: planned ${t} tuning and ${h} held-out (need 8 and 3 for the gates' 6 and 2)`);
}
for (const a of S.ASKS) check(T.filter((x) => x.p.ask === a).length >= 12, `ask ${a}: fewer than 12 planned tuning cases`);
const gc = (xs, over = {}) => xs.map(({ s, p }) => ({ set: s.set, persona: s.persona, start: s.start, send: p.send, ask: p.ask, beat: p.beat?.id, complied: true, hedged: false, void: false, opener: "so", ...over }));
const bank = [...gc(T), ...gc(H)];
check(S.gates(bank).length === 0, `the planned bank fails its own gates: ${S.gates(bank).join("; ")}`);
const skewed = [...gc(T, { ask: "add" }), ...gc(H, { opener: "okay so, this" })];
const fails = S.gates(skewed);
check(fails.some((f) => f.startsWith("ask remove")) && fails.some((f) => f.includes("okay so")), `a skewed bank passes the gates (${fails.join("; ")})`);
check(S.gates(bank.map((c, i) => ({ ...c, hedged: i % 5 === 0 }))).some((f) => f.startsWith("hedged")), "the hedge gate misses 20% hedged cases");
check(S.gates(bank.map((c, i) => ({ ...c, void: i % 10 === 0 }))).some((f) => f.startsWith("voids")), "the void gate misses 10% voids");
const piled = bank.map((c) => (c.start === "clowns" && c.send === 1 ? { ...c, firstTarget: "hero" } : c));
check(S.gates([...piled, ...piled.filter((c) => c.start === "clowns" && c.send === 1)]).some((f) => f.startsWith("start clowns")), "the target-spread gate misses first asks piled on one shape");

// ---- Beat checks, read free from a parsed turn.
const turn = (steps, meant = "the header gets a new logo") => ({ meant, steps, stop: false, hedged: false });
const ctx = { send: 2, looks: [], view: START, shapes: [{ x: 100, y: 100, w: 200, h: 100 }, { x: 320, y: 100, w: 200, h: 100 }], pages: [{ name: "Cart", box: { x: 3000, y: 0, w: 1280, h: 800 } }], lastMeant: "the header gets a big orange banner" };
const beat = (id) => S.beatOf(id).check;
const yes = {
  "amb-arrow": turn([{ say: "this" }, { draw: "arrow", from: [600, 500], to: [680, 500] }]),
  "amb-shape": turn([{ say: "something here" }, { draw: "box", box: [700, 400, 100, 100] }]),
  "two-cand": turn([{ say: "this one" }, { draw: "tap", at: [310, 150] }]),
  contra: turn([{ say: "make it red, actually no, blue" }]),
  mind: turn([{ say: "hmm" }], "the banner goes back to how it was"),
  "pause-fix": turn([{ say: "make the" }, { pause: 5 }, { say: "no, the title" }]),
  "big-small": turn([{ say: "make me a whole store" }]),
  strange: turn([{ say: "make it feel like rain" }]),
  undo: turn([{ say: "make the title bigger" }]),
  offscreen: turn([{ say: "put the same button on the cart page" }]),
  "camera-ask": turn([{ say: "show me the products" }]),
  "by-hand": turn([{ say: "this" }]),
  sketch: turn([{ draw: "sketch", shape: "wave", box: [100, 400, 300, 80] }]),
  "no-names": turn([{ say: "make this thing nicer" }]),
  "add-new": turn([{ say: "add a footer" }], "a new footer at the bottom"),
};
const no = { ...Object.fromEntries(Object.keys(yes).map((id) => [id, turn([{ say: "make the header bigger" }], "")])), "no-names": turn([{ say: "make the header bigger" }]) };
const withLooks = { ...ctx, looks: [turn([{ undo: true }]), turn([{ zoom: "in" }])] };
for (const id of Object.keys(yes)) {
  const c = id === "undo" || id === "by-hand" ? withLooks : id === "big-small" ? { ...ctx, send: 1 } : ctx;
  check(beat(id)(yes[id], c), `the ${id} check misses a complying turn`);
  check(!beat(id)(no[id], id === "big-small" ? { ...ctx, send: 1 } : ctx) || id === "strange" || id === "big-small", `the ${id} check passes a turn that ignores it`);
}
check(S.applies("undo", 3) && !S.applies("undo", 4) && S.applies("contra", 5), "applies() gives an undo after a good send");

// ---- The hedge regex (§2.4): the 8 hedged intents of the stored replies, and none of 10 good ones.
const hedged = [
  "something big like a whole store site, probably a messy wireframe with lots of sections",
  "a big headline-ish box appears at the top and maybe three boxes below",
  "the purple hero banner turns a different color, probably red or yellow",
  "Ambiguous 'this' with the circled story box and the hero nearby; expect it to shrink or move one of them, possibly the wrong one.",
  "Probably nothing dramatic. I'll see if it reacts to me circling a product and asking for a change.",
  "Maybe it needs a clearer pointer. I'll tap the box and draw arrows out from its edges, so it might stretch to fill that space.",
  "the big purple welcome banner on Home changes to a different color, probably something like green",
  "the map and the address show up fully at the bottom of the page, visible under the three pastries, maybe by making things a bit smaller so it all fits",
];
const good = [
  "a header or banner across the top",
  "I expect a headline-looking bar or text to appear at the top of the page where I sketched the box",
  "I expect the big grey hero box to get some kind of coffee picture or placeholder inside it.",
  "opening hours text should appear somewhere under the bread picture, and the orange blob gets explained or turned into an Order button",
  "I expect the orange Order now button to get noticeably bigger, and the nav Order link to stay exactly the same.",
  "three little pastry boxes with prices appear under the hours strip, and the name actually shows in the brown bar at top",
  "The Checkout button gets bigger and turns orange.",
  "the chart box shows just one plain wavy line across it instead of the crosshatched placeholder and the caption, nothing else changes",
  "I'll point at the left toy circles and ask to swap, expecting the toy robot and teddy bear to trade places",
  "Make the purple box itself bigger, and the title should stay put.",
];
check(hedged.every((m) => D.HEDGE.test(m)), `the hedge regex misses: ${hedged.find((m) => !D.HEDGE.test(m))}`);
check(good.every((m) => !D.HEDGE.test(m)), `the hedge regex flags a good intent: ${good.find((m) => D.HEDGE.test(m))}`);
check(D.parseTurn(JSON.stringify({ meant: hedged[1], steps: [] }), START).turn.hedged && !D.parseTurn(JSON.stringify({ meant: good[0], steps: [] }), START).turn.hedged, "parseTurn doesn't set hedged from meant");

// ---- parseTurn on crafted replies: clamps, drops, boxes, numeric strings, the first balanced object, unknown kinds.
const one = (steps, extra = {}) => D.parseTurn(`Sure! ${JSON.stringify({ meant: "x", steps, ...extra })} and {"not": "this"}`, START);
let r = one([{ draw: "tap", at: [990, -30] }]);
check(r.turn.steps.length === 1 && near(r.turn.steps[0].at[0], START.x + 960 * k) && near(r.turn.steps[0].at[1], START.y) && r.clamped === 2 && !r.dropped.length, "a point within 50 px off the screenshot isn't clamped onto its edge");
r = one([{ draw: "tap", at: [1011, 20] }, { draw: "circle", around: [100, 100, 50, 700] }]);
check(!r.turn.steps.length && r.dropped.length === 2 && r.dropped.every((d) => d.why.includes("off the screen")), "a position more than 50 px off isn't dropped and recorded");
r = one([{ draw: "box", box: [300, 200, -100, -50] }]);
check(r.turn.steps[0]?.box.every((v, i) => near(v, [START.x + 200 * k, START.y + 150 * k, 100 * k, 50 * k][i])), `a negative-size box isn't normalized: ${JSON.stringify(r.turn.steps[0])}`);
r = one([{ draw: "arrow", from: ["120", "80"], to: [" 240 ", 80] }, { pause: "2" }], { satisfaction: "4" });
check(r.turn.steps.length === 2 && near(r.turn.steps[0].from[0], 120 * k) && r.turn.steps[1].pause === 2 && r.turn.satisfaction === 4, "numeric strings aren't accepted");
r = D.parseTurn('Here you go: {"meant": "a {brace} and a \\"quote\\" inside", "steps": [{"say": "hi }"}]}\n{"meant": "second"}', START);
check(r.turn.meant === 'a {brace} and a "quote" inside' && r.turn.steps[0]?.say === "hi }", "the first balanced object isn't the one parsed");
r = one([{ draw: "star", at: [10, 10] }, { draw: "sketch", shape: "spiral", box: [0, 0, 10, 10] }, { jump: true }]);
check(r.dropped.map((d) => d.why).join("|") === "unknown kind star|unknown sketch shape spiral|unknown step", `unknown kinds aren't reported: ${JSON.stringify(r.dropped)}`);
r = one([{ say: "look" }, { draw: "sketch", shape: "blob", box: [10, 10, 100, 60] }, { draw: "wave", box: [10, 100, 100, 60] }, { scroll: [100, 0] }, { zoom: "in" }]);
check(r.turn.steps.filter((s) => s.draw === "sketch").length === 2 && r.dropped.length === 2 && r.dropped.every((d) => d.why === "view step after a draw"), "sketch steps or the view-after-draw drop are wrong");
r = one([{ scroll: [96, -48] }, { look: [0, 0, 480, 300] }]);
check(D.isLook(r.turn) && near(r.turn.steps[0].scroll[0], 96 * k) && r.turn.steps[1].look[2] === 480 * k, "a turn of view steps isn't a look, or its moves aren't in board px");
r = one([{ undo: true }]);
check(D.isLook(r.turn) && "undo" in r.turn.steps[0] && one([{ say: "hi" }, { undo: true }]).dropped[0]?.why === "undo after a say or draw", "undo steps aren't parsed as a look, or an undo after a say isn't dropped");
check(D.isLook(one([]).turn) && D.isLook(one([{ pause: 2 }]).turn), "an empty turn isn't a look");
r = one([{ say: "hm, what's down here..." }, { scroll: [0, 300] }]);
check(D.isLook(r.turn) && r.turn.steps.length === 1 && one([{ say: "this" }, { draw: "tap", at: [100, 100] }]).turn.steps.length === 2, "words while only moving the view still press Enter, or words with a draw are lost");
check(D.HABITS.length >= 6 && D.HABITS.every((h) => !/\bok(ay)?\b/i.test(h)) && D.userMessage({ ...card, habit: D.HABITS[2] }, [], undefined, "add", 3).includes(`Starting a send: ${D.HABITS[2]}`), "the opener habits are few, prime \"okay\", or don't reach the message");
let bare;
try { D.parseTurn('{"undo": true}', START); } catch (e) { bare = e; }
check(bare && D.parseTurn('{"meant": "done", "stop": true}', START).turn.stop, "a bare step without a steps list parses as a turn (it ended a session), or a stop without one doesn't");
const undoBeat = { id: "undo", text: "undo it first, then ask again" };
check(D.userMessage(card, past.slice(0, 1), undoBeat, "add", 2, [D.UNDID]).includes("now ask again") && D.userMessage(card, past.slice(0, 1), undoBeat, "add", 2).includes("undo it first"), "after the undo twist is done the message still says to undo first");
let threw = false;
try {
  D.parseTurn("I can't do that.", START);
} catch {
  threw = true;
}
check(threw && D.RETRY.includes("only the JSON"), "a reply with no object doesn't throw (for the one retry)");

// ---- moveView: zoom clamped to DRIVE_VIEW, look never closer than its minimum.
let v = { x: 0, y: 0, w: 320, h: 200 };
for (let i = 0; i < 5; i++) v = D.moveView({ zoom: "in" }, v);
check(v.w === DRIVE_VIEW.zoomMinPx && near(v.h, (v.w * 800) / 1280), `zooming in goes below ${DRIVE_VIEW.zoomMinPx} px: ${v.w}`);
v = { x: 0, y: 0, w: 12800, h: 8000 };
for (let i = 0; i < 5; i++) v = D.moveView({ zoom: "out" }, v);
check(v.w === DRIVE_VIEW.zoomMaxPx, `zooming out goes past ${DRIVE_VIEW.zoomMaxPx} px: ${v.w}`);
v = D.moveView({ look: [500, 300, 10, 10] }, START);
check(v.w === DRIVE_VIEW.lookMinPx && near(v.x + v.w / 2, 505), `looking at a tiny box zooms past ${DRIVE_VIEW.lookMinPx} px: ${v.w}`);
v = D.moveView({ scroll: [100, -50] }, START);
check(v.x === 100 && v.y === -110 && v.w === 1280, "scrolling moves the view wrongly");

// ---- driver.ts makes no model calls: nothing from model.ts, and only types from the product.
const src = readFileSync(join(ROOT, "evals/core/driver.ts"), "utf8");
const imports = src.match(/^import .*$/gm) ?? [];
check(!imports.some((l) => l.includes("model.ts")) && !/callModel\(|fetch\(/.test(src), "driver.ts imports model.ts or calls a model");
check(imports.filter((l) => l.includes("src/core")).every((l) => l.startsWith("import type")), "driver.ts imports values from src/core");

finish();
