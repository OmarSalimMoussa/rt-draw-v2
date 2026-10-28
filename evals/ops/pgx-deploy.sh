#!/usr/bin/env bash
# The PGX's side of evals/ops/deploy.sh, run there in the unit rt-deploy (journalctl --user -u rt-deploy): stops the loop
# after its card (rte stop-after) and waits for it, re-pins the loop clone's harness (init --refresh: fast-forward,
# tag eval-harness-<n>), reinstalls the units and restarts Eval HQ, and starts the loop again if it was running (its unit
# checks readiness at 0 calls first; a stopped loop gets the check here). The harness never changes under a running loop.
set -euo pipefail
export RT_EVAL_HOME=${RT_EVAL_HOME:-$HOME/rt-eval}
cd "$RT_EVAL_HOME/repo"
was=$(systemctl --user is-active rt-loop.service || true)
case "$was" in
  active)
    echo "deploy: the loop stops after its card"
    bin/rte stop-after
    while systemctl --user is-active -q rt-loop.service; do sleep 30; done ;;
  # Still in its readiness check: nothing in flight to finish.
  activating) systemctl --user stop rt-loop.service ;;
esac
bin/rte init --refresh
bash evals/ops/units.sh
systemctl --user restart rt-pages.service 2>/dev/null || true
# The loop's unit checks readiness before it starts; a stopped loop gets the check here.
if [ "$was" = active ] || [ "$was" = activating ]; then
  bin/rte run
else
  bin/rte ready --stub --mock-api
  echo "deploy: done; the loop wasn't running, so it stays stopped (bin/rte run starts it)"
fi
