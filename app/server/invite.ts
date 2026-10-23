// An invite link, printed: node app/server/invite.ts <email> [--admin]. How the first admin gets in
// (on the box: docker exec rtdraw-app node app/server/invite.ts omar@emberhub.dev --admin), and a way to
// invite anyone from a shell. The running server reads the change back (access.ts).
import { resolve } from "node:path";
import { Access } from "./access.ts";

const [email, flag] = process.argv.slice(2);
if (!email || (flag && flag !== "--admin")) {
  console.error("usage: node app/server/invite.ts <email> [--admin]");
  process.exit(2);
}
const access = new Access(process.env.RT_DATA_DIR || resolve(import.meta.dirname, "../../.data"));
const { link } = await access.invite(email, { admin: flag === "--admin", base: process.env.PUBLIC_URL || "https://imagine.emberhub.dev" });
console.log(link);
