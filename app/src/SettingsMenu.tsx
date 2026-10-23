// The gear at the top right of the editor, and its menu: which model draws, the
// latency overlay, and who is signed in. (v1's SettingsMenu.tsx, with v2's models;
// Debug always shows.)
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { currentMe, signOut } from "./access/api.ts";
import { DEFAULT_MODEL, DRAW_MODELS } from "./models.ts";
import { deleteAllProjects } from "./projects/storage.ts";
import { getModel, onSettings, setModel, setShowsLatency, showsLatency } from "./settings.ts";
import { Icon } from "./sketch/Icon.tsx";

const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const model = useSyncExternalStore(onSettings, getModel);
  const [wiping, setWiping] = useState<"ask" | "busy" | null>(null);
  const latency = useSyncExternalStore(onSettings, showsLatency);
  const root = useRef<HTMLDivElement>(null);
  const me = currentMe();

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("pointerdown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("pointerdown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="st" ref={root}>
      <button type="button" className={open ? "st-gear on" : "st-gear"} onClick={() => setOpen(!open)} title={`Settings (model: ${model.label})`} aria-label="Settings" aria-expanded={open}>
        <Icon name="gear" size={18} />
      </button>
      {open && (
        <div className="st-menu" role="dialog" aria-label="Settings">
          <div className="st-title">Model</div>
          <div className="st-models" role="radiogroup" aria-label="Model">
            {DRAW_MODELS.map((m) => (
              <label key={m.name} className={m.name === model.name ? "on" : ""}>
                <input type="radio" name="st-model" checked={m.name === model.name} onChange={() => setModel(m.name)} />
                <span>{m.label}{m === DEFAULT_MODEL && <em> default</em>}</span>
                <span className="st-price">{usd(m.price[0])} / {usd(m.price[1])}</span>
              </label>
            ))}
          </div>
          <p className="st-note">Prices are USD per million tokens in / out. Pictures are drawn with Claude Sonnet 5.5, and Jev (TypeSafe AI) works out what you point at.</p>
          {me && (
            <>
              <div className="st-title">Account</div>
              <p className="st-note">Signed in as {me.email}</p>
              <div className="st-account">
                {me.admin && <a href="/admin">People and waitlist</a>}
                <button type="button" onClick={() => signOut().finally(() => location.assign("/"))}>Sign out</button>
              </div>
            </>
          )}
          <div className="st-title">Debug</div>
          <label className={latency ? "st-toggle on" : "st-toggle"}>
            <input type="checkbox" checked={latency} onChange={(e) => setShowsLatency(e.target.checked)} />
            <span>Latency overlay</span>
            <span className="st-price">Enter → on screen</span>
          </label>
          {wiping ? (
            <div className="st-wipe" role="group" aria-label="Start from scratch">
              <span>Delete all your projects and settings, and start over?</span>
              <button
                type="button"
                className="st-danger"
                disabled={wiping === "busy"}
                onClick={async () => {
                  setWiping("busy");
                  await deleteAllProjects().catch(() => {});
                  try {
                    for (const k of Object.keys(localStorage)) if (k.startsWith("rt-draw")) localStorage.removeItem(k);
                  } catch {}
                  location.assign("/");
                }}
              >
                Delete everything
              </button>
              <button type="button" onClick={() => setWiping(null)}>Keep</button>
            </div>
          ) : (
            <button type="button" className="st-wipe-start" onClick={() => setWiping("ask")}>Start from scratch…</button>
          )}
        </div>
      )}
    </div>
  );
}
