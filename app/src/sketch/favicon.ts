// The tab's icon: the logo (logo.ts), boiling. Browsers don't play animated SVG
// favicons, so this swaps between the logo's drawings itself, 0.15s each (in
// background tabs browsers slow that to about once a second). Still for anyone
// who asks for reduced motion.
import { LOGO_FRAMES, logoSvg } from "./logo.ts";

export function installFavicon() {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  link.type = "image/svg+xml";
  const frames = Array.from({ length: LOGO_FRAMES }, (_, f) => `data:image/svg+xml,${encodeURIComponent(logoSvg(f))}`);
  link.href = frames[0];
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let f = 0;
  setInterval(() => {
    f = (f + 1) % frames.length;
    link.href = frames[f];
  }, 150);
}
