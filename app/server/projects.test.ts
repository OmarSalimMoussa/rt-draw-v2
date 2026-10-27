// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const data = mkdtempSync(join(tmpdir(), "rt-app-projects-"));
process.env.RT_DATA_DIR = data;
const { Router } = await import("./http.ts");
const { registerProjects } = await import("./projects.ts");

let server: Server;
let base = "";
beforeAll(async () => {
  const router = new Router();
  registerProjects(router);
  server = createServer(async (req, res) => {
    if (!(await router.handle(req, res))) {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A browser: its own owner cookie, taken from the first answer. */
function browser() {
  let cookie = "";
  return async (path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(cookie && { cookie }), ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set && !cookie) cookie = set.split(";")[0];
    return { res, set, json: (await res.json()) as any, cookie: () => cookie };
  };
}

const version = (n: number, label = "a") => ({ n, doc: { v: 1 }, at: 1, label });

describe("projects API", () => {
  it("a new browser gets an owner cookie and an empty list", async () => {
    const r = await browser()("/api/projects");
    expect(r.res.status).toBe(200);
    expect(r.json).toEqual({ projects: [] });
    expect(r.set).toMatch(/^rt_owner=[a-f0-9]{32};/);
  });

  it("save then load returns the versions in order", async () => {
    const b = browser();
    await b("/api/projects");
    await b("/api/project/save", { id: "abc123", versions: [version(1)], meta: { name: "Bakery", pages: 1 } });
    const one = await b("/api/project?id=abc123");
    expect(one.json.versions.map((v: { n: number }) => v.n)).toEqual([1]);
    const list = await b("/api/projects");
    expect(list.json.projects).toMatchObject([{ id: "abc123", name: "Bakery", pages: 1, versions: 1, latest: { v: 1 } }]);
  });

  it("a clashing version number is renumbered after the stored ones", async () => {
    const b = browser();
    await b("/api/projects");
    await b("/api/project/save", { id: "clash1", versions: [version(1, "a")], meta: { name: "C" } });
    const second = await b("/api/project/save", { id: "clash1", versions: [version(1, "b")], meta: { name: "C" } });
    expect(second.json.versions.map((v: { n: number }) => v.n)).toEqual([1, 2]);
  });

  it("rename and delete", async () => {
    const b = browser();
    await b("/api/projects");
    await b("/api/project/save", { id: "abc123", versions: [version(1)], meta: { name: "Bakery", pages: 1 } });
    await b("/api/project/rename", { id: "abc123", name: "X" });
    expect((await b("/api/projects")).json.projects).toMatchObject([{ id: "abc123", name: "X", named: true }]);
    await b("/api/project/delete", { id: "abc123" });
    expect((await b("/api/projects")).json.projects).toEqual([]);
    expect((await b("/api/project?id=abc123")).res.status).toBe(404);
  });

  it("another browser doesn't see the projects", async () => {
    const mine = browser();
    await mine("/api/projects");
    await mine("/api/project/save", { id: "mine01", versions: [version(1)], meta: { name: "Mine" } });
    expect((await browser()("/api/projects")).json.projects).toEqual([]);
  });

  it("projects are kept under RT_DATA_DIR/app/owners", async () => {
    const b = browser();
    const first = await b("/api/projects");
    await b("/api/project/save", { id: "kept01", versions: [version(1)], meta: { name: "Kept" } });
    const owner = first.cookie().split("=")[1];
    expect(existsSync(join(data, "app", "owners", owner, "kept01.ndjson"))).toBe(true);
  });

  it("the send log appends each send under RT_DATA_DIR/app/sends, even before the project's first save", async () => {
    const b = browser();
    const first = await b("/api/projects");
    const send = (id: string) => ({ id, project: "log001", before: { v: 1 }, words: "a cat", strokes: [] });
    expect((await b("/api/sends", send("s-1"))).json).toEqual({ ok: true });
    await b("/api/sends", send("s-2"));
    const owner = first.cookie().split("=")[1];
    const lines = readFileSync(join(data, "app", "sends", owner, "log001.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l).id);
    expect(lines).toEqual(["s-1", "s-2"]);
    expect((await b("/api/sends", { ...send("s-3"), project: "../x" })).res.status).toBe(400);
    expect((await b("/api/sends", { project: "log001" })).res.status).toBe(400);
  });
});
