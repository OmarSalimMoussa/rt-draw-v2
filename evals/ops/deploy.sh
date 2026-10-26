#!/usr/bin/env bash
# Deploys this checkout's branch to the PGX loop (evals/RUNBOOK.md): pushes it to the PGX's bare repo (remote `pgx`),
# re-pins the loop clone's harness on it (init --refresh: fetch from the bare repo, fast-forward, tag eval-harness-<n>
# when new) and checks readiness at 0 calls (ready --stub --mock-api). Refused while the loop holds its lock: the
# harness is never changed under a running loop (rte stop-after first). The PGX's checkout of the branch, the loop
# clone's init.json `from` (node_modules, the dev token), is fast-forwarded too.
#   bash evals/ops/deploy.sh
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
ssh "$PGX" bash -s -- "$branch" <<'EOF'
set -euo pipefail
branch=$1
export PATH=$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH RT_EVAL_HOME=$HOME/rt-eval
[ -e "$RT_EVAL_HOME/lock" ] && { echo "deploy: the loop holds its lock ($(cat "$RT_EVAL_HOME/lock")): rte stop-after, then deploy" >&2; exit 1; }
from=$(node -e 'console.log(require(process.argv[1]).from)' "$RT_EVAL_HOME/init.json")
echo "== $from: fast-forward to $branch"
git -C "$from" fetch -q origin "$branch" && git -C "$from" merge -q --ff-only FETCH_HEAD
cd "$RT_EVAL_HOME/repo"
rte() { node --import ./evals/loop/node-hooks.mjs evals/loop/run.ts "$@"; }
echo "== loop clone: init --refresh"
rte init --refresh
echo "== ready --stub --mock-api"
rte ready --stub --mock-api
EOF
