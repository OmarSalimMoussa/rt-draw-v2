// Ops stream playground: replay a model reply in token-sized chunks and apply
// each op the moment its line is complete.
import clowns from "../../src/fixtures/clowns.ops.txt?raw";
import reply from "../../src/fixtures/reply.ops.txt?raw";
import { OpStream, applyOp, runScript } from "../../src/core/ops.ts";
import { render } from "../../src/core/render.ts";
import { Scene } from "../../src/core/scene.ts";
import { $, fontsReady, shell, stage } from "../../src/ui.ts";

shell("ops", "The model's reply arrives a few characters at a time. Each line becomes a visible change as soon as it's complete; bad lines are reported and skipped.");
const { canvas } = stage($("#left"));

$("#side").innerHTML = `
  <div class="card">
    <h2>Reply</h2>
    <div class="row">
      <label>start from <select id="base"><option value="empty">an empty canvas</option><option value="clowns">Clowns.com</option></select></label>
    </div>
    <textarea id="reply" rows="14" spellcheck="false"></textarea>
    <div class="row">
      <label>chunk <input type="range" id="chunk" min="1" max="16" value="4"> <span id="chunkv"></span></label>
      <label>every <input type="range" id="delay" min="0" max="80" value="15"> <span id="delayv"></span></label>
    </div>
    <div class="row"><button class="primary" id="go">Stream it</button><button id="all">Apply at once</button></div>
    <div class="stat" id="stat"></div>
  </div>
  <div class="card"><h2>What happened, line by line</h2><pre class="log" id="log"></pre></div>`;

const chunk = $<HTMLInputElement>("#chunk");
const delay = $<HTMLInputElement>("#delay");
const showKnobs = () => {
  $("#chunkv").textContent = `${chunk.value} chars`;
  $("#delayv").textContent = `${delay.value} ms`;
};
chunk.addEventListener("input", showKnobs);
delay.addEventListener("input", showKnobs);
showKnobs();
$<HTMLTextAreaElement>("#reply").value = reply;

const base = () => ($<HTMLSelectElement>("#base").value === "clowns" ? runScript(clowns).scene : new Scene());
let run = 0;

async function stream(instant: boolean) {
  const mine = ++run;
  const scene = base();
  render(canvas, scene);
  const text = $<HTMLTextAreaElement>("#reply").value;
  const log: string[] = [];
  const s = new OpStream();
  const t0 = performance.now();
  let first: number | undefined;
  let applied = 0;
  let failed = 0;
  let drawMs = 0;
  const handle = (parsed: ReturnType<OpStream["push"]>) => {
    for (const p of parsed) {
      const at = (performance.now() - t0).toFixed(0).padStart(5);
      if (p.ok === "skip") continue;
      if (!p.ok) {
        failed++;
        log.push(`${at} ms ✗ ${p.line}\n         ${p.error}`);
        continue;
      }
      try {
        applyOp(scene, p.op);
        applied++;
        first ??= performance.now() - t0;
        drawMs = render(canvas, scene);
        log.push(`${at} ms ✓ ${p.op.line}`);
      } catch (e) {
        failed++;
        log.push(`${at} ms ✗ ${p.op.line}\n         ${(e as Error).message}`);
      }
    }
    $("#log").innerHTML = log.map((l) => `<span class="${l.includes("✗") ? "bad" : "ok"}">${l.replace(/</g, "&lt;")}</span>`).join("\n");
  };
  if (instant) handle(s.push(text));
  else {
    const size = Number(chunk.value);
    for (let i = 0; i < text.length; i += size) {
      if (mine !== run) return;
      handle(s.push(text.slice(i, i + size)));
      await new Promise((r) => setTimeout(r, Number(delay.value)));
    }
  }
  handle(s.end());
  $("#stat").textContent = `${applied} applied · ${failed} rejected · first change at ${first?.toFixed(0) ?? "-"} ms · last redraw ${drawMs.toFixed(1)} ms`;
}

$("#go").addEventListener("click", () => stream(false));
$("#all").addEventListener("click", () => stream(true));
$("#base").addEventListener("change", () => render(canvas, base()));
fontsReady().then(() => render(canvas, base()));
