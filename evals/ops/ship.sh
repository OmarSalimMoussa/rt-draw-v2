#!/usr/bin/env bash
# Ships the loop's champion to imagine (evals/RUNBOOK.md), the owner's own command and never a tool. In a clean worktree
# of master it merges loop/champion from the PGX, runs the product's checks, and serves the app for you to try. On your
# yes it pushes master (origin and the PGX's repo), deploys it to the box (scripts/deploy.sh) and records the ship in
# the eval's history (rte shipped), so Eval HQ shows what's on prod. Nothing of yours is touched: your checkout, its
# .data and its dev server stay as they are (the try runs on port 5190 with a data dir of its own).
#   bash evals/ops/ship.sh
# The machines are this laptop's, not the repo's: ~/.config/rt-eval/hosts.env sets RT_PGX, as for deploy.sh, and
# RT_PGX_EVAL_HOME when the loop's home there isn't ~/rt-eval.
set -euo pipefail

HOSTS=${RT_HOSTS:-$HOME/.config/rt-eval/hosts.env}
# shellcheck disable=SC1090
[ -f "$HOSTS" ] && . "$HOSTS"
PGX=${RT_PGX:?set RT_PGX in $HOSTS}
PGX_HOME=${RT_PGX_EVAL_HOME:-rt-eval}
TRY_PORT=${RT_TRY_PORT:-5190}
cd "$(dirname "$0")/../.."
root=$(pwd)

git fetch -q origin master
wt=$(mktemp -d "${TMPDIR:-/tmp}/rt-ship-XXXXXX")
data=$(mktemp -d "${TMPDIR:-/tmp}/rt-ship-data-XXXXXX")
server=
cleanup() {
  [ -n "$server" ] && kill "$server" 2>/dev/null || true
  git -C "$root" worktree remove --force "$wt" 2>/dev/null || true
  rm -rf "$data"
}
trap cleanup EXIT
git worktree add -q --detach "$wt" origin/master
cd "$wt"

echo "== the champion, from the PGX"
git fetch -q "$PGX:$PGX_HOME/repo" loop/champion
champ=$(git rev-parse FETCH_HEAD)
if git merge-base --is-ancestor "$champ" HEAD; then
  echo "ship: master already has the champion ${champ:0:12}"
  exit 0
fi
git log --oneline --no-merges "HEAD..$champ"
git merge -q --no-edit -m "Ship the eval loop's champion ${champ:0:12}" "$champ" ||
  { git merge --abort; echo "ship: the champion conflicts with master; the loop's rte sync merges master in first (it runs between epochs)" >&2; exit 1; }

echo "== the product's checks"
# Your checkout's node_modules, hard-linked, when the lockfiles agree (seconds); else a clean install.
for d in . app; do
  if cmp -s "$root/$d/package-lock.json" "$d/package-lock.json" && [ -d "$root/$d/node_modules" ]; then cp -al "$root/$d/node_modules" "$d/node_modules"; else npm ci --prefix "$d" --no-audit --no-fund; fi
done
npm run -s typecheck
npm run -s typecheck --prefix app
npm test -s --prefix app

echo "== try it"
# Your .env for the model calls (linked, never copied or read here), and a data dir of its own.
[ -f "$root/.env" ] && ln -s "$root/.env" .env
RT_DATA_DIR=$data ./node_modules/.bin/vite --config app/vite.config.ts --port "$TRY_PORT" --strictPort --clearScreen false >"$data/vite.log" 2>&1 &
server=$!
echo "the merged app is at http://localhost:$TRY_PORT/ (its own data; your dev server is untouched)"
read -r -p "Ship it to prod? [y/N] " yes
kill "$server" 2>/dev/null || true
server=
rm -f .env
[ "$yes" = y ] || [ "$yes" = Y ] || { echo "ship: not shipped"; exit 0; }

echo "== master"
sha=$(git rev-parse HEAD)
git push -q origin HEAD:master
git -C "$root" remote get-url pgx >/dev/null 2>&1 && git push -q pgx HEAD:master
echo "== prod"
[ -z "$(git status --porcelain)" ] || { echo "ship: the worktree isn't clean, so the image would be tagged dirty" >&2; git status --short >&2; exit 1; }
bash scripts/deploy.sh
tag=v2-$(git rev-parse --short=12 HEAD)
url=https://$(sed -n 's/^HOST=//p' scripts/deploy.sh)

echo "== the record"
# The PGX's checkout and the loop's clone see master as shipped (so the champion's keeps count from it), and history
# gets the ship.
ssh -o BatchMode=yes "$PGX" bash -s -- "$sha" "$tag" "$url" "$PGX_HOME" <<'EOF'
set -euo pipefail
set -a; . "$HOME/$4/rt-units.env"; set +a
from=$(sed -n 's/.*"from": *"\([^"]*\)".*/\1/p' "$RT_EVAL_HOME/init.json")
git -C "$from" fetch -q origin master && git -C "$from" merge -q --ff-only FETCH_HEAD
git -C "$RT_EVAL_HOME/repo" fetch -q origin master
"$RT_EVAL_HOME/repo/bin/rte" shipped --sha "$1" --tag "$2" --url "$3"
EOF
echo "ship: $tag is on prod"
