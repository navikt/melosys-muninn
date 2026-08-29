# Step zero's WebSocket echo image — see docs/step-zero-websocket.md.
#
# YOU DO NOT BUILD THIS BY HAND. `.github/workflows/step-zero.yml` builds it,
# pushes it to the team GAR and hands the digest-pinned reference straight to
# nais/deploy. It is NOT built by .github/workflows/deploy.yml, which builds
# MUNINN at a pinned ref with this repo's bot folder overlaid and refuses to run
# while any REPLACE_ME survives in vars-q2.json — still the state of the world
# when step zero runs. The two have nothing in common but a registry.
#
# It must land in an ALLOWED registry — nais will not pull an arbitrary public
# image — which is the real cost the plan prices step zero with.
#
# For LOCAL debugging only (a runner is amd64; `--platform` is not optional on
# the arm64 Mac this repo is authored on, and an arm64 image in GAR is an
# ImagePullBackOff that reads like a registry permission problem):
#
#   docker build --platform linux/amd64 -t echo-local build/echo
#   docker run --rm -p 3000:3000 echo-local
#
# Do not push a hand-built image and wire its reference into
# nais/step-zero/vars-step-zero.json. There is no `echo_image` key there any
# more, deliberately: it was a placeholder no guard covered.
FROM oven/bun:1-debian

WORKDIR /app
COPY server.ts ./

# Matches nais/step-zero/stub.yaml's `port:` and its /api/live probe. nais
# injects PORT itself; the default is here so a local `docker run -p 3000:3000`
# behaves the same way.
ENV PORT=3000
EXPOSE 3000

# No entrypoint script and nothing to provision. This image exists to answer
# one question and then be replaced by the real one.
CMD ["bun", "run", "server.ts"]
