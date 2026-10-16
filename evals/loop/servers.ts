// One Vite per arm (spec §7.2), each in its own process: /api/model streams through
// its proxy, so the runner's event loop (CDP traffic, screenshot decoding, hashing)
// must not sit between the gateway and the page. A server exits when its stdin
// closes, so a killed runner leaves none holding a port.
//   node evals/loop/servers.ts <tree> <port> <gateway>     (what serveArm starts)
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import { armConfig } from "./arm.vite.config.ts";
import { paths } from "./paths.ts";

/** An arm server takes ~0.4 s to listen; this long and it's broken. */
const READY_MS = 10_000;

export type ArmServer = { url: string; close(): Promise<void> };

/** Serves `tree` at http://127.0.0.1:<port> with /api/model proxied to `gateway`; resolves once it listens. Logs go to logs/arm-<port>.log. */
export async function serveArm(tree: string, port: number, gateway: string): Promise<ArmServer> {
  const p = paths();
  mkdirSync(p.logs, { recursive: true });
  const logFile = join(p.logs, `arm-${port}.log`);
  const log = openSync(logFile, "a");
  const child = spawn(process.execPath, [import.meta.filename, tree, String(port), gateway], { stdio: ["pipe", "pipe", log] });
  closeSync(log);
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  await new Promise<void>((ok, no) => {
    const timer = setTimeout(() => no(new Error(`arm server on ${port} not up in ${READY_MS} ms (${logFile})`)), READY_MS);
    child.stdout!.on("data", (d) => String(d).includes("ready") && (clearTimeout(timer), ok()));
    void exited.then(() => (clearTimeout(timer), no(new Error(`arm server on ${port} exited (${logFile})`))));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      child.kill();
      await exited;
    },
  };
}

if (import.meta.main) {
  const [tree, port, gateway] = process.argv.slice(2);
  const server = await createServer(armConfig(tree, gateway, Number(port)));
  await server.listen();
  process.stdin.on("end", () => process.exit(0)).resume();
  console.log("ready");
}
