#!/usr/bin/env bash
# Runs a run.ts command supervised (spec §7.7, fix F23), from the harness clone this file is in:
#   bash evals/loop/launch.sh <command> [flags…]     e.g. ladder --max 4, smoke --cap 40
#   bash evals/loop/launch.sh stop
# Laptop: a systemd user unit (its cgroup holds Chrome, Vite and Claude, so one stop takes them all) under the
# runs' CPU and memory limits, with the sleep inhibitor held around it from this terminal. PGX (aarch64): a
# window `loop` in the tmux session `rt`.
# Neither sees this shell's variables (a unit gets the user manager's env, a tmux window the tmux server's), so
# nothing goes through the env: run.ts reads the tokens file itself and takes the call cap only as --cap.
set -euo pipefail
cd "$(dirname "$0")/../.."
export RT_EVAL_HOME="${RT_EVAL_HOME:-$HOME/rt-eval}"
[ $# -gt 0 ] || { echo "usage: bash evals/loop/launch.sh <run.ts command> [flags…] | stop" >&2; exit 2; }
if grep -q 'emberhub-factory\.slice' /proc/self/cgroup; then
  echo "launch.sh: refusing inside emberhub-factory.slice (the factory's limits and neighbours would set the product's speed)" >&2
  exit 1
fi
# Whatever env the unit or the tmux server has, tokens and paid keys never ride along.
clean=("$(command -v env)" -u RT_EVAL_TOKEN_1 -u RT_EVAL_TOKEN_2 -u RT_EVAL_TOKEN_3 -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ELEVENLABS_API_KEY)
# The caller's Node (nvm's v22), not the v24 a unit would find, with the hooks every node entry needs.
run=("$(command -v node)" --import ./evals/loop/node-hooks.mjs evals/loop/run.ts "$@")

if [ "$(uname -m)" = aarch64 ]; then
  [ "$1" = stop ] && exec tmux send-keys -t rt:loop C-c
  # A new window inherits the tmux server's environment, not ours: hence -c, -e and the absolute node.
  exec tmux new-window -t rt -n loop -c "$PWD" -e "RT_EVAL_HOME=$RT_EVAL_HOME" -e RT_EVAL_LAUNCHED=1 "${clean[@]}" "${run[@]}"
fi

mkdir -p "$RT_EVAL_HOME"
[ "$1" = stop ] && exec systemctl --user stop "$(cat "$RT_EVAL_HOME/unit")"
unit="rt-eval-$(date +%s)-$$" # never collides, and --collect unloads even a failed one
echo "$unit" > "$RT_EVAL_HOME/unit"
# --wait keeps the inhibitor held for the unit's whole life (polkit lets only this session hold it, so it can't
# move into the unit); --same-dir and the absolute node fix the cwd and Node a unit would otherwise get ($HOME,
# /usr/local/bin/node). Closing this terminal drops only the inhibitor and the piped output (run.ts also logs to
# $RT_EVAL_HOME/logs/): the unit keeps running, and the heartbeat's suspend voids still apply.
exec systemd-inhibit --what=sleep:idle:handle-lid-switch --why='rt eval' \
  systemd-run --user --wait --collect --same-dir -P --unit "$unit" -p MemoryMax=10G -p CPUQuota=600% \
  --setenv=RT_EVAL_HOME="$RT_EVAL_HOME" --setenv=RT_EVAL_LAUNCHED=1 "${clean[@]}" "${run[@]}"
