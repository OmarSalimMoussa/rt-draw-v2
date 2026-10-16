// One headless Chrome per run, driven over a pipe (spec §7.4, fix F13): when the
// harness dies the pipe closes and Chrome exits with it, where port mode left 13–14
// processes behind in v1. Every page gets focus emulation (a background tab
// otherwise ran at 0 rAF/s and one timer tick a second) and a Fetch allowlist: its
// arm's origin, with /api/model the only /api/ route, labelled with x-rt-* headers
// for the gateway. Any other request is failed and aborts the run (onBlocked).
// No screencasts or video: v1 paid a core per Chrome for them.
import { spawn } from "node:child_process";
import type { View } from "../../src/core/board.ts";

/** The bridge's stage canvas (src/ui.ts' stage(): div.stage > svg), what every capture shows. */
const STAGE_CLIP = ".stage > svg";
/** The bridge page's size: the product's 1280×800 screen. */
const PAGE = { width: 1280, height: 800 };
const CLOSE_MS = 3000;

/** Who a page's model calls belong to; the runner sets `case` before each case. */
export type Labels = { run: string; case: string; arm: string; slot: number };

export type Page = {
  labels: Labels;
  /** Any CDP command on this page. */
  send(method: string, params?: object): Promise<any>;
  goto(url: string): Promise<void>;
  /** A fresh page for the next case (the product keeps every call and span in memory). */
  reload(): Promise<void>;
  /** Runs an expression in the page (promises awaited) and returns its JSON value. */
  eval<T = unknown>(expression: string): Promise<T>;
  close(): Promise<void>;
};

export type Chrome = { pid: number; newPage(origin: string, labels: Labels): Promise<Page>; close(): Promise<void> };

/** Starts Chrome with its profile in `dir` (under the run). `onBlocked` gets every request the allowlist failed. */
export async function launchChrome(o: { dir: string; onBlocked: (url: string, labels: Labels) => void }): Promise<Chrome> {
  const flags = ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-pipe", `--user-data-dir=${o.dir}`, "--no-first-run", "--disable-background-networking",
    // Belt and braces with focus emulation: 16 tabs share one window, and only one of them is in front.
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];
  // fds 3 and 4 carry CDP. Its own process group, so close() takes the renderers too. Chrome puts its singleton
  // socket under TMPDIR and dies when that path passes 108 bytes (a deep work dir does), hence /tmp.
  const proc = spawn("google-chrome", [...flags, "about:blank"], { env: { ...process.env, TMPDIR: "/tmp" }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], detached: true });
  const killAll = () => {
    try {
      process.kill(-proc.pid!, "SIGKILL");
    } catch {}
  };
  process.on("exit", killAll);
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  const [toChrome, fromChrome] = [proc.stdio[3] as NodeJS.WritableStream, proc.stdio[4] as NodeJS.ReadableStream];

  let id = 0;
  let gone = false;
  const waiting = new Map<number, { ok: (r: any) => void; no: (e: Error) => void; method: string }>();
  const listeners = new Map<string, (method: string, params: any) => void>(); // by session id
  toChrome.on("error", () => {}); // Chrome gone: `exited` fails what's waiting
  let buf = "";
  fromChrome.setEncoding("utf8");
  fromChrome.on("data", (chunk: string) => {
    buf += chunk;
    for (let end; (end = buf.indexOf("\0")) >= 0; buf = buf.slice(end + 1)) {
      const m = JSON.parse(buf.slice(0, end));
      if (m.id === undefined) listeners.get(m.sessionId)?.(m.method, m.params);
      else {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w?.no(new Error(`${w.method}: ${m.error.message}`));
        else w?.ok(m.result);
      }
    }
  });
  void exited.then(() => {
    gone = true;
    for (const w of waiting.values()) w.no(new Error(`${w.method}: Chrome exited`));
    waiting.clear();
  });
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((ok, no) => {
      if (gone) return no(new Error(`${method}: Chrome exited`));
      waiting.set(++id, { ok, no, method });
      toChrome.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });

  async function newPage(origin: string, labels: Labels): Promise<Page> {
    const allowed = new URL(origin).origin;
    const { targetId } = await send("Target.createTarget", { url: "about:blank", newWindow: true }); // its own window: no tab is ever in the background
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    let loaded: (() => void) | undefined;
    const load = () => new Promise<void>((r) => (loaded = r));
    listeners.set(sessionId, (method, params) => {
      if (method === "Fetch.requestPaused") paused(params).catch(() => {}); // a page closing mid-request: nothing to answer
      else if (method === "Page.loadEventFired") loaded?.();
    });

    async function paused({ requestId, request }: { requestId: string; request: { url: string; headers: Record<string, string> } }) {
      const u = new URL(request.url);
      if (u.origin !== allowed || (u.pathname.startsWith("/api/") && u.pathname !== "/api/model")) {
        await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId);
        return o.onBlocked(request.url, page.labels);
      }
      if (u.pathname !== "/api/model") return send("Fetch.continueRequest", { requestId }, sessionId);
      const l = page.labels;
      const headers = [...Object.entries(request.headers).map(([name, value]) => ({ name, value })),
        ...Object.entries({ run: l.run, case: l.case, arm: l.arm, slot: String(l.slot) }).map(([k, value]) => ({ name: `x-rt-${k}`, value }))];
      return send("Fetch.continueRequest", { requestId, headers }, sessionId);
    }

    const page: Page = {
      labels,
      send: (method, params) => send(method, params, sessionId),
      async goto(url) {
        const done = load();
        const { errorText } = await page.send("Page.navigate", { url });
        if (errorText) throw new Error(`can't load ${url}: ${errorText}`);
        await done;
      },
      async reload() {
        const done = load();
        await page.send("Page.reload");
        await done;
      },
      async eval(expression) {
        const r = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      async close() {
        listeners.delete(sessionId);
        await send("Target.closeTarget", { targetId });
      },
    };
    await page.send("Page.enable");
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Emulation.setDeviceMetricsOverride", { ...PAGE, deviceScaleFactor: 1, mobile: false });
    return page;
  }

  return {
    pid: proc.pid!,
    newPage,
    async close() {
      send("Browser.close").catch(() => {});
      await Promise.race([exited, new Promise((r) => setTimeout(r, CLOSE_MS))]);
      killAll();
      process.off("exit", killAll);
    },
  };
}

/**
 * A JPEG of the bridge's stage `width` px wide (the driver's 960, the judges' 640) at `quality` (0–1), by
 * Page.captureScreenshot of the stage's clip; with `view`, the camera moves there first (rtEval.setView).
 */
export async function capture(page: Page, o: { view?: View; width: number; quality: number }): Promise<Buffer> {
  if (o.view) await page.eval(`rtEval.setView(${JSON.stringify(o.view)}).then(() => new Promise(requestAnimationFrame))`);
  const clip = await page.eval<{ x: number; y: number; width: number; height: number }>(
    `(({ x, y, width, height }) => ({ x, y, width, height }))(document.querySelector(${JSON.stringify(STAGE_CLIP)}).getBoundingClientRect())`,
  );
  const { data } = await page.send("Page.captureScreenshot", { format: "jpeg", quality: Math.round(o.quality * 100), clip: { ...clip, scale: o.width / clip.width } });
  return Buffer.from(data, "base64");
}
