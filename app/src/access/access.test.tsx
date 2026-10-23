// The pages before the app (Welcome, Join) and the admin's page (Admin), on a stand-in server.
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "./Admin.tsx";
import { FeedbackButton } from "./Feedback.tsx";
import { Join } from "./Join.tsx";
import { Welcome } from "./Welcome.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { status?: number; body: unknown };
let routes: Record<string, (body: any) => Answer>;
let sent: { path: string; body: any }[];
let root: Root;
let el: HTMLDivElement;

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ path, body });
      const route = routes[path.split("?")[0]];
      const a = route ? route(body) : { status: 404, body: { error: "no such route" } };
      return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

const show = (node: React.ReactNode) => act(async () => root.render(node));
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
const $ = <T extends Element = HTMLElement>(css: string) => el.querySelector<T>(css)!;
const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const submit = (form: HTMLFormElement) => act(async () => void form.requestSubmit());

describe("the welcome page", () => {
  it("says why imagine exists: prototyping at the speed of thought", async () => {
    await show(<Welcome />);
    expect($("h1").textContent).toBe("Prototyping at the speed of thought.");
    expect($(".ac-lede").textContent).toContain("as fast as you can say it");
    // Not only websites.
    for (const kind of ["website", "phone app", "desktop app", "macOS or Ubuntu desktop", "system diagram", "drawing"]) expect($(".ac-lede").textContent).toContain(kind);
  });

  it("has doodles all over its background: the pictures, the logo and scribbles, each turned its own way", async () => {
    await show(<Welcome />);
    const layer = $(".ac-doodles");
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    const items = [...layer.children] as HTMLElement[];
    expect(items.length).toBeGreaterThanOrEqual(18);
    const pictures = [...layer.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    for (const n of ["duck", "chicken", "bread", "pencil"]) expect(pictures).toContain(`/doodles/${n}.svg`);
    expect(layer.querySelector(".ac-doodle-logo")).not.toBeNull();
    expect(layer.querySelector(".ac-scribble")).not.toBeNull();
    expect(new Set(items.map((i) => i.style.transform)).size).toBeGreaterThan(items.length / 2);
  });

  it("puts an email on the waitlist, with a note, and says what happens next", async () => {
    routes = { "/api/access/waitlist": () => ({ body: { ok: true } }) };
    await show(<Welcome />);
    expect(el.textContent).toContain("imagine");
    type($("input[type=email]"), "hal@example.com");
    type($("textarea"), "I run a bakery");
    await submit($("form"));
    await settle();
    expect(sent).toEqual([{ path: "/api/access/waitlist", body: { email: "hal@example.com", note: "I run a bakery", website: "" } }]);
    expect(el.textContent).toContain("You're on the list");
  });

  it("says, by the form, what the email is for", async () => {
    await show(<Welcome />);
    expect($("form .ac-fine").textContent).toBe("We'll only use your email to send your invite.");
  });

  it("shows the server's reason when it says no", async () => {
    routes = { "/api/access/waitlist": () => ({ status: 429, body: { error: "That's a lot of sign-ups from here. Try again in an hour." } }) };
    await show(<Welcome />);
    type($("input[type=email]"), "hal@example.com");
    await submit($("form"));
    await settle();
    expect($("[role=alert]").textContent).toBe("That's a lot of sign-ups from here. Try again in an hour.");
  });
});

describe("joining with an invite", () => {
  it("sends the link's token and the typed email; a wrong email says so, the right one opens the app", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...location, replace });
    routes = {
      "/api/access/join": (b) => (b.email === "ada@example.com" ? { body: { person: { email: b.email, admin: false } } } : { status: 403, body: { error: "That isn't the email this invite was sent to." } }),
    };
    await show(<Join token="tok123" />);
    expect(el.querySelector(".ac-doodles")).not.toBeNull();
    type($("input[type=email]"), "eve@example.com");
    await submit($("form"));
    await settle();
    expect($("[role=alert]").textContent).toBe("That isn't the email this invite was sent to.");
    expect(replace).not.toHaveBeenCalled();
    type($("input[type=email]"), "ada@example.com");
    await submit($("form"));
    await settle();
    expect(sent.at(-1)).toEqual({ path: "/api/access/join", body: { token: "tok123", email: "ada@example.com" } });
    expect(replace).toHaveBeenCalledWith("/");
  });
});

describe("the feedback button", () => {
  it("opens a box; what's written goes with the project and version they're on, then it thanks them", async () => {
    routes = { "/api/access/feedback": () => ({ body: { ok: true } }) };
    await show(<FeedbackButton beg={false} project="kimcafe1" version={2} />);
    await act(async () => $<HTMLButtonElement>(".fb-go").click());
    type($("textarea"), "My menu page vanished");
    await submit($("form"));
    await settle();
    expect(sent).toEqual([{ path: "/api/access/feedback", body: { text: "My menu page vanished", project: "kimcafe1", version: 2 } }]);
    expect(el.textContent).toContain("Thanks");
  });

  it("points at itself with an arrow and asks, until drawing starts", async () => {
    await show(<FeedbackButton beg project="kimcafe1" version={0} />);
    expect($(".fb-beg").textContent).toBe("Tell Omar what you think!");
    await show(<FeedbackButton beg={false} project="kimcafe1" version={1} />);
    expect(el.querySelector(".fb-beg")).toBeNull();
  });

  it("says why when it can't send, and keeps what they wrote", async () => {
    routes = { "/api/access/feedback": () => ({ status: 429, body: { error: "That's a lot of feedback at once. Try again in a little while." } }) };
    await show(<FeedbackButton beg={false} project="kimcafe1" version={2} />);
    await act(async () => $<HTMLButtonElement>(".fb-go").click());
    type($("textarea"), "again");
    await submit($("form"));
    await settle();
    expect($("[role=alert]").textContent).toBe("That's a lot of feedback at once. Try again in a little while.");
    expect($<HTMLTextAreaElement>("textarea").value).toBe("again");
  });
});

describe("the admin's page", () => {
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  beforeEach(() => {
    routes = {
      "/api/admin/overview": () => ({
        body: {
          people: [
            { id: "p1", email: "di@example.com", invitedAt: now - 3 * day, linkAt: now - 3 * day, joinedAt: now - 2 * day, lastSeen: now - 3600_000, projects: 2, versions: 7, feedback: 1 },
            { id: "p2", email: "ed@example.com", invitedAt: now - day, linkAt: now - day, projects: 0, versions: 0, feedback: 0 },
          ],
          waitlist: [{ email: "hal@example.com", note: "I run a bakery", at: now - 600_000 }],
        },
      }),
      "/api/admin/invite": (b) => ({ body: { link: `https://imagine.test/join/new-${b.email}`, mailed: b.send } }),
      "/api/admin/revoke": () => ({ body: { ok: true } }),
      "/api/admin/projects": () => ({ body: { projects: [{ id: "dibakery", name: "Di's bakery", pages: 1, versions: 5, updatedAt: now }] } }),
      "/api/admin/feedback": () => ({ body: { feedback: [{ at: now - 60_000, person: "p1", text: "The cards overlap the photo", project: { id: "dibakery", name: "Di's bakery", version: 2 } }] } }),
      "/api/admin/project": () => ({ body: { versions: [1, 2, 3].map((n) => ({ n, at: now, label: `send ${n}`, doc: { v: 1, width: 1280, height: 800, shapes: [], groups: {} } })) } }),
      "/api/admin/calls": () => ({ body: { calls: [{ at: new Date(now).toISOString(), from: "draw", model: "sonnet", ms: 4200, error: "Claude is down", user: "make it blue" }] } }),
    };
  });

  it("lists the waitlist and everyone invited, with what they've done", async () => {
    await show(<Admin me={{ email: "omar@example.com", admin: true }} />);
    await settle();
    const rows = [...el.querySelectorAll("[data-person]")].map((r) => r.textContent);
    expect(rows[0]).toContain("di@example.com");
    expect(rows[0]).toContain("2 projects");
    expect(rows[0]).toContain("7 sends");
    expect(rows[1]).toContain("ed@example.com");
    expect(rows[1]).toContain("hasn't joined");
    expect($("[data-waiting]").textContent).toContain("I run a bakery");
  });

  it("inviting from the waitlist mails the link and shows it to copy", async () => {
    await show(<Admin me={{ email: "omar@example.com", admin: true }} />);
    await settle();
    await act(async () => $<HTMLButtonElement>("[data-waiting] button").click());
    await settle();
    expect(sent.find((s) => s.path === "/api/admin/invite")!.body).toEqual({ email: "hal@example.com", send: true });
    expect($<HTMLInputElement>(".ad-link input").value).toBe("https://imagine.test/join/new-hal@example.com");
    expect(el.textContent).toContain("Emailed to hal@example.com");
  });

  it("asks before revoking someone", async () => {
    await show(<Admin me={{ email: "omar@example.com", admin: true }} />);
    await settle();
    await act(async () => $<HTMLButtonElement>('[data-person="p1"] .ad-revoke').click());
    expect(sent.some((s) => s.path === "/api/admin/revoke")).toBe(false);
    await act(async () => button("Revoke access").click());
    await settle();
    expect(sent.find((s) => s.path === "/api/admin/revoke")!.body).toEqual({ email: "di@example.com" });
  });

  it("shows who sent feedback, and opens it with the version of the drawing it was sent on", async () => {
    await show(<Admin me={{ email: "omar@example.com", admin: true }} />);
    await settle();
    expect($('[data-person="p1"]').textContent).toContain("1 feedback");
    expect($('[data-person="p2"]').textContent).not.toContain("feedback");
    await act(async () => $<HTMLButtonElement>('[data-person="p1"] .ad-open').click());
    await settle();
    expect($(".ad-feedback").textContent).toContain("The cards overlap the photo");
    await act(async () => $<HTMLButtonElement>(".ad-feedback button").click());
    await settle();
    expect($(".ad-versions button.on").textContent).toContain("V2");
  });

  it("opens someone's work: their projects and their model calls, errors included", async () => {
    await show(<Admin me={{ email: "omar@example.com", admin: true }} />);
    await settle();
    await act(async () => $<HTMLButtonElement>('[data-person="p1"] .ad-open').click());
    await settle();
    expect(el.textContent).toContain("Di's bakery");
    expect(el.textContent).toContain("make it blue");
    expect($(".ad-call.bad").textContent).toContain("Claude is down");
  });
});
