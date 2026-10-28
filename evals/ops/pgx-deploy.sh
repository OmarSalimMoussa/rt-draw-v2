#!/usr/bin/env bash
# The PGX's side of evals/ops/deploy.sh, run there in the unit rt-deploy (journalctl --user -u rt-deploy): stops the loop
# after its card (rte stop-after) and waits for it, stops an intake pass (what it paid for is cached; the next pass goes
# on), re-pins the loop clone's harness (init --refresh: fast-forward, tag eval-harness-<n>), reinstalls the units and
# restarts Eval HQ, and starts the loop again if it was running (its unit checks readiness at 0 calls first; a stopped
# loop gets the check here). The harness never changes under a running loop or intake.
# t25 rehearses it on units of its own: RT_UNIT_PREFIX (default rt, as the units' env file sets it) and RT_RTE.
set -euo pipefail
export RT_EVAL_HOME=${RT_EVAL_HOME:-$HOME/rt-eval}
cd "$RT_EVAL_HOME/repo"
prefix=${RT_UNIT_PREFIX:-rt}
rte=${RT_RTE:-bin/rte}
was=$(systemctl --user is-active "$prefix-loop.service" || true)
case "$was" in
  active)
    echo "deploy: the loop stops after its card"
    "$rte" stop-after
    # Until it's down for good: a crash restart (activating) or its way out (deactivating) is not yet stopped.
    until [[ $(systemctl --user is-active "$prefix-loop.service" || true) =~ ^(inactive|failed)$ ]]; do sleep 5; done ;;
  # Still in its readiness check: nothing in flight to finish.
  activating) systemctl --user stop "$prefix-loop.service" ;;
esac
systemctl --user stop "$prefix-intake.service" 2>/dev/null || true
"$rte" init --refresh
bash evals/ops/units.sh
systemctl --user restart "$prefix-pages.service" 2>/dev/null || true
# The loop's unit checks readiness before it starts; a stopped loop gets the check here.
if [ "$was" = active ] || [ "$was" = activating ]; then
  "$rte" run
else
  "$rte" ready --stub --mock-api
  echo "deploy: done; the loop wasn't running, so it stays stopped (bin/rte run starts it)"
fi
