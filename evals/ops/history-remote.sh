#!/usr/bin/env bash
# Gives the eval's record (eval/history, evals/loop/history.ts) a private remote, so it isn't on one disk: a private
# GitHub repo the PGX pushes to with a deploy key of its own. From then on every history commit the loop makes is
# pushed (commitHistory: the branch's remote). Run once from the laptop, with gh signed in; run again, it changes nothing.
#   bash evals/ops/history-remote.sh <owner>/<repo>
# ~/.config/rt-eval/hosts.env sets RT_PGX, as for deploy.sh.
set -euo pipefail
repo=${1:?usage: bash evals/ops/history-remote.sh <owner>/<private repo>}
HOSTS=${RT_HOSTS:-$HOME/.config/rt-eval/hosts.env}
# shellcheck disable=SC1090
[ -f "$HOSTS" ] && . "$HOSTS"
PGX=${RT_PGX:?set RT_PGX in $HOSTS}

echo "== the private repo"
gh repo view "$repo" >/dev/null 2>&1 || gh repo create "$repo" --private --description "imagine's eval loop: its record (the eval/history branch)" >/dev/null
[ "$(gh repo view "$repo" --json visibility -q .visibility)" = PRIVATE ] || { echo "history-remote: $repo isn't private" >&2; exit 1; }

echo "== the PGX's key, allowed to push there"
# shellcheck disable=SC2016
pub=$(ssh "$PGX" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && { [ -f ~/.ssh/rt-history ] || ssh-keygen -q -t ed25519 -N "" -C "rt-eval history from $(hostname)" -f ~/.ssh/rt-history; } && cat ~/.ssh/rt-history.pub')
key=$(awk '{print $2}' <<<"$pub")
gh api "repos/$repo/keys" -q '.[].key' | grep -qF "$key" || gh repo deploy-key add <(printf '%s\n' "$pub") -R "$repo" --allow-write --title "PGX: eval history" >/dev/null

echo "== the PGX: ssh host github-history, with GitHub's host key as this laptop knows it"
known=$(ssh-keygen -F github.com | grep -v '^#' || true)
[ -n "$known" ] || { echo "history-remote: this laptop has no host key for github.com: ssh -T git@github.com once first" >&2; exit 1; }
# shellcheck disable=SC2029
printf '%s\n' "$known" |
  ssh "$PGX" "touch ~/.ssh/config ~/.ssh/known_hosts && chmod 600 ~/.ssh/config && { grep -q '^Host github-history\$' ~/.ssh/config || printf '\nHost github-history\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/rt-history\n  IdentitiesOnly yes\n' >> ~/.ssh/config; } && if ssh-keygen -F github.com >/dev/null; then cat >/dev/null; else cat >> ~/.ssh/known_hosts; fi"

echo "== the loop's clone: the remote, and the first push"
ssh "$PGX" bash -s -- "$repo" <<'EOF'
set -euo pipefail
clone=${RT_EVAL_HOME:-$HOME/rt-eval}/repo
url=git@github-history:$1.git
git -C "$clone" remote set-url history "$url" 2>/dev/null || git -C "$clone" remote add history "$url"
git -C "$clone" config branch.eval/history.remote history
git -C "$clone" push -q history eval/history:eval/history
EOF
echo "history-remote: eval/history is on $repo; the loop pushes each commit to it"
