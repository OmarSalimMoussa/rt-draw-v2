// Moving between the app's pages (the editor and the projects) without
// reloading the tab: navigate() asks Root to change the URL and swap the page
// behind a short load screen. Plain links to the app's own pages are caught the
// same way (Root.tsx). (v1's router.ts, without the preview.)

type Listener = (to: string) => void;
const listeners = new Set<Listener>();

/** Goes to another of the app's pages in this tab, without a reload. */
export function navigate(to: string) {
  listeners.forEach((fn) => fn(to));
}

export function onNavigate(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export type Route = "editor" | "projects";

export const routeOf = (path: string): Route => (path.startsWith("/projects") ? "projects" : "editor");
