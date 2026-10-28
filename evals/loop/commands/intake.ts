// rte intake (evals/real/README.md): one pass of intake while the loop isn't meant to run, from rt-intake.timer after
// its pull (evals/ops/units.sh). While the loop's unit runs (or restarts), the loop does intake itself between epochs,
// and this leaves it to it. No cap: the budget's gate pauses each paid call, and a week spent ends the pass.
import { WeekSpent } from "../ab.ts";
import { openHistory } from "../history.ts";
import { type Rte, msg } from "../rte.ts";
import { holder, lock, loopUnit } from "../state.ts";
import { intake } from "../../real/intake.ts";

export async function intakeCmd(rte: Rte) {
  const unit = loopUnit(), h = holder();
  if (unit === "active" || unit === "activating" || (h?.live && h.cmd === "loop")) {
    rte.say("intake: the loop is running, and takes new sends between its epochs");
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
      try {
        return (await intake(rte, gw, { regold: !!rte.o.f.regold })) ? 1 : 0;
      } catch (err) {
        if (!(err instanceof WeekSpent)) throw err;
        rte.say("intake: every token is past its week; the next pass after it frees goes on");
        return 0;
      }
    });
  } finally {
    held.release();
  }
}
