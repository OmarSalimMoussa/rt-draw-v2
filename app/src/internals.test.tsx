// What a tester sees of the inside: nothing. The models, their prices, Jev, Scribe and the
// latency overlay are for the admin (and the dev server, which has no invites); a tester's
// settings are who they are, Sign out and Start from scratch.
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whoAmI } from "./access/api.ts";
import { getModel, setModel } from "./settings.ts";
import { SettingsMenu } from "./SettingsMenu.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { plainVoiceError } from "./speech/voice.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSIDE = /sonnet|opus|haiku|claude|jev|typesafe|scribe|latency|model/i;
let root: Root;
let el: HTMLDivElement;

async function signedInAs(person: { email: string; admin: boolean } | undefined) {
  vi.stubGlobal("fetch", async () => (person ? new Response(JSON.stringify({ person }), { status: 200 }) : new Response("{}", { status: 404 })));
  await whoAmI();
}
beforeEach(() => {
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
const openSettings = () => act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click());
/** Everything a person can read, hover tooltips included. */
const readable = () => [el.textContent, ...[...el.querySelectorAll("[title]")].map((e) => e.getAttribute("title"))].join(" ");
const status = { running: false, queued: 0, ops: 0, settling: false, done: true, failed: 0, callErrors: ["Jev: timed out after 8 s"], rejected: 0 };

describe("a tester", () => {
  beforeEach(() => signedInAs({ email: "ada@example.com", admin: false }));

  it("has settings with who they are, Sign out and Start from scratch, and nothing about models or latency", async () => {
    await show(<SettingsMenu />);
    await openSettings();
    const menu = el.querySelector('[role="dialog"]')!;
    expect(menu.textContent).toContain("Signed in as ada@example.com");
    expect([...menu.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Sign out", "Start from scratch…"]);
    expect(readable()).not.toMatch(INSIDE);
  });

  it("draws with Sonnet, even if this browser once picked another model", () => {
    setModel("opus");
    expect(getModel().name).toBe("sonnet");
  });

  it("sees Done or Couldn't draw that, never which model call failed or why", async () => {
    await show(<StatusBadge status={status} />);
    expect(el.textContent).toBe("Done");
    expect(readable()).not.toMatch(INSIDE);
    await show(<StatusBadge status={{ ...status, done: false, error: "draw: Claude process exited 1", failed: 1, callErrors: [] }} />);
    expect(el.textContent).toBe("Couldn't draw that");
    expect(readable()).not.toMatch(INSIDE);
  });
});

describe("the admin", () => {
  beforeEach(() => signedInAs({ email: "omar@example.com", admin: true }));

  it("has the models, the latency overlay and the people page in settings", async () => {
    await show(<SettingsMenu />);
    await openSettings();
    const menu = el.querySelector('[role="dialog"]')!;
    expect(menu.textContent).toContain("Claude Sonnet 5.5");
    expect(menu.textContent).toContain("Latency overlay");
    expect(menu.textContent).toContain("People and waitlist");
  });

  it("draws with the model they pick", () => {
    setModel("opus");
    expect(getModel().name).toBe("opus");
    setModel("sonnet");
  });

  it("sees which model call failed and why", async () => {
    await show(<StatusBadge status={status} />);
    expect(readable()).toContain("Jev: timed out after 8 s");
  });
});

describe("the dev server (no invites)", () => {
  it("shows everything, as before", async () => {
    await signedInAs(undefined);
    await show(<SettingsMenu />);
    await openSettings();
    expect(el.textContent).toContain("Claude Sonnet 5.5");
    expect(el.textContent).toContain("Latency overlay");
  });
});

describe("voice errors in plain words", () => {
  it("says what to do, without naming the speech service", () => {
    expect(plainVoiceError("Scribe disconnected (1006)")).toBe("Listening stopped. Press the mic to try again, or type instead.");
    expect(plainVoiceError("Permission denied")).toBe("imagine can't hear you: allow the microphone for this site, or type instead.");
    expect(plainVoiceError("NotAllowedError: Permission dismissed")).toBe("imagine can't hear you: allow the microphone for this site, or type instead.");
    expect(plainVoiceError("Requested device not found")).toBe("No microphone found. Plug one in, or type instead.");
  });
});
