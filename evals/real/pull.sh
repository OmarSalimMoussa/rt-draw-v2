#!/usr/bin/env bash
# Testers' work into the PGX for intake (evals/real/README.md), as snapshots in $RT_EVAL_HOME/real/raw/<source>/<stamp>/,
# the newest named in raw/<source>/latest:
#   bash evals/real/pull.sh live            # on the PGX, before each intake (rt-intake.service): the hosted app's /data
#   bash evals/real/pull.sh local           # on the laptop (its rt-pull-local.timer): its dev server's .data, to the PGX
#   bash evals/real/pull.sh receive <src>   # on the PGX: one snapshot as a tar on stdin (what the two above end in)
# live reaches the box as the ssh host RTDRAW_BOX (default rt-box), whose key on the box may only run the export: people,
# feedback, projects, the send log and model calls, never claude-config/ (evals/ops/box-key.sh sets it up). local reads
# the main checkout's .data and sends it to RT_PGX (~/.config/rt-eval/hosts.env). A snapshot the same as the last is
# dropped, and each source keeps its newest 8: ingest keeps every session it has seen, so nothing is lost with them.
set -euo pipefail
KEEP=8

case "${1:-}" in
  live)
    # The key's forced command on the box decides what's sent; the command asked for here is ignored there.
    ssh -o BatchMode=yes -o ConnectTimeout=20 "${RTDRAW_BOX:-rt-box}" export | bash "$0" receive live
    ;;
  local)
    HOSTS=${RT_HOSTS:-$HOME/.config/rt-eval/hosts.env}
    # shellcheck disable=SC1090
    [ -f "$HOSTS" ] && . "$HOSTS"
    PGX=${RT_PGX:?set RT_PGX in $HOSTS}
    # The dev server's data is in the main checkout, also when this runs from a worktree.
    LOCAL=${RT_LOCAL_DATA:-$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)")/.data}
    [ -d "$LOCAL/app" ] || { echo "pull local: no dev-server data at $LOCAL" >&2; exit 0; }
    files=(app)
    [ -f "$LOCAL/model-calls.jsonl" ] && files+=(model-calls.jsonl)
    # shellcheck disable=SC2029
    tar -C "$LOCAL" -cf - "${files[@]}" | ssh -o BatchMode=yes -o ConnectTimeout=20 "$PGX" 'bash "${RT_EVAL_HOME:-$HOME/rt-eval}/repo/evals/real/pull.sh" receive local'
    ;;
  receive)
    src=${2:?receive live or local}
    case "$src" in live | local) ;; *) echo "pull: no source $src" >&2; exit 1 ;; esac
    dir=${RT_EVAL_HOME:-$HOME/rt-eval}/real/raw/$src
    # Testers' data: nobody else on the machine reads it.
    umask 077
    mkdir -p "$dir"
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    tmp=$dir/.$stamp
    trap 'rm -rf "$tmp"' EXIT
    mkdir "$tmp"
    tar -C "$tmp" -xf -
    [ -n "$(ls -A "$tmp")" ] || { echo "pull $src: nothing came" >&2; exit 1; }
    sum=$(cd "$tmp" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64)
    date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/pulled"
    last=$(cat "$dir/latest" 2>/dev/null || true)
    if [ -n "$last" ] && [ "$(cat "$dir/$last.sum" 2>/dev/null)" = "$sum" ]; then
      echo "pull $src: the same as $last"
      exit 0
    fi
    # -T: a second pull in the same second fails here rather than land inside the first.
    mv -T "$tmp" "$dir/$stamp"
    echo "$sum" > "$dir/$stamp.sum"
    # Renamed over, so intake reads the old name or the new one, never half of one.
    echo "$stamp" > "$dir/latest.tmp" && mv "$dir/latest.tmp" "$dir/latest"
    find "$dir" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort | head -n -"$KEEP" | while read -r old; do rm -rf "$old" "$old.sum"; done
    echo "pull $src: $stamp, $(du -sh "$dir/$stamp" | cut -f1)"
    ;;
  *)
    echo "usage: pull.sh live | local | receive <live|local>" >&2
    exit 1
    ;;
esac
