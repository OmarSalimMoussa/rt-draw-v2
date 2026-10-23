// The page's shell (index.html) as a link preview or a search engine reads it: they don't run the
// app, so the title, description, share image and icons are in the HTML itself.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = join(import.meta.dirname, "..");
const html = readFileSync(join(app, "index.html"), "utf8");
const meta = (attr: string, key: string) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1];
const SITE = "https://imagine.emberhub.dev";

describe("the page's shell", () => {
  it("gives link previews a title, a description and a big image", () => {
    expect(html).toContain("<title>imagine: prototyping at the speed of thought</title>");
    expect(meta("property", "og:title")).toBe("imagine: prototyping at the speed of thought");
    for (const kind of ["website", "phone app", "diagram", "drawing"]) expect(meta("name", "description")).toContain(kind);
    expect(meta("property", "og:description")).toBe(meta("name", "description"));
    expect(meta("property", "og:url")).toBe(`${SITE}/`);
    expect(meta("property", "og:image")).toBe(`${SITE}/share.png`);
    expect([meta("property", "og:image:width"), meta("property", "og:image:height")]).toEqual(["1200", "630"]);
    expect(meta("name", "twitter:card")).toBe("summary_large_image");
  });

  it("has icons, and every file it points to is there", () => {
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    const files = [...html.matchAll(/(?:href|content)="(?:https:\/\/imagine\.emberhub\.dev)?\/([\w.-]+\.(?:svg|png|ico))"/g)].map((m) => m[1]);
    expect(files).toEqual(expect.arrayContaining(["favicon.svg", "apple-touch-icon.png", "share.png"]));
    for (const f of [...files, "favicon.ico"]) expect(existsSync(join(app, "public", f)), f).toBe(true);
  });
});
