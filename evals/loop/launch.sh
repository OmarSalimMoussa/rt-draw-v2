#!/usr/bin/env bash
# Runs a run.ts command as its own systemd user unit (spec §7.7, fix F23), from the harness clone this file is in:
#   bash evals/loop/launch.sh <command> [flags…]     e.g. ladder --max 4, calib --check --cap 150   (bin/rte job …)
#   bash evals/loop/launch.sh stop                   stops the last one
# The unit's cgroup holds Chrome, Vite and Claude, so one stop takes them all, at a low CPU weight and with no memory
# limit, as the loop's and intake's units have none: a cap of 10 GB OOM-killed intake's replay warm-up (16 slots × 2
# arms, 240 Claude processes) on the PGX's 119 GB. On a machine with a battery (the laptop) this terminal holds the sleep inhibitor around it and waits for
# it; on one without (the PGX, always on) the unit starts detached and its output is in the journal.
# The loop itself isn't launched here: on the PGX its own unit runs it (evals/ops/units.sh).
# CPU is a weight (it yields to the owner's work), never a quota: under CPUQuota=600% a burst of Claude starts got
# the whole unit throttled, and the gateway's event loop stalled 50-60 ms.
# A unit gets the user manager's env, never this shell's variables: run.ts reads the tokens file itself and takes the
# call cap only as --cap.
set -euo pipefail
cd "$(dirname "$0")/../.."
export RT_EVAL_HOME="${RT_EVAL_HOME:-$HOME/rt-eval}"
[ $# -gt 0 ] || { echo "usage: bash evals/loop/launch.sh <run.ts command> [flags…] | stop" >&2; exit 2; }
if grep -q 'emberhub-factory\.slice' /proc/self/cgroup; then
  echo "launch.sh: refusing inside emberhub-factory.slice (the factory's limits and neighbours would set the product's speed)" >&2
  exit 1
fi
# Whatever env the unit has, tokens and paid keys never ride along.
clean=("$(command -v env)" -u RT_EVAL_TOKEN_1 -u RT_EVAL_TOKEN_2 -u RT_EVAL_TOKEN_3 -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ELEVENLABS_API_KEY -u TYPESAFE_API_KEY)
# The caller's Node, not the one a unit would find, with the hooks every node entry needs.
run=("$(command -v node)" --import ./evals/loop/node-hooks.mjs evals/loop/run.ts "$@")

mkdir -p "$RT_EVAL_HOME"
if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "launch.sh: no systemd user manager from this shell (XDG_RUNTIME_DIR or the user bus missing)." >&2
  echo "  Run it from a desktop terminal, or run the step bare from here (no unit limits; keep the machine awake):" >&2
  echo "  RT_EVAL_HOME=$RT_EVAL_HOME node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts $*" >&2
  exit 1
fi
[ "$1" = stop ] && exec systemctl --user stop "$(cat "$RT_EVAL_HOME/unit")"
unit="rt-eval-$(date +%s)-$$" # never collides, and --collect unloads even a failed one
echo "$unit" > "$RT_EVAL_HOME/unit"
props=(--collect --same-dir --unit "$unit" -p CPUWeight=50 --setenv=RT_EVAL_HOME="$RT_EVAL_HOME" --setenv=RT_EVAL_LAUNCHED=1)

# A machine with no battery is always on: the unit runs detached, and a closed ssh doesn't end it.
if ! compgen -G "${RT_POWER_SUPPLY:-/sys/class/power_supply}/BAT*" >/dev/null; then
  systemd-run --user -q "${props[@]}" "${clean[@]}" "${run[@]}"
  echo "launch.sh: $* runs in the unit $unit: journalctl --user -fu $unit (also $RT_EVAL_HOME/logs/run-$(date -u +%F).log)"
  exit 0
fi
# With a battery, the sleep inhibitor is held for the unit's whole life (polkit lets only this session hold it, so it
# can't move into the unit): without it from this shell (ssh, cron), say so instead of systemd's "Failed to connect".
if ! systemd-inhibit --what=sleep --why='rt eval probe' true 2>/dev/null; then
  echo "launch.sh: this machine has a battery and this shell can't hold the sleep inhibitor (polkit refused): run it from a desktop terminal, on AC." >&2
  exit 1
fi
# Closing this terminal drops only the inhibitor and the piped output (run.ts also logs to $RT_EVAL_HOME/logs/): the
# unit keeps running, and the heartbeat's suspend voids still apply.
exec systemd-inhibit --what=sleep:idle:handle-lid-switch --why='rt eval' \
  systemd-run --user --wait -P "${props[@]}" "${clean[@]}" "${run[@]}"
