#!/usr/bin/env bash
# Installs the eval's systemd user units on the machine that runs the loop (the PGX), from the loop's clone:
#   bash evals/ops/units.sh            # writes and enables them, and turns on lingering so they outlive logouts and reboots
# rt-loop.service    readiness at 0 calls, then `rte loop --resume`. Restarted after a crash, at most 3 times in 6 hours;
#                    then rt-loop-failed.service records it and mails the owner (rte unit-failed). A stop the owner asked
#                    for (rte stop-after) or one that is theirs to judge exits cleanly and stays stopped across a reboot
#                    (rte wanted) until `rte run`.
# rt-pages.service   Eval HQ (evals/pages.vite.config.ts) on this machine's Tailscale address, port 5181, always restarted.
# rt-intake.timer    every 30 minutes, a pull of the hosted app's data (evals/real/pull.sh live), then `rte intake`
#                    (evals/real/README.md): while the loop's unit isn't running, new sends become cards; while it is, the
#                    loop does that between its epochs.
# Each unit runs with the PATH this shell has (node, claude, pnpm), kept in $RT_EVAL_HOME/rt-units.env, and never with
# this shell's other variables.
# Checks install a set of their own: RT_UNIT_PREFIX (default rt), RT_UNIT_DIR, RT_RTE (the rte to run), RT_RESTART_SEC.
set -euo pipefail
cd "$(dirname "$0")/../.."
home=${RT_EVAL_HOME:-$HOME/rt-eval}
repo=$(pwd)
prefix=${RT_UNIT_PREFIX:-rt}
dir=${RT_UNIT_DIR:-$HOME/.config/systemd/user}
rte=${RT_RTE:-$repo/bin/rte}
restart=${RT_RESTART_SEC:-60}
host=${RT_PAGES_HOST:-$(tailscale ip -4 2>/dev/null | head -1 || true)}
for tool in node claude; do command -v "$tool" >/dev/null || { echo "units.sh: no $tool on this shell's PATH: the units run with this PATH" >&2; exit 1; }; done
dirs=()
for tool in node claude npm pnpm git tailscale; do p=$(command -v "$tool" || true); [ -n "$p" ] && dirs+=("$(dirname "$p")"); done
path=$(printf '%s\n' "${dirs[@]}" /usr/local/bin /usr/bin /bin | awk '!seen[$0]++' | paste -sd:)
mkdir -p "$dir"

# The units' environment, also what evals/ops/deploy.sh starts pgx-deploy.sh with (a plain ssh has no node on its PATH).
envfile=$home/$prefix-units.env
# Testers' data lives under it (real/): nobody else on the machine reads it.
mkdir -p "$home" && chmod 700 "$home"
printf 'RT_EVAL_HOME=%s\nRT_UNIT_PREFIX=%s\nPATH=%s\n' "$home" "$prefix" "$path" > "$envfile"
env_lines="EnvironmentFile=$envfile"

cat > "$dir/$prefix-loop.service" <<EOF
[Unit]
Description=imagine's eval loop (evals/RUNBOOK.md)
StartLimitIntervalSec=6h
StartLimitBurst=3
OnFailure=$prefix-loop-failed.service

[Service]
WorkingDirectory=$repo
$env_lines
ExecCondition=$rte wanted
ExecStartPre=$rte ready --stub --mock-api
ExecStart=$rte loop --resume
Restart=on-failure
# Straight back to starting, never through "failed": OnFailure= then fires only once the restarts run out.
RestartMode=direct
RestartSec=$restart
TimeoutStartSec=30min
KillMode=control-group

[Install]
WantedBy=default.target
EOF

cat > "$dir/$prefix-loop-failed.service" <<EOF
[Unit]
Description=Tell the owner the eval loop's unit gave up

[Service]
Type=oneshot
WorkingDirectory=$repo
$env_lines
ExecStart=$rte unit-failed
EOF

cat > "$dir/$prefix-intake.service" <<EOF
[Unit]
Description=imagine's eval intake: new sends pulled and proposed (evals/real/README.md)

[Service]
Type=oneshot
WorkingDirectory=$repo
$env_lines
# A pull that fails (the box down) leaves the last snapshot, which intake still takes.
ExecStartPre=-/bin/bash $repo/evals/real/pull.sh live
ExecStart=$rte intake
EOF

cat > "$dir/$prefix-intake.timer" <<EOF
[Unit]
Description=imagine's eval intake, every 30 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF

if [ -n "$host" ]; then
  cat > "$dir/$prefix-pages.service" <<EOF
[Unit]
Description=Eval HQ on $host:5181 (evals/pages.vite.config.ts)

[Service]
WorkingDirectory=$repo
$env_lines
ExecStart=$repo/node_modules/.bin/vite --config evals/pages.vite.config.ts --host $host --port 5181
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
else
  echo "units.sh: no Tailscale address (RT_PAGES_HOST unset): Eval HQ's unit is left out" >&2
fi

systemctl --user daemon-reload
systemctl --user enable -q "$prefix-loop.service" "$prefix-intake.timer" ${host:+"$prefix-pages.service"}
echo "units.sh: $prefix-loop, $prefix-intake.timer${host:+, $prefix-pages ($host:5181)} installed in $dir; bin/rte run starts the loop"
[ "$prefix" != rt ] && exit 0 # a check's own set: no lingering, nothing started
systemctl --user start "$prefix-intake.timer" ${host:+"$prefix-pages.service"}
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ] && ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "units.sh: lingering is off, so the units stop at logout and don't start after a reboot: run  sudo loginctl enable-linger $USER" >&2
fi
