// T4's acceptance check: the frozen starts and their baked doodles (evals/fixtures/).
// Start ids are pinned; the ops are src/fixtures/'s, unchanged; baked pictures fill
// every drawing by id|subject|w|h and nothing else; saved starts come from
// $RT_EVAL_HOME/bank/resume/; the same fixtures.ts loads in node and in a page served
// by Vite. 0 model calls: the page makes no /api request (any would end the check).
//   node --import ./evals/loop/node-hooks.mjs evals/checks/t4-fixtures.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createServer } from "vite";
import { openChrome } from "./cdp.mjs";
import { ROOT, check, finish, tempHome } from "./lib.mjs";

const home = tempHome();
const f = await import("../fixtures/fixtures.ts");
const { needsPicture } = await import("../../src/core/picture.ts");
const { pageTop } = await import("../../src/core/board.ts");
const { paths } = await import("../loop/paths.ts");

// ---- Ids, held-out-only starts, pages; the ops are the product's fixtures byte for byte; pictures.json is well formed.
const IDS = ["blank", "toyshop-home", "toyshop-products", "toyshop-cart", "toyshop-zoomed-out", "clowns", "messy", "messy-zoomed-out", "grid"];
check(isDeepStrictEqual(f.FIXTURES.map((x) => x.id), IDS), `start ids changed: ${f.FIXTURES.map((x) => x.id).join(" ")}`);
check(isDeepStrictEqual(f.FIXTURES.filter((x) => x.heldoutOnly).map((x) => x.id), ["toyshop-cart", "messy-zoomed-out", "grid"]), "the held-out-only starts aren't toyshop-cart, messy-zoomed-out and grid");
check(f.FIXTURES.every((x) => x.pages === (x.id.startsWith("toyshop") ? 5 : 1) && x.start.w > 0 && Math.abs(x.start.w / x.start.h - 1.6) < 1e-9), "a start has the wrong page count or a view of the wrong shape");
for (const name of ["board", "clowns", "messy", "grid"]) {
  const read = (dir) => readFileSync(join(ROOT, dir, `${name}.ops.txt`), "utf8");
  check(read("evals/fixtures") === read("src/fixtures"), `evals/fixtures/${name}.ops.txt isn't src/fixtures/'s`);
}
const baked = JSON.parse(readFileSync(join(ROOT, "evals/fixtures/pictures.json"), "utf8"));
check(Object.entries(baked).every(([k, p]) => /^[^|]+\|.+\|\d+\|\d+$/.test(k) && p.w > 0 && p.h > 0 && Array.isArray(p.els)), "pictures.json has an entry that isn't id|subject|w|h → {w, h, els}");
check(isDeepStrictEqual(f.PICTURES, baked), "PICTURES isn't pictures.json");

// ---- A fake pictures file fills every drawing (done, so no picture call), keyed id|subject|w|h; a changed subject or box stays unfilled.
const EL = [{ tag: "circle", attrs: { cx: "40", cy: "30", r: "20", fill: "#ffd43b" } }];
const fakeFor = (scene) => Object.fromEntries(scene.stacked().filter((s) => s.drawing).map((s) => [f.pictureKey(s), { w: 80, h: 60, els: EL }]));
for (const [id, want] of [["toyshop-home", 16], ["clowns", 8], ["messy", 6], ["grid", 1]]) {
  const raw = f.loadFixture(id, { pictures: {} }).scene;
  const drawings = raw.stacked().filter((s) => s.drawing);
  check(drawings.length === want && drawings.every(needsPicture), `${id}: ${drawings.length} drawings (want ${want}), or some already drawn without pictures`);
  const fake = fakeFor(raw);
  const { scene } = f.loadFixture(id, { pictures: fake });
  const filled = scene.stacked().filter((s) => s.drawing);
  check(filled.every((s) => !needsPicture(s) && s.picture.subject === s.drawing && s.picture.done === true && isDeepStrictEqual(s.picture.els, EL)), `${id}: a drawing wasn't filled with its baked picture`);
  check(f.applyPictures(f.loadFixture(id, { pictures: {} }).scene, fake) === want, `${id}: applyPictures didn't report ${want}`);
}
const toy = f.loadFixture("toyshop-home", { pictures: {} }).scene;
const logo = toy.get("logo");
check(f.pictureKey(logo) === `logo|${logo.drawing}|${logo.box.w}|${logo.box.h}`, `the key is ${f.pictureKey(logo)}, not id|subject|w|h`);
const fakeToy = fakeFor(toy);
logo.drawing = "a different logo";
toy.get("hero-photo").box.w += 40;
f.applyPictures(toy, fakeToy);
const unfilled = toy.stacked().filter(needsPicture).map((s) => s.id);
check(isDeepStrictEqual(unfilled, ["logo", "hero-photo"]), `a changed subject or box should stay unfilled, got: ${unfilled.join(", ")}`);

// ---- resume:<target> and site:<target>: the page saved at $RT_EVAL_HOME/bank/resume/<target>.json; missing ones reported.
const saved = f.savedIn(paths().resume);
check(isDeepStrictEqual(f.missingStarts(["site:notion", "resume:bakery", "grid"], saved), ["site:notion", "resume:bakery"]), "missingStarts didn't report both saved starts missing");
const notion = f.loadFixture("clowns").scene.toJSON();
mkdirSync(dirname(paths().resume("notion")), { recursive: true });
writeFileSync(paths().resume("notion"), JSON.stringify(notion));
for (const id of ["site:notion", "resume:notion"]) {
  const { scene, start } = f.loadFixture(id, { saved });
  check(isDeepStrictEqual(JSON.parse(JSON.stringify(scene.toJSON())), JSON.parse(JSON.stringify(notion))) && isDeepStrictEqual(start, pageTop(scene.get("page"))), `${id} didn't load the saved page`);
}
check(isDeepStrictEqual(f.missingStarts(["site:notion", "resume:bakery"], saved), ["resume:bakery"]), "missingStarts still reports a saved start");
const thrown = (fn) => {
  try {
    fn();
    return "";
  } catch (err) {
    return err.message;
  }
};
check(/bank\/resume\/bakery\.json/.test(thrown(() => f.loadFixture("resume:bakery", { saved }))), "a missing saved start didn't say which file it needs");
check(thrown(() => f.loadFixture("site:notion")) !== "", "a saved start loaded with no saved pages");

// ---- The same fixtures.ts in a page served by Vite: the same scenes and starts as in node.
const vite = await createServer({
  root: ROOT, configFile: false, envDir: mkdtempSync(join(home, "env-")), cacheDir: join(home, "vite"), appType: "mpa", logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, watch: null },
});
await vite.listen();
const c = await openChrome();
await c.page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/evals/fixtures/board.ops.txt`);
const inPage = await c.page.eval(`Promise.all([import("/evals/fixtures/fixtures.ts"), import("/src/core/picture.ts")]).then(([f, p]) => f.FIXTURES.map((x) => {
  const { scene, start } = f.loadFixture(x.id);
  const fake = Object.fromEntries(scene.stacked().filter((s) => s.drawing).map((s) => [f.pictureKey(s), { w: 80, h: 60, els: [] }]));
  f.applyPictures(scene, fake);
  return { id: x.id, start, pages: x.pages, json: JSON.stringify(f.loadFixture(x.id).scene.toJSON()), unfilled: scene.stacked().filter(p.needsPicture).length };
}))`);
const inNode = f.FIXTURES.map((x) => ({ id: x.id, start: x.start, pages: x.pages, json: JSON.stringify(f.loadFixture(x.id).scene.toJSON()), unfilled: 0 }));
check(isDeepStrictEqual(inPage, inNode), "fixtures.ts loads differently in the browser than in node");
const n = c.counts();
check(n.seen === 0 && n.stubbed === 0, `the page made /api requests: ${JSON.stringify(n)}`);
check(!c.errors.length, `page errors: ${c.errors.join(" | ")}`);
const left = await c.close();
check(left === 0, `${left} Chrome processes left`);
await vite.close();
finish();
