// T10's acceptance check: the driver demo page on its defaults (voice off), one session of
// 2 sends: no voice request, every driver turn carries the one shared system prompt and two
// pictures (before with ink, now), and a rating given on a look turn lands on the send it
// rates in the session record. 0 model calls: one Chrome with every /api/* stubbed and
// counted, a Vite with no plugins, so nothing could reach a model or a voice.
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t10-demo.mjs
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import { modelReply, openChrome } from "./cdp.mjs";
import { ROOT, check, fail, finish, tempHome } from "./lib.mjs";

const home = tempHome();
const { systemPrompt } = await import("../core/driver.ts");

const vite = await createServer({
  root: ROOT, configFile: false, envDir: mkdtempSync(join(home, "env-")), cacheDir: join(home, "vite"), appType: "mpa", logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, watch: null },
});
await vite.listen();
const DEMO = `http://127.0.0.1:${vite.httpServer.address().port}/evals/driver/`;

// ---- The driver acts, then only zooms out while rating send 1 (a look turn), then acts again; the product answers each send.
const TURNS = [
  { meant: "a big banner across the top of the page", steps: [{ say: "put a big banner up here" }, { draw: "box", box: [100, 60, 600, 120] }] },
  { saw: "a pink banner showed up", satisfaction: 2, feeling: "not quite what I pictured", meant: "", steps: [{ zoom: "out" }] },
  { meant: "a red button under the banner", steps: [{ say: "and a button below it" }, { draw: "tap", at: [300, 300] }] },
];
const REPLIES = {
  "draw-refs": '{"refs": []}',
  draw: 'shape(hero, rect, 40 60 400 120, "big pink hero banner across the top of the home page", fill:#ffe3e3)\ndrawing(hero, "a smiling sun")',
  picture: '<circle cx="50" cy="50" r="30" fill="#ffd43b" stroke="#1e1e1e" stroke-width="3"/>',
};
const driver = [];
const voice = [];
const c = await openChrome({
  stubs: {
    "/api/model": ({ body }) => {
      if (!body) fail("a model request without its body");
      const r = JSON.parse(body);
      if (r.user === undefined) return `${JSON.stringify({ done: true, warmed: true })}\n`;
      if (r.from === "driver") {
        driver.push({ system: r.system, images: r.images ?? [] });
        const turn = TURNS[driver.length - 1] ?? fail(`driver call ${driver.length}: the session should have ended`);
        return modelReply(JSON.stringify(turn));
      }
      return REPLIES[r.from] !== undefined ? modelReply(REPLIES[r.from]) : fail(`an unexpected model call from ${r.from}`);
    },
    "/api/tts": () => (voice.push("tts"), { status: 403, body: '{"error":"no voice in checks"}', type: "application/json" }),
    "/api/stt-token": () => (voice.push("stt"), { status: 403, body: '{"error":"no voice in checks"}', type: "application/json" }),
  },
});
const { page } = c;
await page.goto(DEMO);
await page.eval("document.fonts.ready.then(() => true)");

// ---- Defaults, except a session of 2 sends.
check((await page.eval("document.querySelector('#voice').textContent")) === "voice: off", "the voice button doesn't start as 'voice: off'");
await page.eval(`(document.querySelector("#maxSends").value = "2", document.querySelector("#run").click(), true)`);
const done = await page.eval(`new Promise((ok) => { const end = Date.now() + 60000; const t = () => /^(Finished|Paused)/.test(document.querySelector("#status").textContent) || Date.now() > end ? ok(document.querySelector("#status").textContent) : setTimeout(t, 100); t(); })`);
check(done === "Finished: out of sends.", `the session didn't end after 2 sends: "${done}" (errors: ${await page.eval("document.querySelector('#errors').textContent")})`);
// The record is kept here instead of downloaded.
await page.eval(`(() => {
  const real = URL.createObjectURL;
  URL.createObjectURL = (b) => ((window.__record = b), real(b));
  HTMLAnchorElement.prototype.click = function () {};
  document.querySelector("#save").click();
  return true;
})()`);
const record = JSON.parse(await page.eval("window.__record?.text() ?? 'null'"));

// ---- No voice; the shared prompt and two pictures on every driver turn; the look turn's rating on send 1.
check(!voice.length && !c.counts()["/api/tts"], `${voice.length} voice requests (${voice})`);
const system = systemPrompt();
check(driver.length === 3, `${driver.length} driver calls, want 3 (act, look, act)`);
check(driver.every((d) => d.system === system), "a driver call's system prompt isn't driver.ts' shared one");
check(driver.every((d) => d.images.length === 2 && d.images.every((i) => i.startsWith("data:image/jpeg"))), `driver calls' pictures: ${driver.map((d) => d.images.length)}`);
check(driver[2]?.images[0] !== driver[2]?.images[1], "the second send's before picture (the screen at Enter, with ink) is the screen now");
check(record?.sends?.length === 2, `the session record has ${record?.sends?.length} sends`);
check(record?.sends?.[0]?.rating?.satisfaction === 2 && record.sends[0].rating.feeling === TURNS[1].feeling, `send 1's rating (given on a look turn) isn't on send 1: ${JSON.stringify(record?.sends?.[0]?.rating)}`);
check(record?.sends?.[1] && record.sends[1].rating === undefined, "send 2 has a rating nobody gave");

// ---- 0 real calls: everything the page asked was stubbed.
const counts = c.counts();
check(counts.seen === counts.stubbed && counts.stubbed > 0, `requests seen ${counts.seen}, stubbed ${counts.stubbed}`);
check(!c.errors.length, `page errors: ${c.errors.slice(0, 3).join(" | ")}`);
const left = await c.close();
check(left === 0, `${left} Chrome processes left`);
await vite.close();
finish();
