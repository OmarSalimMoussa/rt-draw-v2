// The model call inspector, shared by every page (a modal, src/modal.ts): each call made from the page, exactly
// as sent (system prompt, message, images), how it was made (model, thinking,
// caching, limits), how long it took, and the prompt's structure as a bar of
// its sections. Calls are recorded by callModel (src/core/model.ts).
import { CALLS_EVENT, type CallRecord, calls } from "./core/model.ts";
import { type Modal, openModal } from "./modal.ts";

type Section = { part: "system" | "message" | "image" | "reply"; name: string; text?: string; image?: string; chars: number; tokens: number };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** Rough token count for text: about 4 characters a token. */
const textTokens = (s: string) => Math.ceil(s.length / 4);
const COLORS: Record<Section["part"], string> = { system: "#5f3dc4", message: "#1971c2", image: "#e8590c", reply: "#2b8a3e" };

/**
 * A prompt's sections. Text is split at blank lines; a block whose first line is
 * a short label ending in ":" starts a named section ("Shapes, back to front
 * (id: description):"), and unlabeled blocks run together.
 */
function split(part: "system" | "message", text: string): Section[] {
  const out: Section[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const first = block.split("\n")[0].trim();
    const label = first.length <= 80 && /:$/.test(first) ? first.replace(/:$/, "") : undefined;
    const last = out.at(-1);
    if (!label && last && !last.name.startsWith("§")) {
      last.text += `\n\n${block}`;
      continue;
    }
    out.push({ part, name: label ? `§ ${label}` : part === "system" ? "instructions" : "text", text: block, chars: 0, tokens: 0 });
  }
  for (const s of out) [s.chars, s.tokens] = [s.text!.length, textTokens(s.text!)];
  return out;
}

const imageSize = (url: string) =>
  new Promise<[number, number]>((done) => {
    const img = new Image();
    img.onload = () => done([img.naturalWidth, img.naturalHeight]);
    img.onerror = () => done([0, 0]);
    img.src = url;
  });

async function sections(c: CallRecord): Promise<Section[]> {
  const images = await Promise.all(
    (c.req.images ?? []).map(async (url, i) => {
      const [w, h] = await imageSize(url);
      const kb = Math.round((url.length * 3) / 4 / 1024);
      // Anthropic's rule of thumb for an image: width × height / 750 tokens.
      return { part: "image", name: `image ${i + 1} · ${w}×${h} · ${kb} KB`, image: url, chars: 0, tokens: Math.round((w * h) / 750) } as Section;
    }),
  );
  return [...split("system", c.req.system), ...images, ...split("message", c.req.user)];
}

function bar(secs: Section[]) {
  const total = secs.reduce((a, s) => a + s.tokens, 0) || 1;
  return `<div style="display:flex;height:26px;border:1.5px solid var(--ink);border-radius:6px;overflow:hidden">${secs
    .map((s) => `<div title="${esc(s.name)} · ~${s.tokens} tokens" style="flex:${s.tokens} 0 0;min-width:3px;background:${COLORS[s.part]};opacity:${s.part === "image" ? 0.75 : 0.55 + 0.45 * (s.tokens / total)};border-right:1px solid #fff"></div>`)
    .join("")}</div>`;
}

const row = (k: string, v: string | number | undefined) => `<tr><th style="white-space:nowrap">${k}</th><td>${v === undefined || v === "" ? '<span class="muted">-</span>' : esc(String(v))}</td></tr>`;

async function detail(c: CallRecord) {
  const s = c.stats;
  const secs = await sections(c);
  const tokens = (p: Section["part"]) => secs.filter((x) => x.part === p).reduce((a, x) => a + x.tokens, 0);
  const settings = s?.settings ?? {};
  const overview = `<table class="marks">
    ${row("model", `${c.req.model}${s?.modelId ? ` (${s.modelId})` : ""}`)}
    ${row("called from", `${c.req.from ?? "?"} · ${c.page} · ${new Date(c.at).toLocaleTimeString()}`)}
    ${row("status", c.running ? "running…" : c.error ? `failed: ${c.error}` : "done")}
    ${row("latency", s ? `first text ${s.firstMs ?? "-"} ms · total ${s.ms} ms` : "")}
    ${row("process", s?.waitMs !== undefined ? `${s.warm ? "already waiting" : "started for this call"} · ready after ${s.waitMs} ms (the model's own time to first text: ${s.firstMs !== undefined ? s.firstMs - s.waitMs : "-"} ms)` : "")}
    ${row("tokens", s ? `${(s.inTokens ?? 0) + (s.cacheRead ?? 0) + (s.cacheWrite ?? 0)} in (${s.inTokens ?? "?"} uncached) · ${s.outTokens ?? "?"} out` : "")}
    ${row("cache", s ? `read ${s.cacheRead ?? 0} · written ${s.cacheWrite ?? 0} tokens` : "")}
    ${Object.entries(settings).map(([k, v]) => row(k, v)).join("")}
  </table>`;
  const legend = (["system", "image", "message"] as const).map((p) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px"><i style="width:10px;height:10px;background:${COLORS[p]};display:inline-block;border-radius:2px"></i>${p} ~${tokens(p)} tokens</span>`).join("");
  const list = secs
    .map((x, i) => `<details${i === 0 ? "" : ""}><summary><i style="width:10px;height:10px;background:${COLORS[x.part]};display:inline-block;border-radius:2px;margin-right:6px"></i><b>${x.part}</b> · ${esc(x.name)} <span class="muted">· ~${x.tokens} tokens${x.chars ? ` · ${x.chars} chars` : ""}</span></summary>${x.image ? `<img src="${x.image}" style="max-width:100%;border:1px solid var(--line);border-radius:6px;margin:6px 0">` : `<pre class="log" style="max-height:360px;background:#faf9f6;padding:8px;border-radius:6px">${esc(x.text ?? "")}</pre>`}</details>`)
    .join("");
  const reply = `<details${c.running ? " open" : ""}><summary><i style="width:10px;height:10px;background:${COLORS.reply};display:inline-block;border-radius:2px;margin-right:6px"></i><b>reply</b> <span class="muted">· ${c.reply.length} chars</span></summary><pre class="log" style="max-height:360px;background:#faf9f6;padding:8px;border-radius:6px">${esc(c.reply)}</pre></details>`;
  return `<h3 style="margin:4px 0">Call ${c.n}</h3>${overview}
    <h3 style="margin:12px 0 4px">Prompt structure</h3>${bar(secs)}<div class="stat" style="margin:4px 0">${legend}</div>
    <div class="muted stat">Not sent to the model: the page, time, and "called from", kept only for this log.</div>
    <h3 style="margin:12px 0 4px">Exactly what was sent, in order</h3>${list}${reply}
    <div class="row" style="margin-top:8px"><button data-copy="${c.n}">Copy the request as JSON</button></div>`;
}

let modal: Modal | undefined;
let selected = 0;

function listHtml() {
  return [...calls]
    .reverse()
    .map((c) => `<button data-n="${c.n}" style="text-align:left;font-size:12px;${c.n === selected ? "background:#fff4e6;" : ""}"><b>${c.n}. ${esc(c.req.from ?? "?")}</b> · ${c.req.model}<br><span class="muted">${c.running ? "running…" : c.error ? "failed" : `${c.stats?.ms ?? "?"} ms`}</span></button>`)
    .join("");
}

async function refresh(detailToo: boolean) {
  if (!modal?.isOpen()) return;
  modal.body.querySelector("[data-list]")!.innerHTML = listHtml();
  if (!detailToo) return;
  const c = calls.find((x) => x.n === selected);
  (modal.body.querySelector("[data-detail]") as HTMLElement).innerHTML = c ? await detail(c) : '<p class="muted">No calls yet on this page.</p>';
}

/** Opens the inspector on call n (the latest when omitted). Any page can call this, e.g. from a "inspect" link. */
export function openCallInspector(n?: number) {
  selected = n ?? calls.at(-1)?.n ?? 0;
  if (!modal?.isOpen()) {
    modal = openModal("Model calls");
    modal.body.style.cssText += ";display:grid;grid-template-columns:220px 1fr";
    modal.body.innerHTML = `<div data-list style="border-right:1px solid var(--line);overflow:auto;padding:10px;display:grid;gap:4px;align-content:start"></div><div data-detail style="overflow:auto;padding:12px 18px"></div>`;
    modal.body.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("button");
      if (el?.dataset.n) {
        selected = Number(el.dataset.n);
        void refresh(true);
      } else if (el?.dataset.copy) {
        const c = calls.find((x) => x.n === Number(el.dataset.copy));
        if (c) void navigator.clipboard?.writeText(JSON.stringify({ model: c.stats?.modelId ?? c.req.model, settings: c.stats?.settings, system: c.req.system, images: c.req.images, user: c.req.user }, null, 1));
      }
    });
  }
  void refresh(true);
}

/** The page's "Model calls (n)" button, bottom right, shown once the page has made a call. */
export function mountCallsView() {
  const btn = document.createElement("button");
  btn.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:20;display:none;box-shadow:2px 3px 0 #0002";
  document.body.append(btn);
  btn.addEventListener("click", () => openCallInspector());
  const label = () => {
    btn.style.display = calls.length ? "block" : "none";
    btn.textContent = `Model calls (${calls.length})${calls.some((c) => c.running) ? " …" : ""}`;
  };
  // Live: the list as calls start and end; the open call's detail when it ends (not on every streamed chunk).
  let wasRunning = new Set<number>();
  window.addEventListener(CALLS_EVENT, () => {
    label();
    const running = new Set(calls.filter((c) => c.running).map((c) => c.n));
    void refresh(wasRunning.has(selected) && !running.has(selected));
    wasRunning = running;
  });
  label();
}
