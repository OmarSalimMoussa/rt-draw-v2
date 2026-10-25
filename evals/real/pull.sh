#!/usr/bin/env bash
# Pulls testers' work into the PGX for the real-use loop (evals/real/README.md): the hosted app's people,
# feedback, projects, send log and model calls, and this laptop's own dev-server data, each as a snapshot in
# $RT_EVAL_HOME/real/raw/<stamp>/{live,local}/ on the PGX. It runs on the laptop, the one machine that reaches
# both: the box's data streams through it to the PGX and is never written here. The box's Claude sign-in
# (claude-config/) is never copied.
#   bash evals/real/pull.sh            # both
#   bash evals/real/pull.sh --live     # the box only
set -euo pipefail

BOX=${RTDRAW_BOX:-deploy@31.220.50.146}
PGX=${RT_PGX:-omar-salim-moussa@thinkstationpgx-0eea}
# The dev server's data is in the main checkout, also when this runs from a worktree.
LOCAL=${RT_LOCAL_DATA:-$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)")/.data}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="rt-eval/real/raw/$STAMP"

want_local=1
[ "${1:-}" = "--live" ] && want_local=0

echo "== live: $BOX → $PGX:$DEST/live"
ssh "$BOX" 'docker exec rtdraw-app sh -c "cd /data && tar -cf - access app model-calls.jsonl"' |
  ssh "$PGX" "umask 077 && mkdir -p ~/$DEST/live && tar -C ~/$DEST/live -xf - && du -sh ~/$DEST/live | cut -f1"

if [ "$want_local" = 1 ] && [ -d "$LOCAL/app" ]; then
  echo "== local: $LOCAL → $PGX:$DEST/local"
  tar -C "$LOCAL" -cf - app $( [ -f "$LOCAL/model-calls.jsonl" ] && echo model-calls.jsonl ) |
    ssh "$PGX" "umask 077 && mkdir -p ~/$DEST/local && tar -C ~/$DEST/local -xf - && du -sh ~/$DEST/local | cut -f1"
fi
ssh "$PGX" "chmod -R go-rwx ~/rt-eval/real && echo $STAMP > ~/rt-eval/real/raw/latest"
echo "pulled: $STAMP"
