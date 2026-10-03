#!/usr/bin/env bash
# Deployer melosys-muninn til q2 (dev-gcp) fra laptopen. `make deploy-q2` kjører
# skriptet uten argument; en bestemt ref gis bare som argument, aldri via miljøet.
#
#   scripts/deploy-q2.sh [<muninn-ref>]     ref: tag eller full commit-SHA; standard er tuppen av muninn main
#   DRY_RUN=1 scripts/deploy-q2.sh          stopp etter forhåndssjekkene, uten å starte workflowen
#                                            (alle verdier unntatt tom og 0 regnes som tørrkjøring)
#
# Skriptet erstatter ingen av vaktene i deploy.yml. Det løser ref-en til en SHA
# (workflowen tar aldri en gren), sjekker upstream-pinnen før en hel
# workflow-kjøring feiler på den, starter workflowen, venter på den og sjekker til slutt
# at deployment-en bærer den SHA-en.
#
# Workflowen kjører fra main i deploy-repoet, så alt skriptet leser fra dette
# repoet (deploy.yml, vars-q2.json, pinnen) hentes derfra, ikke fra arbeidskopien.
#
# Krever: gh (innlogget), git, jq, shasum, kubectl med kontekst dev-gcp og
# naisdevice for sluttsjekken mot ingressen.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY_REPO=navikt/melosys-muninn
CONTEXT=dev-gcp

fail() { echo "$*" >&2; exit 1; }
# Én fil fra et repo på en gitt ref, rått innhold.
raw() {
  gh api -H 'Accept: application/vnd.github.raw' "repos/$1/contents/$2?ref=$3"
}

DEPLOY_SHA=$(gh api "repos/$DEPLOY_REPO/commits/main" --jq .sha) || fail "klarte ikke å lese $DEPLOY_REPO main"
echo "deploy-repo: $DEPLOY_REPO main @ ${DEPLOY_SHA:0:7}"
if [ "$(git -C "$ROOT" rev-parse HEAD)" != "$DEPLOY_SHA" ]; then
  echo "  NB: lokal HEAD er ikke $DEPLOY_REPO main — lokale endringer er ikke med i denne deployen"
fi

DEPLOY_YML=$(raw "$DEPLOY_REPO" .github/workflows/deploy.yml "$DEPLOY_SHA") || fail "klarte ikke å lese deploy.yml fra $DEPLOY_REPO main"
VARS=$(raw "$DEPLOY_REPO" nais/vars-q2.json "$DEPLOY_SHA") || fail "klarte ikke å lese nais/vars-q2.json fra $DEPLOY_REPO main"
# Til fil, ikke `$(…)`: kommandoerstatning stryker avsluttende linjeskift, og
# workflowen sammenligner filen byte for byte.
PIN=$(mktemp)
trap 'rm -f "$PIN"' EXIT
raw "$DEPLOY_REPO" build/upstream-dockerfile-pin.txt "$DEPLOY_SHA" > "$PIN" || fail "klarte ikke å lese pinnen fra $DEPLOY_REPO main"
MUNINN_REPO=$(printf '%s\n' "$DEPLOY_YML" | awk '$1 == "MUNINN_REPO:" {print $2; exit}')
[ -n "$MUNINN_REPO" ] || fail "fant ikke MUNINN_REPO i deploy.yml"
APP=$(printf '%s' "$VARS" | jq -er '.app_name')
NAMESPACE=$(printf '%s' "$VARS" | jq -er '.namespace')
INGRESS=$(printf '%s' "$VARS" | jq -er '.ingress_intern')

# Samme regel som steget «The ref must be a tag or a full commit SHA, never a
# branch» i deploy.yml: en full SHA, eller en tag som finnes upstream.
REF=${1:-}
REFS=$(git ls-remote --refs "https://github.com/$MUNINN_REPO") || fail "klarte ikke å hente ref-er fra $MUNINN_REPO"
has_ref() { printf '%s\n' "$REFS" | w="$1" awk 'BEGIN{w=ENVIRON["w"]} $2==w{f=1} END{exit !f}'; }
if [ -z "$REF" ]; then
  REF=$(printf '%s\n' "$REFS" | awk '$2 == "refs/heads/main" {print $1}')
  [ -n "$REF" ] || fail "fant ikke main i $MUNINN_REPO"
  echo "muninn-ref: $REF (tuppen av $MUNINN_REPO main)"
elif has_ref "refs/heads/$REF"; then
  fail "'$REF' er en GREN i $MUNINN_REPO — oppgi en tag eller en full commit-SHA"
elif printf %s "$REF" | jq -Rse 'test("\\A[0-9a-fA-F]{40}\\z")' > /dev/null; then
  echo "muninn-ref: $REF"
elif has_ref "refs/tags/$REF"; then
  echo "muninn-ref: tag $REF"
else
  fail "'$REF' er verken en tag i $MUNINN_REPO eller en full commit-SHA på 40 tegn"
fi

# Løst én gang: workflowen og sluttsjekken får samme SHA, også om en tag flyttes.
SHA=$(gh api "repos/$MUNINN_REPO/commits/$(jq -rn --arg r "$REF" '$r|@uri')" --jq .sha) \
  || fail "fant ingen commit for '$REF' i $MUNINN_REPO"
[ "$SHA" = "$REF" ] || echo "  løst til $SHA"

# Samme sammenligning som steget «build/Dockerfile.nais still mirrors upstream's
# build and entrypoint» i deploy.yml. Den sjekken er fortsatt den som avgjør;
# denne sparer bare en kjøring som uansett ville feilet.
DF=$(raw "$MUNINN_REPO" Dockerfile "$SHA" | shasum -a 256) || fail "fant ikke Dockerfile i $MUNINN_REPO@$SHA"
EP=$(raw "$MUNINN_REPO" scripts/docker-entrypoint.sh "$SHA" | shasum -a 256) || fail "fant ikke scripts/docker-entrypoint.sh i $MUNINN_REPO@$SHA"
START=$(raw "$MUNINN_REPO" package.json "$SHA" | jq -er '.scripts.start') || fail "package.json i $MUNINN_REPO@$SHA har ingen scripts.start"
if ! printf 'sha256 Dockerfile %s\nsha256 scripts/docker-entrypoint.sh %s\nscripts.start %s\n' "${DF%% *}" "${EP%% *}" "$START" \
    | diff -u "$PIN" -; then
  fail "upstream-pinnen stemmer ikke: speil endringen i build/Dockerfile.nais eller build/nais-entrypoint.ts og pin på nytt (docs/runtime-image.md)"
fi
echo "upstream-pinnen stemmer"

# `get --raw` gjør ett kall uten API-oppdagelse, så en utilgjengelig klynge
# feiler etter tidsavbruddet. `get deploy/…` prøver oppdagelsen på nytt og
# bruker flere ganger så lang tid.
deployed_ref() {
  kubectl --context "$CONTEXT" --request-timeout=10s \
    get --raw "/apis/apps/v1/namespaces/$NAMESPACE/deployments/$APP" \
    | APP="$APP" jq -er '.spec.template.spec.containers[] | select(.name == env.APP) | .env[] | select(.name == "MUNINN_REF") | .value'
}
BEFORE=$(deployed_ref 2>/dev/null) || {
  BEFORE=
  echo "  NB: fikk ikke lest MUNINN_REF fra deployment-en (svarer ikke klyngen, er naisdevice av, eller finnes ikke deployen ennå?)"
}
if [ "$BEFORE" = "$SHA" ]; then
  echo "  NB: deployment-en kjører allerede $SHA — sluttsjekken viser da ikke at denne kjøringen gikk gjennom, bare workflowen gjør det"
fi

# Alt annet enn tom og 0: den som skriver DRY_RUN=true, mener en tørrkjøring.
if [ -n "${DRY_RUN:-}" ] && [ "$DRY_RUN" != 0 ]; then
  echo "DRY_RUN=$DRY_RUN: starter ikke workflowen"
  exit 0
fi

OUT=$(gh workflow run deploy.yml -R "$DEPLOY_REPO" --ref main -f muninn_ref="$SHA" -f cluster="$CONTEXT" 2>&1) || {
  printf '%s\n' "$OUT" >&2; fail "klarte ikke å starte workflowen"
}
RUN_URL=$(printf '%s\n' "$OUT" | grep -Eo 'https://github\.com/[^ ]+/actions/runs/[0-9]+' | head -1) || true
# Workflowen ER startet her. Ikke kjør skriptet på nytt: det gir to deployer som kappes.
[ -n "$RUN_URL" ] || fail "workflowen er trolig startet, men gh oppga ingen kjørings-URL. Ikke start på nytt — følg den med: gh run list -R $DEPLOY_REPO --workflow deploy.yml"
echo "kjøring: $RUN_URL"
echo "venter på kjøringen"
gh run watch "${RUN_URL##*/}" -R "$DEPLOY_REPO" --exit-status --interval 30 > /dev/null || fail "workflowen feilet: $RUN_URL"
echo "workflowen er grønn"

# nais/deploy venter selv på utrullingen, så en grønn kjøring er en ferdig utrulling.
DEPLOYED=$(deployed_ref) || fail "workflowen er grønn ($RUN_URL), men MUNINN_REF fra deployment-en kunne ikke leses. Ikke start på nytt; sjekk med kubectl når klyngen svarer"
[ "$DEPLOYED" = "$SHA" ] || fail "workflowen er grønn ($RUN_URL), men deployment-en har MUNINN_REF=$DEPLOYED, forventet $SHA. Kjørte en annen deploy samtidig? Ikke start på nytt før du har sjekket"
echo "deployment-en kjører muninn $SHA"
LIVE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$INGRESS/api/live") || true
[ "$LIVE" = 200 ] || fail "workflowen er grønn ($RUN_URL), men $INGRESS/api/live svarte '$LIVE' (naisdevice på?)"
echo "$INGRESS/api/live: 200"
