// @vitest-environment node
// The hosted app (host.ts): the built page and the dev server's API plugins on one port.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { type Server, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { host } from "./host.ts";

const dist = mkdtempSync(join(tmpdir(), "rt-app-dist-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), "<!doctype html><title>rt-draw</title>");
writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log(1)");
writeFileSync(join(dist, "tutorial.mp4"), "0123456789");

/** A plugin the way the dev server's are written: its keys from configResolved, its routes from configureServer. */
const seen: { mode?: string; root?: string } = {};
const api: Plugin = {
  name: "fake-api",
  configResolved(config) {
    Object.assign(seen, { mode: config.mode, root: config.root });
  },
  configureServer(server) {
    server.middlewares.use("/api/model", (req, res) => res.end(JSON.stringify({ model: req.method })));
    server.middlewares.use((req, res, next) => (req.url?.startsWith("/api/project") ? res.end("{}") : next()));
  },
};

let server: Server;
let base = "";
beforeAll(async () => {
  server = host(dist, "/the/repo", [api]);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("the hosted app", () => {
  it("gives its plugins the production mode and the repo, as the dev server would", () => {
    expect(seen).toEqual({ mode: "production", root: "/the/repo" });
  });

  it("serves the page, and the page for the app's own paths, never cached", async () => {
    for (const path of ["/", "/?p=abc", "/projects"]) {
      const r = await fetch(base + path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/^text\/html/);
      expect(r.headers.get("cache-control")).toBe("no-cache");
      expect(await r.text()).toContain("<title>rt-draw</title>");
    }
  });

  it("serves the built files, cached for good (their names change with them); a missing one is a 404", async () => {
    const r = await fetch(`${base}/assets/index-abc123.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/javascript");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await r.text()).toBe("console.log(1)");
    expect((await fetch(`${base}/assets/gone-123.js`)).status).toBe(404);
  });

  it("serves a video in pieces, as Safari asks for it, and caches the page's other files for an hour", async () => {
    const whole = await fetch(`${base}/tutorial.mp4`);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await whole.text()).toBe("0123456789");
    const part = await fetch(`${base}/tutorial.mp4`, { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    const tail = await fetch(`${base}/tutorial.mp4`, { headers: { range: "bytes=7-" } });
    expect(await tail.text()).toBe("789");
    expect((await fetch(`${base}/tutorial.mp4`, { headers: { range: "bytes=20-30" } })).status).toBe(416);
  });

  it("never serves anything outside the built page, however the path climbs out", async () => {
    // Sent as written: fetch would tidy the dots away first.
    const raw = (path: string) => new Promise<number>((ok, no) => request(`${base}/`, { path }, (r) => (r.resume(), ok(r.statusCode!))).on("error", no).end());
    for (const path of ["/../host.test.ts", "/../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2fpackage.json"]) expect(await raw(path)).toBe(404);
  });

  it("runs the plugins' routes, mounted at a path or not; an API path none takes is a JSON 404", async () => {
    expect(await (await fetch(`${base}/api/model`, { method: "POST" })).json()).toEqual({ model: "POST" });
    expect(await (await fetch(`${base}/api/projects`)).text()).toBe("{}");
    const r = await fetch(`${base}/api/nothing`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "no such route" });
  });
});
