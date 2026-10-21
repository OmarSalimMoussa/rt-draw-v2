// Keeps Claude processes waiting for the calls a send will make, as the eval had
// them for every case. The dev server closes a waiting process 10 minutes after it
// started, used or not, and a warm request only tops a pool up (dev/claude.ts), so
// processes started together would all go together, leaving a send cold until the
// next top-up. Once the first ones are half way there, one spare is asked for too:
// started later, it is still waiting when they go.

/** How often the pools are topped up. */
export const WARM_EVERY_MS = 30_000;
/** When the spare is asked for: half of the dev server's 10 minutes. */
export const SPARE_AFTER_MS = 5 * 60_000;

/** Calls `warm(spare)` now and every WARM_EVERY_MS; `spare` is 1 from SPARE_AFTER_MS on. now(): a top-up straight away. */
export function keepWarm(warm: (spare: 0 | 1) => void): { now(): void; stop(): void } {
  const since = Date.now();
  const now = () => warm(Date.now() - since >= SPARE_AFTER_MS ? 1 : 0);
  now();
  const every = setInterval(now, WARM_EVERY_MS);
  return { now, stop: () => clearInterval(every) };
}
