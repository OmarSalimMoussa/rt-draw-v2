#!/usr/bin/env bash
# The laptop's one eval unit: rt-pull-local.timer sends its dev server's .data (the owner's own sends) and the sends they
# recorded for U1 to the PGX every 30 minutes, for intake and the Judge view there (evals/real/pull.sh local). It runs on
# the clock, so a pull missed while the laptop slept runs when it wakes. Install it from the checkout you deploy the
# harness from (it runs that checkout's pull.sh):
#   bash evals/ops/laptop-units.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=$(pwd)
dir=${RT_UNIT_DIR:-$HOME/.config/systemd/user}
mkdir -p "$dir"

cat > "$dir/rt-pull-local.service" <<UNIT
[Unit]
Description=This laptop's dev-server sends to the PGX for intake (evals/real/pull.sh local)

[Service]
Type=oneshot
ExecStart=/bin/bash $repo/evals/real/pull.sh local
UNIT

cat > "$dir/rt-pull-local.timer" <<UNIT
[Unit]
Description=This laptop's dev-server sends to the PGX, every 30 minutes

[Timer]
OnCalendar=*:0/30
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable -q --now rt-pull-local.timer
echo "laptop-units.sh: rt-pull-local.timer runs $repo/evals/real/pull.sh local every 30 minutes (journalctl --user -u rt-pull-local)"
