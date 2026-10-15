// The one modal every page uses: a centered sheet over a dimmed page, closed by
// ✕, Esc, or a click on the backdrop. Content is the caller's.

export type Modal = { body: HTMLElement; close: () => void; isOpen: () => boolean };

export function openModal(title: string, onClose?: () => void): Modal {
  const back = document.createElement("div");
  back.style.cssText = "position:fixed;inset:0;z-index:40;background:#1e1e1e66;display:grid;place-items:center;padding:24px";
  const sheet = document.createElement("div");
  sheet.style.cssText = "width:min(1100px,100%);height:min(86vh,100%);background:var(--paper);border:1.5px solid var(--ink);border-radius:12px;box-shadow:4px 6px 0 #0003;display:grid;grid-template-rows:auto 1fr;overflow:hidden";
  sheet.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1.5px solid var(--ink);background:var(--panel)"><h2 style="font:22px Excalifont,cursive;margin:0"></h2><button data-close aria-label="Close">✕</button></div><div data-body style="overflow:hidden;min-height:0"></div>`;
  sheet.querySelector("h2")!.textContent = title;
  back.append(sheet);
  document.body.append(back);
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    back.remove();
    window.removeEventListener("keydown", esc);
    onClose?.();
  };
  const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
  window.addEventListener("keydown", esc);
  back.addEventListener("click", (e) => e.target === back && close());
  sheet.querySelector("[data-close]")!.addEventListener("click", close);
  return { body: sheet.querySelector("[data-body]") as HTMLElement, close, isOpen: () => open };
}
