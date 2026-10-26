#!/usr/bin/env bash
# Deploys imagine (app/, on rt-draw v2's engine) to the EmberHub box as imagine.emberhub.dev, in rt-draw v1's
# place. Who gets in is the app's own business (invites, app/server/access.ts; deploy/README.md), so the edge
# route has no login of its own. The box's own layout is in /srv/KEYS.md there.
#   - everything of rt-draw's lives in /srv/rtdraw (compose project "rtdraw", host port 127.0.0.1:8700). This
#     app keeps its data in the volume rtdraw-v2-data; v1's rtdraw-data is left as it was, so v1's own deploy
#     script can still put v1 back;
#   - its keys come from the box's one shared /srv/emberhub.env, through the link $DIR/.env, which compose
#     reads for the ${...} in deploy/compose.yml;
#   - the one shared service is the box's edge Caddy (/srv/edge, container "edge"). This script touches only
#     its own site file, /srv/edge/sites/rtdraw.caddy, and validates the whole edge config before swapping it
#     in, so a bad file can never break another app's reload.
# The box needs, once: /srv/rtdraw owned by deploy, and /srv/emberhub.env with CLAUDE_CODE_OAUTH_TOKEN,
# TYPESAFE_API_KEY and ELEVENLABS_API_KEY (and MAILER_URL and MAILER_SECRET for the mailer).
set -euo pipefail

# The box by address: the name prod.emberhub.dev no longer resolves.
BOX=${RTDRAW_BOX:-deploy@31.220.50.146}
HOST=imagine.emberhub.dev
DIR=/srv/rtdraw
SITES=/srv/edge/sites
KEEP=3

cd "$(dirname "$0")/.."
TAG=v2-$(git rev-parse --short=12 HEAD)
[ -z "$(git status --porcelain)" ] || TAG="$TAG-dirty-$(date +%s)"

echo "== checking the box"
ssh "$BOX" "test -w $DIR && test -r /srv/emberhub.env && ln -sfn /srv/emberhub.env $DIR/.env" ||
  { echo "the box needs $DIR (owned by deploy) and /srv/emberhub.env; see the header" >&2; exit 1; }

echo "== building rtdraw:$TAG"
docker build -t "rtdraw:$TAG" .

echo "== shipping the image"
docker save "rtdraw:$TAG" | gzip -1 | ssh "$BOX" "gunzip | docker load"
scp -q deploy/compose.yml "$BOX:$DIR/compose.yml"

echo "== starting it"
ssh "$BOX" "cd $DIR && RTDRAW_TAG=$TAG docker compose up -d --wait && echo $TAG >> deployed"

echo "== the edge route"
ssh "$BOX" HOST="$HOST" DIR="$DIR" SITES="$SITES" bash -s <<'REMOTE'
set -euo pipefail
site=$(mktemp)
{
  echo "# Written by rt-draw's scripts/deploy.sh."
  echo "$HOST {"
  echo "	reverse_proxy 127.0.0.1:8700 {"
  echo "		# Turns stream as NDJSON; pass each line on as it comes."
  echo "		flush_interval -1"
  echo "	}"
  echo "}"
} > "$site"
chmod 644 "$site"
if cmp -s "$site" "$SITES/rtdraw.caddy"; then echo "unchanged"; rm "$site"; exit 0; fi

# The whole edge config, with the new file in place, checked by the edge's own Caddy image.
check=$(mktemp -d)
cp "$SITES"/*.caddy "$check"/ 2>/dev/null || true
cp "$site" "$check/rtdraw.caddy"
chmod 755 "$check"
image=$(docker inspect edge --format '{{.Config.Image}}')
email=$(docker exec edge printenv ACME_EMAIL)
docker run --rm --network none -e ACME_EMAIL="$email" -v "$check:/etc/caddy/sites:ro" -v /srv/edge/Caddyfile:/etc/caddy/Caddyfile:ro \
  "$image" caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null
rm -rf "$check"

old=$(mktemp)
had=0; [ -f "$SITES/rtdraw.caddy" ] && { cp "$SITES/rtdraw.caddy" "$old"; had=1; }
mv "$site" "$SITES/.rtdraw.caddy.tmp" && mv "$SITES/.rtdraw.caddy.tmp" "$SITES/rtdraw.caddy"
if ! docker exec edge caddy reload --config /etc/caddy/Caddyfile; then
  echo "reload failed; putting the old route back" >&2
  if [ $had = 1 ]; then cp "$old" "$SITES/rtdraw.caddy"; else rm -f "$SITES/rtdraw.caddy"; fi
  docker exec edge caddy reload --config /etc/caddy/Caddyfile
  exit 1
fi
rm -f "$old"
echo "reloaded"
REMOTE

echo "== dropping old images (keeping the last $KEEP)"
ssh "$BOX" "cd $DIR && keep=\$(tail -n $KEEP deployed | sed 's/^/rtdraw:/'); docker images rtdraw --format '{{.Repository}}:{{.Tag}}' | grep -vxF \"\$keep\" | xargs -r docker image rm >/dev/null || true"

echo "== live: https://$HOST (rtdraw:$TAG)"
