// @vitest-environment node
// Who may use the hosted app (access.ts): invite links, sessions, the waitlist, and the admin's view.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Access, ownerFrom } from "./access.ts";
import { host } from "./host.ts";
import type { Mail } from "./mailer.ts";
import { projectsApi } from "./plugin.ts";

const data = mkdtempSync(join(tmpdir(), "imagine-access-"));
// The projects (projects.ts) live in the same data folder.
process.env.RT_DATA_DIR = data;
const dist = mkdtempSync(join(tmpdir(), "imagine-dist-"));
writeFileSync(join(dist, "index.html"), "<!doctype html><title>imagine</title>");

const mails: Mail[] = [];
let clock = Date.parse("2026-10-23T09:00:00Z");
const access = new Access(data, { mailer: async (m) => void mails.push(m), now: () => clock });

/** The model route as the dev server mounts it: it says who the call was logged for. */
const calls: (string | undefined)[] = [];
/** The one drawing model each call was held to, if any. */
const onlyModels: (string | undefined)[] = [];
const model: Plugin = {
  name: "fake-model",
  configureServer(server) {
    server.middlewares.use("/api/model", (req, res) => {
      calls.push(req.headers["x-imagine-person"] as string | undefined);
      onlyModels.push(req.headers["x-imagine-draw-model"] as string | undefined);
      res.end(JSON.stringify({ ok: true }));
    });
  },
};

let server: Server;
let base = "";
beforeAll(async () => {
  server = host(dist, data, [model, projectsApi({ owner: ownerFrom })], access);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** A browser behind the site's https edge: it keeps the cookies it is given. */
function browser(cookie = "") {
  const jar = new Map<string, string>(cookie ? [cookie.split("=") as [string, string]] : []);
  return async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-forwarded-proto": "https", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...(body !== undefined && { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie") ?? "";
    const [kv] = set.split(";");
    if (kv) {
      const [k, v] = kv.split("=");
      v ? jar.set(k, v) : jar.delete(k);
    }
    const text = await res.text();
    return { status: res.status, set, json: (text.startsWith("{") ? JSON.parse(text) : text) as any };
  };
}
const tokenOf = (link: string) => link.split("/join/")[1];
/** Someone invited and signed in. */
async function joined(email: string, o: { admin?: boolean } = {}) {
  const { link } = await access.invite(email, { admin: o.admin, base: "https://imagine.test" });
  const b = browser();
  const r = await b("/api/access/join", { token: tokenOf(link), email });
  expect(r.status).toBe(200);
  return b;
}
const version = (n: number, label = "a bakery") => ({ n, doc: { v: 1 }, at: 1, label });

describe("before signing in", () => {
  it("only the page and the access routes answer: no projects, no model calls", async () => {
    const b = browser();
    expect((await b("/")).status).toBe(200);
    expect((await b("/api/access/me")).json).toEqual({ person: null });
    const projects = await b("/api/projects");
    expect(projects.status).toBe(401);
    expect(projects.json.error).toMatch(/invite link/);
    expect((await b("/api/model", { model: "sonnet" })).status).toBe(401);
    expect((await b("/api/stt-token", {})).status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe("an invite link", () => {
  it("and the email it was sent to sign a browser in for 90 days; a wrong email or a made-up link don't", async () => {
    const { link } = await access.invite(" Ada@Example.com ", { base: "https://imagine.test" });
    expect(link).toMatch(/^https:\/\/imagine\.test\/join\/[A-Za-z0-9_-]{43}$/);
    const b = browser();
    const wrong = await b("/api/access/join", { token: tokenOf(link), email: "eve@example.com" });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error).toMatch(/isn't the email/);
    expect((await b("/api/access/join", { token: "x".repeat(43), email: "ada@example.com" })).status).toBe(404);
    const ok = await b("/api/access/join", { token: tokenOf(link), email: "ADA@example.com" });
    expect(ok.status).toBe(200);
    expect(ok.set).toMatch(/^imagine_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=7776000; Secure$/);
    expect((await b("/api/access/me")).json).toEqual({ person: { email: "ada@example.com", admin: false } });
    expect((await b("/api/projects")).status).toBe(200);
    // The same link signs in another device.
    expect((await browser()("/api/access/join", { token: tokenOf(link), email: "ada@example.com" })).status).toBe(200);
    // 90 days on, the session is over.
    clock += 91 * 24 * 3600 * 1000;
    expect((await b("/api/access/me")).json).toEqual({ person: null });
    clock -= 91 * 24 * 3600 * 1000;
  });

  it("a new link for someone replaces their old one; whoever is signed in stays signed in", async () => {
    const first = await access.invite("bo@example.com", { base: "https://imagine.test" });
    const b = browser();
    await b("/api/access/join", { token: tokenOf(first.link), email: "bo@example.com" });
    const second = await access.invite("bo@example.com", { base: "https://imagine.test" });
    expect((await browser()("/api/access/join", { token: tokenOf(first.link), email: "bo@example.com" })).status).toBe(404);
    expect((await browser()("/api/access/join", { token: tokenOf(second.link), email: "bo@example.com" })).status).toBe(200);
    expect((await b("/api/access/me")).json.person.email).toBe("bo@example.com");
  });

  it("signing out ends that browser's session only", async () => {
    const { link } = await access.invite("cy@example.com", { base: "https://imagine.test" });
    const [one, two] = [browser(), browser()];
    await one("/api/access/join", { token: tokenOf(link), email: "cy@example.com" });
    await two("/api/access/join", { token: tokenOf(link), email: "cy@example.com" });
    expect((await one("/api/access/signout", {})).status).toBe(200);
    expect((await one("/api/access/me")).json).toEqual({ person: null });
    expect((await two("/api/access/me")).json.person.email).toBe("cy@example.com");
  });
});

describe("each person's work", () => {
  it("testers see only their own projects; the admin sees everyone's", async () => {
    const [di, ed] = [await joined("di@example.com"), await joined("ed@example.com")];
    await di("/api/project/save", { id: "dibakery", versions: [version(1), version(2, "make it blue")], meta: { name: "Di's bakery", pages: 1 } });
    await ed("/api/project/save", { id: "edfarm01", versions: [version(1, "a farm")], meta: { name: "Ed's farm", pages: 2 } });
    expect((await di("/api/projects")).json.projects.map((p: { id: string }) => p.id)).toEqual(["dibakery"]);
    expect((await ed("/api/projects")).json.projects.map((p: { id: string }) => p.id)).toEqual(["edfarm01"]);
    expect((await ed("/api/project?id=dibakery")).status).toBe(404);
    expect((await di("/api/admin/overview")).status).toBe(403);

    const admin = await joined("omar@example.com", { admin: true });
    const { people } = (await admin("/api/admin/overview")).json;
    const dis = people.find((p: { email: string }) => p.email === "di@example.com");
    expect(dis).toMatchObject({ projects: 1, versions: 2, joinedAt: clock });
    expect(dis.inviteHash).toBeUndefined();
    const projects = (await admin(`/api/admin/projects?person=${dis.id}`)).json.projects;
    expect(projects.map((p: { name: string; latest: unknown }) => [p.name, p.latest])).toEqual([["Di's bakery", { v: 1 }]]);
    const versions = (await admin(`/api/admin/project?person=${dis.id}&id=dibakery`)).json.versions;
    expect(versions.map((v: { label: string }) => v.label)).toEqual(["a bakery", "make it blue"]);
  });

  it("every model call is logged for whoever made it, whatever a page claims", async () => {
    const fi = await joined("fi@example.com");
    expect((await fi("/api/model", { model: "sonnet" }, { "x-imagine-person": "someone-else" })).status).toBe(200);
    const admin = await joined("omar2@example.com", { admin: true });
    const id = (await admin("/api/admin/overview")).json.people.find((p: { email: string }) => p.email === "fi@example.com").id;
    expect(calls.at(-1)).toBe(id);
  });

  it("a tester draws with Sonnet, whatever a page asks for; the admin draws with the model they pick", async () => {
    const hal = await joined("hal2@example.com");
    await hal("/api/model", { model: "opus", from: "draw" }, { "x-imagine-draw-model": "opus" });
    expect(onlyModels.at(-1)).toBe("sonnet");
    const admin = await joined("omar3@example.com", { admin: true });
    await admin("/api/model", { model: "opus", from: "draw" }, { "x-imagine-draw-model": "haiku" });
    expect(onlyModels.at(-1)).toBeUndefined();
  });

  it("the admin's own projects from before invites come along on their first sign-in", async () => {
    const old = "a".repeat(32);
    mkdirSync(join(data, "app", "owners", old), { recursive: true });
    writeFileSync(join(data, "app", "owners", old, "index.json"), JSON.stringify([{ id: "oldfarm1", name: "Chicken farm", createdAt: 1, updatedAt: 1, pages: 2, versions: 10 }]));
    const { link } = await access.invite("first@example.com", { admin: true, base: "https://imagine.test" });
    const b = browser(`rt_owner=${old}`);
    await b("/api/access/join", { token: tokenOf(link), email: "first@example.com" });
    expect((await b("/api/projects")).json.projects.map((p: { name: string }) => p.name)).toEqual(["Chicken farm"]);
  });
});

describe("revoking someone", () => {
  it("signs them out everywhere and stops their link; inviting them again lets them back", async () => {
    const { link } = await access.invite("gus@example.com", { base: "https://imagine.test" });
    const b = browser();
    await b("/api/access/join", { token: tokenOf(link), email: "gus@example.com" });
    const admin = await joined("omar3@example.com", { admin: true });
    expect((await admin("/api/admin/revoke", { email: "gus@example.com" })).status).toBe(200);
    expect((await b("/api/access/me")).json).toEqual({ person: null });
    expect((await browser()("/api/access/join", { token: tokenOf(link), email: "gus@example.com" })).status).toBe(404);
    const again = await admin("/api/admin/invite", { email: "gus@example.com", send: false });
    expect(again.json).toMatchObject({ mailed: false });
    expect((await browser()("/api/access/join", { token: tokenOf(again.json.link), email: "gus@example.com" })).status).toBe(200);
  });
});

describe("the waitlist", () => {
  it("keeps each email once, mails the admin about each new one, and an invite from it mails the person their link", async () => {
    mails.length = 0;
    const visitor = browser();
    const at = { "x-forwarded-for": "203.0.113.7" };
    expect((await visitor("/api/access/waitlist", { email: "Hal@Example.com", note: "I run a bakery" }, at)).status).toBe(200);
    expect((await visitor("/api/access/waitlist", { email: "hal@example.com", note: "again" }, at)).status).toBe(200);
    expect(mails).toEqual([{ action: "waitlist", email: "hal@example.com", note: "I run a bakery" }]);
    expect((await visitor("/api/access/waitlist", { email: "not an email" }, at)).status).toBe(400);
    // The field people never see: a bot that fills it in is told yes and kept nowhere.
    expect((await visitor("/api/access/waitlist", { email: "bot@example.com", website: "http://spam" }, at)).status).toBe(200);

    const admin = await joined("omar4@example.com", { admin: true });
    const { waitlist } = (await admin("/api/admin/overview")).json;
    expect(waitlist.map((w: { email: string; note: string }) => [w.email, w.note])).toEqual([["hal@example.com", "I run a bakery"]]);
    const sent = await admin("/api/admin/invite", { email: "hal@example.com", send: true });
    expect(sent.json).toMatchObject({ mailed: true });
    expect(mails.at(-1)).toEqual({ action: "invite", email: "hal@example.com", link: sent.json.link });
    expect(sent.json.link).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/join\//);
    expect((await admin("/api/admin/overview")).json.waitlist[0].invitedAt).toBe(clock);
  });

  it("takes a few sign-ups an hour from one address, then asks it to wait", async () => {
    const visitor = browser();
    const at = { "x-forwarded-for": "198.51.100.9, 10.0.0.1" };
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await visitor("/api/access/waitlist", { email: `p${i}@example.com` }, at)).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  it("mails the admin about the first 25 sign-ups a day, so invites keep the mailer's quota, and keeps them all", async () => {
    clock += 2 * 86_400_000;
    mails.length = 0;
    const visitor = browser();
    for (let i = 0; i < 27; i++) expect((await visitor("/api/access/waitlist", { email: `crowd${i}@example.com` }, { "x-forwarded-for": `192.0.2.${i}` })).status).toBe(200);
    expect(mails.map((m) => m.email)).toEqual(Array.from({ length: 25 }, (_, i) => `crowd${i}@example.com`));
    const kept = (await access.overview()).waitlist.map((w) => w.email);
    for (let i = 0; i < 27; i++) expect(kept).toContain(`crowd${i}@example.com`);

    const admin = await joined("omar6@example.com", { admin: true });
    expect((await admin("/api/admin/invite", { email: "crowd26@example.com", send: true })).json).toMatchObject({ mailed: true });

    clock += 86_400_000;
    await visitor("/api/access/waitlist", { email: "nextday@example.com" }, { "x-forwarded-for": "192.0.2.200" });
    expect(mails.at(-1)).toEqual({ action: "waitlist", email: "nextday@example.com", note: "" });
  });
});

describe("the store", () => {
  it("is read back by a fresh server, and picks up an invite written by another process", async () => {
    const again = new Access(data, { now: () => clock });
    const other = new Access(data, { now: () => clock });
    const { link } = await other.invite("ivy@example.com", { base: "https://imagine.test" });
    const s = await again.join(tokenOf(link), "ivy@example.com");
    expect(s.person.email).toBe("ivy@example.com");
    // The first server sees it too.
    expect((await access.overview()).people.some((p) => p.email === "ivy@example.com")).toBe(true);
  });
});

describe("the model call log", () => {
  it("records who made each call, on the real model route", async () => {
    const { createServer } = await import("node:http");
    const { readFileSync } = await import("node:fs");
    const { modelApi } = await import("../../dev/model-plugin.ts");
    // Jev's stand-in: one answer for any question.
    const jev = createServer((_, res) => res.end(JSON.stringify({ answers: { yes: 1 }, model: "jev-1.13.0" })));
    await new Promise<void>((ok) => jev.listen(0, "127.0.0.1", ok));
    const real = host(dist, data, [modelApi({ mockApi: { baseUrl: `http://127.0.0.1:${(jev.address() as AddressInfo).port}`, deadProxyPort: 9 } })], access);
    await new Promise<void>((ok) => real.listen(0, "127.0.0.1", ok));
    const { link } = await access.invite("jo@example.com", { base: "https://imagine.test" });
    const at = `http://127.0.0.1:${(real.address() as AddressInfo).port}`;
    const joinedAs = await fetch(`${at}/api/access/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: tokenOf(link), email: "jo@example.com" }) });
    const cookie = joinedAs.headers.get("set-cookie")!.split(";")[0];
    const r = await fetch(`${at}/api/model`, { method: "POST", headers: { cookie, "x-imagine-person": "someone-else" }, body: JSON.stringify({ model: "jev-1.13.0", system: "", user: JSON.stringify({ state: {}, questions: { q: { type: "noul", instructions: "?", criteria: { yes: "y", no: "n" } } } }), from: "test" }) });
    await r.text();
    real.close();
    jev.close();
    const last = JSON.parse(readFileSync(join(data, "model-calls.jsonl"), "utf8").trim().split("\n").at(-1)!);
    const id = (await access.overview()).people.find((p) => p.email === "jo@example.com")!.id;
    expect(last).toMatchObject({ from: "test", who: id });
    expect((await access.calls(id)).map((c) => (c as { from: string }).from)).toEqual(["test"]);
  });
});

describe("feedback", () => {
  it("is kept with who sent it and the version of the project they were on, for the admin's page only", async () => {
    const kim = await joined("kim@example.com");
    await kim("/api/project/save", { id: "kimcafe1", versions: [version(1), version(2, "add a menu")], meta: { name: "Kim's cafe", pages: 1 } });
    const sent = mails.length;
    const r = await kim("/api/access/feedback", { text: "  The pen is great, but my menu page vanished.  ", project: "kimcafe1", version: 2 });
    expect(r.status).toBe(200);
    // Not mailed: it waits on the admin's page.
    expect(mails.length).toBe(sent);
    const admin = await joined("omar4@example.com", { admin: true });
    const kims = (await admin("/api/admin/overview")).json.people.find((p: { email: string }) => p.email === "kim@example.com");
    expect(kims.feedback).toBe(1);
    expect((await kim(`/api/admin/feedback?person=${kims.id}`)).status).toBe(403);
    const { feedback } = (await admin(`/api/admin/feedback?person=${kims.id}`)).json;
    expect(feedback).toEqual([{ at: clock, person: kims.id, text: "The pen is great, but my menu page vanished.", project: { id: "kimcafe1", name: "Kim's cafe", version: 2 } }]);
  });

  it("needs words and someone signed in, and names only a project and version of theirs", async () => {
    const lee = await joined("lee@example.com");
    expect((await lee("/api/access/feedback", { text: "   " })).status).toBe(400);
    expect((await browser()("/api/access/feedback", { text: "hello" })).status).toBe(401);
    await lee("/api/project/save", { id: "leefarm1", versions: [version(1)], meta: { name: "Lee's farm", pages: 1 } });
    await lee("/api/access/feedback", { text: "someone else's", project: "kimcafe1", version: 2 });
    await lee("/api/access/feedback", { text: "no such version", project: "leefarm1", version: 7 });
    await lee("/api/access/feedback", { text: "no project" });
    const admin = await joined("omar5@example.com", { admin: true });
    const id = (await admin("/api/admin/overview")).json.people.find((p: { email: string }) => p.email === "lee@example.com").id;
    const { feedback } = (await admin(`/api/admin/feedback?person=${id}`)).json;
    expect(feedback.map((f: { text: string; project?: unknown }) => [f.text, f.project])).toEqual([
      ["no project", undefined],
      ["no such version", { id: "leefarm1", name: "Lee's farm" }],
      ["someone else's", undefined],
    ]);
  });
});

describe("the drawing model a call is held to", () => {
  it("runs the drawing call and its warm-ups on that model, and every other call as asked", async () => {
    const { heldTo } = await import("../../dev/model-plugin.ts");
    expect(heldTo({ model: "opus", from: "draw" }, "sonnet")).toBe("sonnet");
    expect(heldTo({ model: "haiku", from: "draw" }, "sonnet")).toBe("sonnet");
    // A warm-up for the drawing call says so; one for pictures doesn't.
    expect(heldTo({ model: "opus", from: "draw", user: undefined }, "sonnet")).toBe("sonnet");
    expect(heldTo({ model: "haiku", from: "picture" }, "sonnet")).toBe("haiku");
    expect(heldTo({ model: "haiku" }, "sonnet")).toBe("haiku");
    expect(heldTo({ model: "opus", from: "draw" }, undefined)).toBe("opus");
    expect(heldTo({ model: "opus", from: "draw" }, ["sonnet", "haiku"])).toBe("opus");
  });
});

describe("the invite command", () => {
  it("runs under plain Node, as on the box, and prints a link the server takes", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(process.execPath, [join(import.meta.dirname, "invite.ts"), "kim@example.com"], { env: { ...process.env, RT_DATA_DIR: data, PUBLIC_URL: "https://imagine.test" }, encoding: "utf8" }).trim();
    expect(out).toMatch(/^https:\/\/imagine\.test\/join\/[A-Za-z0-9_-]{43}$/);
    expect((await browser()("/api/access/join", { token: tokenOf(out), email: "kim@example.com" })).status).toBe(200);
  });
});
