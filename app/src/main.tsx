import { createRoot } from "react-dom/client";
import { ready } from "./projects/storage.ts";
import { Root } from "./Root.tsx";
import { installCursors } from "./sketch/cursors.ts";
import { installFavicon } from "./sketch/favicon.ts";
import "./styles.css";

installCursors();
installFavicon();
// Projects live on the server: the list, and this page's project, load before anything shows.
await ready().catch((err) => console.error("projects didn't load", err));
// v2 measures text in Excalifont: a board drawn before it loads would wrap differently later.
await document.fonts.load("20px Excalifont");

// The editor and the projects, switched in place without reloads (Root.tsx).
createRoot(document.getElementById("root")!).render(<Root />);
