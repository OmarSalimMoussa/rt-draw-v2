// Starts the hosted app (the Dockerfile): the page built into app/dist and the API, on PORT (8200).
import { resolve } from "node:path";
import { host } from "./host.ts";

const port = Number(process.env.PORT || 8200);
const server = host(resolve(import.meta.dirname, "../dist"), resolve(import.meta.dirname, "../.."));
server.listen(port, () => console.log(`rt-draw on :${port}`));
// docker stop: go at once (the subscription's waiting processes go with the container).
process.on("SIGTERM", () => process.exit(0));
