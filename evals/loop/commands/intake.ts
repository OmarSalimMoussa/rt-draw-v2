// rte intake [--regold] (evals/real/README.md): one pass of intake while the loop isn't meant to run, from rt-intake.timer
// after its pull (evals/ops/units.sh). While the loop's unit runs (or restarts), the loop does intake itself between
// epochs, and this leaves it to it (--regold then waits for the loop's next intake). No cap: the budget's gate pauses each
// paid call, a token parked for its week has its week read again first, and a week spent ends the paid stages.
import { writeFileSync } from "node:fs";
import { StopAsked, WeekSpent, recheckWeeks } from "../ab.ts";
import { openHistory } from "../history.ts";
import { type Rte, msg } from "../rte.ts";
import { holder, lock, loopUnit } from "../state.ts";
import { intake } from "../../real/intake.ts";
import { regoldFile } from "../../real/real.ts";

export async function intakeCmd(rte: Rte) {
  const unit = loopUnit(), h = holder();
  if (unit === "active" || unit === "activating" || (h?.live && h.cmd === "loop")) {
    if (rte.o.f.regold) writeFileSync(regoldFile(), `${new Date().toISOString()}\n`);
    rte.say(`intake: the loop is running, and takes new sends between its epochs${rte.o.f.regold ? "; its next intake redraws gold" : ""}`);
    return 0;
  }
  let held: Awaited<ReturnType<typeof lock>>;
  try {
    held = await lock("intake");
  } catch (err) {
    rte.say(`intake: not now (${msg(err)}); the next pass tries again`);
    return 0;
  }
  try {
    openHistory();
    return await rte.withGateway(async (gw) => {
      await recheckWeeks(gw, (l) => rte.say(`intake: ${l}`));
      try {
        return (await intake(rte, gw, { regold: !!rte.o.f.regold })) ? 1 : 0;
      } catch (err) {
        if (!(err instanceof WeekSpent || err instanceof StopAsked)) throw err;
        rte.say("intake: every token is past its week: the paid stages wait for a pass after it frees");
        return 0;
      }
    });
  } finally {
    held.release();
  }
}
