// The editor's board settling (board.ts): old arrows become links, the pages go where
// the layout puts them, and the arrows come with them. On a fake projects server.
import ELK from "elkjs/lib/elk.bundled.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runScript } from "../../../src/core/ops.ts";
import type { SceneJSON } from "../../../src/core/scene.ts";
import { createProject, ready, saveVersions } from "../projects/storage.ts";
import { Board } from "./board.ts";
import demo from "./fixtures/spoke-and-chain-v9.json";
import { setElk } from "./layout.ts";
import { shownArrows } from "./place.ts";

beforeAll(async () => {
  setElk(new ELK());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const path = new URL(url, location.origin).pathname;
      const out = path === "/api/projects" ? { projects: [] } : path === "/api/project" ? { versions: [] } : path === "/api/project/save" ? { versions: body.versions } : { ok: true };
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  await ready();
});

const opened = (doc: SceneJSON) => {
  const id = createProject().id;
  saveVersions(id, [{ n: 1, doc, at: Date.now(), label: "V1" }]);
  history.replaceState(null, "", `/?p=${id}`);
  return new Board();
};

describe("settling the board", () => {
  it("an old board's page arrows become links, its pages are placed, and each page in the tree gets its arrow", async () => {
    const board = opened(demo as SceneJSON);
    await board.settle({ glideMs: 0 });
    const s = board.scene;
    expect(s.get("nav-services")!.link).toBe("services");
    expect(s.get("contact-link")).toBeUndefined();
    expect(s.home).toBe("page");
    expect(s.get("page")!.box).toMatchObject({ x: 0, y: 0 });
    expect(shownArrows(s, board.placement).map((a) => a.to).sort()).toEqual(["contact", "services"]);
    // In memory only: no version of its own.
    expect(board.history.latest()).toBe(1);
  });

  it("the camera goes with the page it was on", async () => {
    const board = opened(demo as SceneJSON);
    const contact = board.scene.get("contact")!.box;
    const moves: [number, number][] = [];
    board.follow = () => ({ centre: { x: contact.x + 100, y: contact.y + 100 }, move: (dx, dy) => moves.push([dx, dy]) });
    await board.settle({ glideMs: 0 });
    const now = board.scene.get("contact")!.box;
    expect(moves.at(-1)).toEqual([now.x - contact.x, now.y - contact.y]);
  });

  it("an old version shows its own arrows, never the live board's", async () => {
    const board = opened(demo as SceneJSON);
    await board.settle({ glideMs: 0 });
    board.commit("placed");
    // V1 has the model's arrows and no links: nothing of the layout's fits it.
    expect(shownArrows(board.versionScene(1), await board.placementFor(1))).toEqual([]);
    expect(shownArrows(board.versionScene(2), await board.placementFor(2))).toHaveLength(2);
  });

  it("the send's version is saved with the pages placed before they glide, so a Restore meanwhile loses nothing", async () => {
    const board = opened(demo as SceneJSON);
    runScript('shape(promo, rect, 100 600 400 80, "a promo banner the send just drew on Home")', board.scene);
    const settled = board.settle({ glideMs: 300, placed: () => board.commit("the send") });
    await new Promise((r) => setTimeout(r, 120));
    board.restore(1);
    await settled;
    const v = board.history.versions.find((x) => x.label === "the send");
    expect(v?.doc.shapes.some((s) => s.id === "promo")).toBe(true);
    expect(v?.doc.shapes.find((s) => s.id === "services")!.box).toMatchObject({ x: 1500, y: -1070 });
  });
});
