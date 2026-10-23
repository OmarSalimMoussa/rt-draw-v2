// Starts the hosted app (the Dockerfile): the page built into app/dist and the API, on PORT (8200), open
// only to people with an invite (access.ts). PUBLIC_URL is the site's address for invite links; mail goes
// through the Apps Script at MAILER_URL once it's set up (mailer.ts, deploy/mailer.gs).
import { resolve } from "node:path";
import { modelApi } from "../../dev/model-plugin.ts";
import { sttToken } from "../../playgrounds/speech/token-plugin.ts";
import { Access, ownerFrom } from "./access.ts";
import { host } from "./host.ts";
import { appsScript } from "./mailer.ts";
import { projectsApi } from "./plugin.ts";

const repo = resolve(import.meta.dirname, "../..");
const { PORT, RT_DATA_DIR, PUBLIC_URL, MAILER_URL, MAILER_SECRET } = process.env;
const access = new Access(RT_DATA_DIR || resolve(repo, ".data"), {
  publicUrl: PUBLIC_URL,
  mailer: MAILER_URL && MAILER_SECRET ? appsScript(MAILER_URL, MAILER_SECRET) : undefined,
});
const port = Number(PORT || 8200);
const server = host(resolve(import.meta.dirname, "../dist"), repo, [modelApi(), sttToken(), projectsApi({ owner: ownerFrom })], access);
server.listen(port, () => console.log(`imagine on :${port}${MAILER_URL ? "" : " (mail not set up: invites are links to copy)"}`));
// docker stop: go at once (the subscription's waiting processes go with the container).
process.on("SIGTERM", () => process.exit(0));
