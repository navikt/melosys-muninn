# Step zero's WebSocket echo image — see docs/step-zero-websocket.md.
#
# BUILD AND PUSH IT BY HAND, not through .github/workflows/deploy.yml. That
# workflow builds MUNINN at a pinned ref with this repo's bot folder overlaid,
# and refuses to run while any REPLACE_ME survives in vars-q2.json — which is
# still the state of the world when step zero runs. The two have nothing in
# common but a registry.
#
#   docker build -t <gar>/<team>/melosys-muninn-echo:step-zero build/echo
#   docker push  <gar>/<team>/melosys-muninn-echo:step-zero
#
# where <gar> is the team's Artifact Registry path from docs/PREREQUISITES.md
# §9. It must land in an ALLOWED registry — nais will not pull an arbitrary
# public image — which is the real cost the plan prices step zero with.
# Put the resulting reference in nais/step-zero/vars-step-zero.json as
# `echo_image`.
#
# `--platform linux/amd64` if you build this on an arm64 Mac: nais runs amd64,
# and an arm64 image is an ImagePullBackOff that reads like a registry
# permission problem.
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
