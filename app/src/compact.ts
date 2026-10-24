// Phones, and any small window: the sidebar folds into a button and the board takes the whole screen.
// The CSS's compact rules (styles.css, preview/preview.css, access/access.css) use the same query.
import { useSyncExternalStore } from "react";

export const COMPACT = "(max-width: 640px), (max-height: 500px)";

/** Whether the screen is compact, read now (in handlers). */
export const isCompact = () => matchMedia(COMPACT).matches;

const subscribe = (changed: () => void) => {
  const q = matchMedia(COMPACT);
  q.addEventListener("change", changed);
  return () => q.removeEventListener("change", changed);
};
/** Whether the screen is compact, kept up to date as a phone turns or a window is resized. */
export const useCompact = () => useSyncExternalStore(subscribe, isCompact);
