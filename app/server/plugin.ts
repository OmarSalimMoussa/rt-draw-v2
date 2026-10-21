// Dev-server only: v1's projects routes (projects.ts) on the app's Vite server,
// beside v2's model and Scribe-token routes.
import type { Plugin } from "vite";
import { Router } from "./http.ts";
import { registerProjects } from "./projects.ts";

export function projectsApi(): Plugin {
  const router = new Router();
  registerProjects(router);
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
