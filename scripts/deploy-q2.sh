#!/usr/bin/env bash
# Deployer melosys-muninn til q2 (dev-gcp) fra laptopen: `make deploy-q2`.
#
#   scripts/deploy-q2.sh [<muninn-ref>]     ref: tag eller full commit-SHA; standard er tuppen av muninn main
#   DRY_RUN=1 scripts/deploy-q2.sh          stopp etter forhåndssjekkene, uten å starte workflowen
#
# Skriptet erstatter ingen av vaktene i deploy.yml. Det løser main til en SHA
# (workflowen tar aldri en gren), sjekker upstream-pinnen før en kjøring på fem
# minutter feiler på den, starter workflowen, venter på den og sjekker til slutt
# at poden kjører den SHA-en som ble sendt inn.
#
# Krever: gh (innlogget), jq, shasum, kubectl med kontekst dev-gcp og naisdevice
# for sluttsjekken mot ingressen.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY_REPO=navikt/melosys-muninn
CONTEXT=dev-gcp

# Samme kilde som workflowen, så det ikke finnes en kopi å holde i takt.
MUNINN_REPO=$(awk '$1 == "MUNINN_REPO:" {print $2; exit}' "$ROOT/.github/workflows/deploy.yml")
[ -n "$MUNINN_REPO" ] || { echo "fant ikke MUNINN_REPO i deploy.yml" >&2; exit 1; }
APP=$(jq -er '.app_name' "$ROOT/nais/vars-q2.json")
NAMESPACE=$(jq -er '.namespace' "$ROOT/nais/vars-q2.json")
INGRESS=$(jq -er '.ingress_intern' "$ROOT/nais/vars-q2.json")

REF=${1:-}
if [ -z "$REF" ]; then
  REF=$(git ls-remote "https://github.com/$MUNINN_REPO" refs/heads/main | awk '{print $1}') || true
  [ -n "$REF" ] || { echo "klarte ikke å løse $MUNINN_REPO main til en SHA" >&2; exit 1; }
  echo "muninn-ref: $REF (tuppen av $MUNINN_REPO main)"
else
  echo "muninn-ref: $REF"
fi

# Workflowen kjører alltid fra main i deploy-repoet, ikke fra det som ligger lokalt.
DEPLOY_SHA=$(gh api "repos/$DEPLOY_REPO/commits/main" --jq .sha)
echo "deploy-repo: $DEPLOY_REPO main @ ${DEPLOY_SHA:0:7}"
if [ "$(git -C "$ROOT" rev-parse HEAD)" != "$DEPLOY_SHA" ]; then
  echo "  NB: lokal HEAD er ikke $DEPLOY_REPO main — lokale endringer er ikke med i denne deployen"
fi

# Samme sammenligning som steget «build/Dockerfile.nais still mirrors upstream's
# build and entrypoint» i deploy.yml. Den sjekken er fortsatt den som avgjør;
# denne sparer bare en kjøring som uansett ville feilet.
raw() {
  gh api -H 'Accept: application/vnd.github.raw' "repos/$MUNINN_REPO/contents/$1?ref=$REF"
}
DF=$(raw Dockerfile | shasum -a 256) || { echo "fant ikke Dockerfile i $MUNINN_REPO@$REF" >&2; exit 1; }
EP=$(raw scripts/docker-entrypoint.sh | shasum -a 256) || { echo "fant ikke scripts/docker-entrypoint.sh i $MUNINN_REPO@$REF" >&2; exit 1; }
START=$(raw package.json | jq -er '.scripts.start') || { echo "package.json i $MUNINN_REPO@$REF har ingen scripts.start" >&2; exit 1; }
if ! printf 'sha256 Dockerfile %s\nsha256 scripts/docker-entrypoint.sh %s\nscripts.start %s\n' "${DF%% *}" "${EP%% *}" "$START" \
    | diff -u "$ROOT/build/upstream-dockerfile-pin.txt" -; then
  echo "upstream-pinnen stemmer ikke: speil endringen i build/Dockerfile.nais eller build/nais-entrypoint.ts og pin på nytt (docs/runtime-image.md)" >&2
  exit 1
fi
echo "upstream-pinnen stemmer"

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "DRY_RUN=1: starter ikke workflowen"
  exit 0
fi

OUT=$(gh workflow run deploy.yml -R "$DEPLOY_REPO" --ref main -f muninn_ref="$REF" -f cluster="$CONTEXT" 2>&1)
RUN_URL=$(printf '%s\n' "$OUT" | grep -Eo 'https://github\.com/[^ ]+/actions/runs/[0-9]+' | head -1) || true
[ -n "$RUN_URL" ] || { printf 'fant ingen kjørings-URL i svaret fra gh:\n%s\n' "$OUT" >&2; exit 1; }
echo "kjøring: $RUN_URL"
gh run watch "${RUN_URL##*/}" -R "$DEPLOY_REPO" --exit-status --interval 30 > /dev/null || {
  echo "workflowen feilet: $RUN_URL" >&2; exit 1
}
echo "workflowen er grønn"

kubectl --context "$CONTEXT" -n "$NAMESPACE" rollout status "deploy/$APP" --timeout=180s
DEPLOYED=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get "deploy/$APP" \
  -o jsonpath="{.spec.template.spec.containers[?(@.name==\"$APP\")].env[?(@.name==\"MUNINN_REF\")].value}")
# Poden bærer alltid den løste SHA-en, også når en tag ble sendt inn.
WANT=$(gh api "repos/$MUNINN_REPO/commits/$REF" --jq .sha)
[ "$DEPLOYED" = "$WANT" ] || { echo "poden har MUNINN_REF=$DEPLOYED, forventet $WANT" >&2; exit 1; }
echo "poden kjører muninn $WANT"
LIVE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$INGRESS/api/live") || true
[ "$LIVE" = 200 ] || { echo "$INGRESS/api/live svarte '$LIVE' (naisdevice på?)" >&2; exit 1; }
echo "$INGRESS/api/live: 200"
