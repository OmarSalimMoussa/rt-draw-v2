#!/usr/bin/env bash
# Deploys imagine (app/, on rt-draw v2's engine) to the ember box as imagine.emberhub.dev, in rt-draw v1's
# place and, as v1 was, apart from Ember. Who gets in is the app's own business (invites, app/server/access.ts;
# deploy/README.md), so the edge route has no login of its own.
#   - everything of rt-draw's lives in /srv/rtdraw (compose project "rtdraw", host port 127.0.0.1:8700; the
#     factory's own services hold 8000-8200 and 9000s). This app keeps its data in the volume rtdraw-v2-data;
#     v1's rtdraw-data is left as it was, so v1's own deploy script can still put v1 back;
#   - the one shared piece is the factory's edge Caddy. This script touches only its own site file,
#     /srv/factory/edge/sites/rtdraw.caddy, and validates the whole edge config before swapping it in,
#     so a bad file can never break the next reload of Ember's deploy. The factory writes only
#     ember-*.caddy and prunes only ember-* images, so Ember's deploys leave rt-draw alone.
# The box needs, once: /srv/rtdraw owned by deploy, with rtdraw.env (CLAUDE_CODE_OAUTH_TOKEN, ELEVENLABS_API_KEY)
# and rtdraw-v2.env (TYPESAFE_API_KEY, MAILER_SECRET, and MAILER_URL once the mailer is set up).
set -euo pipefail

# The box by address: the name prod.emberhub.dev no longer resolves.
BOX=${RTDRAW_BOX:-deploy@31.220.50.146}
HOST=imagine.emberhub.dev
DIR=/srv/rtdraw
SITES=/srv/factory/edge/sites
KEEP=3

cd "$(dirname "$0")/.."
TAG=v2-$(git rev-parse --short=12 HEAD)
[ -z "$(git status --porcelain)" ] || TAG="$TAG-dirty-$(date +%s)"

echo "== checking the box"
ssh "$BOX" "test -w $DIR && test -f $DIR/rtdraw.env && test -f $DIR/rtdraw-v2.env" ||
  { echo "the box needs $DIR (owned by deploy) with rtdraw.env and rtdraw-v2.env; see the header" >&2; exit 1; }

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
  echo "# Written by rt-draw's scripts/deploy.sh; Ember's factory never touches this file."
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
image=$(docker inspect factory-edge --format '{{.Config.Image}}')
email=$(docker exec factory-edge printenv ACME_EMAIL)
docker run --rm --network none -e ACME_EMAIL="$email" -v "$check:/etc/caddy/sites:ro" -v /srv/factory/services/edge.Caddyfile:/etc/caddy/Caddyfile:ro \
  "$image" caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null
rm -rf "$check"

old=$(mktemp)
had=0; [ -f "$SITES/rtdraw.caddy" ] && { cp "$SITES/rtdraw.caddy" "$old"; had=1; }
mv "$site" "$SITES/.rtdraw.caddy.tmp" && mv "$SITES/.rtdraw.caddy.tmp" "$SITES/rtdraw.caddy"
if ! docker exec factory-edge caddy reload --config /etc/caddy/Caddyfile; then
  echo "reload failed; putting the old route back" >&2
  if [ $had = 1 ]; then cp "$old" "$SITES/rtdraw.caddy"; else rm -f "$SITES/rtdraw.caddy"; fi
  docker exec factory-edge caddy reload --config /etc/caddy/Caddyfile
  exit 1
fi
rm -f "$old"
echo "reloaded"
REMOTE

echo "== dropping old images (keeping the last $KEEP)"
ssh "$BOX" "cd $DIR && keep=\$(tail -n $KEEP deployed | sed 's/^/rtdraw:/'); docker images rtdraw --format '{{.Repository}}:{{.Tag}}' | grep -vxF \"\$keep\" | xargs -r docker image rm >/dev/null || true"

echo "== live: https://$HOST (rtdraw:$TAG)"
