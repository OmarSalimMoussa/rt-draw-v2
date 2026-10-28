#!/usr/bin/env bash
# Lets the PGX pull testers' work from the hosted app's box by itself (evals/real/pull.sh live), run once from the laptop,
# the one machine that reaches both. On the PGX: an ssh key of its own (~/.ssh/rt-box, no passphrase) and the ssh host
# rt-box. On the box: that key in the deploy user's authorized_keys, able to run only the export (a forced command, with
# no shell, terminal or forwarding). Run again, it changes nothing.
#   bash evals/ops/box-key.sh
# ~/.config/rt-eval/hosts.env sets RTDRAW_BOX (the box's ssh target, user@host) and RT_PGX, and may set RTDRAW_CONTAINER.
set -euo pipefail
HOSTS=${RT_HOSTS:-$HOME/.config/rt-eval/hosts.env}
# shellcheck disable=SC1090
[ -f "$HOSTS" ] && . "$HOSTS"
BOX=${RTDRAW_BOX:?set RTDRAW_BOX in $HOSTS}
PGX=${RT_PGX:?set RT_PGX in $HOSTS}
CONTAINER=${RTDRAW_CONTAINER:-rtdraw-app}
EXPORT="docker exec $CONTAINER sh -c 'cd /data && tar -cf - access app model-calls.jsonl'"

echo "== the PGX's key"
# shellcheck disable=SC2029
pub=$(ssh "$PGX" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && { [ -f ~/.ssh/rt-box ] || ssh-keygen -q -t ed25519 -N "" -C "rt-eval pull from $(hostname)" -f ~/.ssh/rt-box; } && cat ~/.ssh/rt-box.pub')
key=$(awk '{print $2}' <<<"$pub")

echo "== the box: the key may run the export only"
# The line over stdin: the forced command's quotes never pass through a remote shell.
# shellcheck disable=SC2029
printf 'restrict,command="%s" %s\n' "$EXPORT" "$pub" |
  ssh "$BOX" "umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && if grep -qF '$key' ~/.ssh/authorized_keys; then cat >/dev/null; else cat >> ~/.ssh/authorized_keys; fi"

echo "== the PGX: ssh host rt-box, with the box's host key as this laptop knows it"
host=${BOX#*@}
user=${BOX%@*}
known=$(ssh-keygen -F "$host" | grep -v '^#' || true)
[ -n "$known" ] || { echo "box-key: this laptop has no host key for $host: ssh $BOX once first" >&2; exit 1; }
# shellcheck disable=SC2029
printf '%s\n' "$known" |
  ssh "$PGX" "touch ~/.ssh/config ~/.ssh/known_hosts && chmod 600 ~/.ssh/config && { grep -q '^Host rt-box\$' ~/.ssh/config || printf '\nHost rt-box\n  HostName %s\n  User %s\n  IdentityFile ~/.ssh/rt-box\n  IdentitiesOnly yes\n' '$host' '$user' >> ~/.ssh/config; } && if ssh-keygen -F '$host' >/dev/null; then cat >/dev/null; else cat >> ~/.ssh/known_hosts; fi"

echo "== a pull from the PGX"
# shellcheck disable=SC2016
ssh "$PGX" 'ssh -o BatchMode=yes rt-box export | tar -tf - | head -3'
echo "box-key: the PGX pulls by itself now (bash evals/real/pull.sh live, before each intake)"
