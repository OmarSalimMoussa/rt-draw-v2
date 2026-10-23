import { createRoot } from "react-dom/client";
import { Admin } from "./access/Admin.tsx";
import { whoAmI } from "./access/api.ts";
import { Join } from "./access/Join.tsx";
import { Welcome } from "./access/Welcome.tsx";
import { ready } from "./projects/storage.ts";
import { Root } from "./Root.tsx";
import { installCursors } from "./sketch/cursors.ts";
import { installFavicon } from "./sketch/favicon.ts";
import "./styles.css";

installCursors();
installFavicon();
// On the hosted app only people with an invite get in (app/server/access.ts); the dev server has no invites.
const me = await whoAmI().catch(() => undefined);
// v2 measures text in Excalifont: a board drawn before it loads would wrap differently later.
await document.fonts.load("20px Excalifont");
const root = createRoot(document.getElementById("root")!);
const invited = /^\/join\/([A-Za-z0-9_-]+)$/.exec(location.pathname)?.[1];

if (me === null) {
  // Not signed in: an invite link asks for its email; anything else is the welcome page and the waitlist.
  root.render(invited ? <Join token={invited} /> : <Welcome />);
} else if (location.pathname.startsWith("/admin")) {
  root.render(<Admin me={me} />);
} else {
  // Signed in already: an invite link opens the app.
  if (invited) history.replaceState(null, "", "/");
  // Projects live on the server: the list, and this page's project, load before anything shows.
  await ready().catch((err) => console.error("projects didn't load", err));
  // The editor and the projects, switched in place without reloads (Root.tsx).
  root.render(<Root />);
}
