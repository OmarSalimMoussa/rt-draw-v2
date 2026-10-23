// The editor's settings, kept in this browser: which model draws, and whether the
// latency overlay shows. The menu that changes them is SettingsMenu.tsx; a tester
// always draws with Sonnet (the server holds them to it too). (v1's src/settings.ts,
// with v2's models.)
import { seesInternals } from "./access/api.ts";
import { type DrawModel, drawModel } from "./models.ts";

const MODEL_KEY = "rt-draw.model";
const LATENCY_KEY = "rt-draw.debug.latency";

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

export function getModel(): DrawModel {
  if (!seesInternals()) return drawModel("sonnet");
  try {
    return drawModel(localStorage.getItem(MODEL_KEY));
  } catch {
    return drawModel(undefined);
  }
}

export function setModel(name: DrawModel["name"]) {
  try {
    localStorage.setItem(MODEL_KEY, name);
  } catch {}
  changed();
}

// The latency overlay: kept here too, so it works even where storage doesn't.
let latencyOverlay = (() => {
  try {
    return localStorage.getItem(LATENCY_KEY) === "on";
  } catch {
    return false;
  }
})();

export const showsLatency = () => latencyOverlay;

export function setShowsLatency(on: boolean) {
  latencyOverlay = on;
  try {
    if (on) localStorage.setItem(LATENCY_KEY, "on");
    else localStorage.removeItem(LATENCY_KEY);
  } catch {}
  changed();
}

export function onSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
