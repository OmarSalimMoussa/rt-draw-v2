#!/usr/bin/env bash
# Deploys this checkout's branch to the PGX's loop (evals/RUNBOOK.md) and returns at once: it pushes the branch to the
# PGX's bare repo (remote `pgx`), fast-forwards the PGX's checkout of it (init.json's `from`), and starts
# evals/ops/pgx-deploy.sh there in a unit of its own, which waits for the loop to finish its card, re-pins the harness,
# reinstalls the units and starts the loop again. A sleeping laptop never holds it up.
#   bash evals/ops/deploy.sh                 # then: ssh "$RT_PGX" journalctl --user -fu rt-deploy
# The machines are this laptop's, not the repo's: ~/.config/rt-eval/hosts.env sets RT_PGX (ssh target of the PGX).
set -euo pipefail

HOSTS=${RT_HOSTS:-$HOME/.config/rt-eval/hosts.env}
# shellcheck disable=SC1090
[ -f "$HOSTS" ] && . "$HOSTS"
PGX=${RT_PGX:?set RT_PGX in $HOSTS}
cd "$(dirname "$0")/../.."
branch=$(git rev-parse --abbrev-ref HEAD)
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "deploy: commit first (the PGX gets only what's pushed)" >&2; exit 1; }

echo "== push $branch → pgx"
git push -q pgx "$branch"
# shellcheck disable=SC2087
# Keepalives: a connection that drops after the PGX finished (Tailscale) ends here in 2 minutes, not never.
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=4 "$PGX" bash -s -- "$branch" <<'EOF'
set -euo pipefail
branch=$1
export RT_EVAL_HOME=${RT_EVAL_HOME:-$HOME/rt-eval}
from=$(sed -n 's/.*"from": *"\([^"]*\)".*/\1/p' "$RT_EVAL_HOME/init.json")
want=$(sed -n 's/.*"branch": *"\([^"]*\)".*/\1/p' "$RT_EVAL_HOME/init.json")
[ "$branch" = "$want" ] || { echo "deploy: the loop follows $want (init.json), not $branch" >&2; exit 1; }
echo "== $from: fast-forward to $branch"
git -C "$from" fetch -q origin "$branch" && git -C "$from" merge -q --ff-only FETCH_HEAD
[ -f "$RT_EVAL_HOME/rt-units.env" ] || { echo "deploy: no $RT_EVAL_HOME/rt-units.env: install the units once from the loop's clone (bash evals/ops/units.sh)" >&2; exit 1; }
systemctl --user is-active -q rt-deploy.service && { echo "deploy: one is still running: journalctl --user -fu rt-deploy" >&2; exit 1; }
systemctl --user reset-failed rt-deploy.service 2>/dev/null || true
systemd-run --user -q --unit rt-deploy -p EnvironmentFile="$RT_EVAL_HOME/rt-units.env" bash "$from/evals/ops/pgx-deploy.sh"
echo "deploy: started on the PGX: journalctl --user -fu rt-deploy (it waits for the loop's card first)"
EOF
