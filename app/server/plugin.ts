// v1's projects routes (projects.ts) as a Vite plugin: on the app's dev server beside v2's model and
// Scribe-token routes, and on the hosted app (host.ts), where `owner` is the person signed in.
import type { Plugin } from "vite";
import { Router } from "./http.ts";
import { type OwnerOf, registerProjects } from "./projects.ts";

export function projectsApi(o: { owner?: OwnerOf } = {}): Plugin {
  const router = new Router();
  registerProjects(router, o.owner);
  return {
    name: "projects-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/project")) return next();
        try {
          if (!(await router.handle(req, res))) next();
        } catch (err) {
          next(err);
        }
      });
    },
  };
}
