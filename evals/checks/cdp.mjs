// A small CDP client for acceptance checks: one headless Chrome in pipe mode (it
// exits with the check, where port mode left 13–14 processes behind in v1), one page
// with focus emulation (a background page otherwise runs at 0 rAF/s), and every
// /api/* request answered from a stub table. Any /api/* request without a stub, or
// any request leaving the machine, ends the check with FAIL on the spot, so a
// check can never make a real model call.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { assertLocalOnly, cleanEnv, fail, tally } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome processes whose command line names this profile dir. */
export function chromeCount(dir) {
  try {
    return execFileSync("pgrep", ["-f", "--", dir], { encoding: "utf8" }).trim().split("\n").length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

/** A /api/model reply the way dev/model-plugin.ts streams it: text chunks, then the stats line. */
export const modelReply = (text, stats = {}) =>
  [...(text.match(/[\s\S]{1,40}/g) ?? []).map((t) => JSON.stringify({ text: t })), JSON.stringify({ done: true, model: "haiku", ms: 1, ...stats })].join("\n") + "\n";

/**
 * Starts Chrome with one page (call tempHome() first: the profile lives under RT_EVAL_HOME).
 * stubs: { "/api/model": (req) => body | { status, body, type } }, sync or async, where
 * req = { url, method, headers, body }. Returns { page, counts(), errors, dir, close() }.
 */
export async function openChrome({ stubs = {}, width = 1280, height = 800 } = {}) {
  if (!process.env.RT_EVAL_HOME) throw new Error("openChrome: call tempHome() first");
  const dir = mkdtempSync(join(process.env.RT_EVAL_HOME, "chrome-"));
  const flags = ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-pipe", `--user-data-dir=${dir}`, "--no-first-run", "--disable-background-networking"];
  // Its own process group, so one kill takes the renderers too; fds 3 and 4 carry CDP. Chrome puts its
  // singleton socket under TMPDIR and dies when that path passes 108 bytes (a deep work dir does), so /tmp.
  const proc = spawn("google-chrome", [...flags, "about:blank"], { env: cleanEnv({ TMPDIR: "/tmp" }), stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], detached: true });
  const killAll = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  };
  process.on("exit", killAll);
  const exited = new Promise((r) => proc.once("exit", r));

  let id = 0;
  const waiting = new Map();
  const listeners = new Set();
  proc.stdio[3].on("error", () => {}); // Chrome gone: the exit handler below reports it
  proc.stdio[4].setEncoding("utf8");
  let buf = "";
  proc.stdio[4].on("data", (chunk) => {
    buf += chunk;
    for (let end; (end = buf.indexOf("\0")) >= 0; buf = buf.slice(end + 1)) {
      const m = JSON.parse(buf.slice(0, end));
      if (m.id !== undefined) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w?.no(new Error(`${w.method}: ${m.error.message}`));
        else w?.ok(m.result);
      } else for (const f of listeners) f(m);
    }
  });
  let gone = false;
  void exited.then(() => {
    gone = true;
    for (const w of waiting.values()) w.no(new Error(`${w.method}: Chrome exited`));
    waiting.clear();
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, no) => {
      if (gone) return no(new Error(`${method}: Chrome exited`));
      const n = ++id;
      waiting.set(n, { ok, no, method });
      proc.stdio[3].write(JSON.stringify({ id: n, method, params, sessionId }) + "\0");
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const on = (method, f) => listeners.add((m) => m.sessionId === sessionId && m.method === method && f(m.params));
  const once = (method) =>
    new Promise((r) => {
      const f = (m) => m.sessionId === sessionId && m.method === method && (listeners.delete(f), r(m.params));
      listeners.add(f);
    });

  const counted = tally();
  const errors = [];
  on("Network.requestWillBeSent", ({ request }) => new URL(request.url).pathname.startsWith("/api/") && counted.add("seen"));
  on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => errors.push(d.exception?.description ?? d.text));
  on("Runtime.consoleAPICalled", ({ type, args }) => type === "error" && errors.push(args.map((a) => a.value ?? a.description).join(" ")));
  async function answer({ requestId, request }) {
    try {
      assertLocalOnly(request.url);
    } catch {
      fail(`a request left the machine: ${request.url}`);
    }
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/")) return send("Fetch.continueRequest", { requestId }, sessionId);
    const stub = stubs[path];
    if (!stub) fail(`unstubbed request ${request.method} ${path}`);
    counted.add("stubbed");
    counted.add(path);
    const body = request.postData ?? (request.postDataEntries ?? []).map((e) => Buffer.from(e.bytes ?? "", "base64").toString()).join("");
    const r = await stub({ url: request.url, method: request.method, headers: request.headers, body });
    const out = typeof r === "string" ? { body: r } : r;
    const reply = { requestId, responseCode: out.status ?? 200, responseHeaders: [{ name: "content-type", value: out.type ?? "application/x-ndjson" }], body: Buffer.from(out.body ?? "").toString("base64") };
    await send("Fetch.fulfillRequest", reply, sessionId);
  }
  // A request still paused when Chrome closes is no failure; a stub that throws is.
  on("Fetch.requestPaused", (e) => answer(e).catch((err) => gone || fail(`stubbing ${e.request.url}: ${err.message}`)));

  const page = {
    /** Any CDP command on this page. */
    send: (method, params) => send(method, params, sessionId),
    async goto(url) {
      const loaded = once("Page.loadEventFired");
      const { errorText } = await page.send("Page.navigate", { url });
      if (errorText) throw new Error(`can't load ${url}: ${errorText}`);
      await loaded;
    },
    /** Runs an expression in the page (promises awaited) and returns its JSON value. */
    async eval(expression) {
      const r = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    /** A screenshot as a Buffer (PNG unless params say otherwise, e.g. { format: "jpeg", quality: 80, clip }). */
    async shot(params = {}) {
      return Buffer.from((await page.send("Page.captureScreenshot", { format: "png", ...params })).data, "base64");
    },
  };
  for (const domain of ["Page", "Runtime", "Network"]) await page.send(`${domain}.enable`);
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

  return {
    page,
    dir,
    errors,
    /** /api/* requests the page sent (seen), answered by a stub (stubbed), and per path. */
    counts: () => ({ seen: 0, stubbed: 0, ...counted.all }),
    /** Closes Chrome and waits until none of its processes is left; returns how many are (0). */
    async close() {
      send("Browser.close").catch(() => {});
      await Promise.race([exited, sleep(3000)]);
      killAll();
      process.off("exit", killAll);
      for (let i = 0; i < 30 && chromeCount(dir); i++) await sleep(100);
      return chromeCount(dir);
    },
  };
}
