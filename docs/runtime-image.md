# The runtime image

The deployed image is built from `build/Dockerfile.nais`, not from muninn's own
`Dockerfile`. Compose keeps building upstream's file. This page covers what the
NAV build changes, where its base images come from, and how the deploy decides
an image is fit to ship.

## Why Docker Hardened Images, and why Debian

The first image was `oven/bun:1-debian` plus `curl`, and it carried 15 Critical
and High findings in its OS packages. Chainguard's Bun image was the plan, but
NAV's registry proxy answers `403` for it, and Bun is not on NAV's Chainguard
list. Docker Hardened Images (DHI) Community publishes Bun for free under
Apache 2.0.

DHI offers Debian 13 and Alpine variants. Use Debian. Muninn's
`onnxruntime-node` ships a glibc addon that fails to load on Alpine's musl, and
the embedding model depends on it.

| Stage | Image | What it has |
|---|---|---|
| build | `dhi-bun:1.4.2-debian13-dev` | Shell, package manager, root. Runs `bun install` and bakes the model. |
| runtime | `dhi-bun:1.4.2-debian13` | Bun, CA certificates, coreutils, `openssl`, and the `debconf`/`dpkg-reconfigure` helpers. No shell, no apt, user 65532. |

Both come from the same DHI release, so the native modules installed in the
build stage load in the runtime stage.

## The mirror in GAR

CI has no `dhi.io` credential. The base images are copied into the team's GAR,
and `build/Dockerfile.nais` pins those copies by digest:

```
europe-north1-docker.pkg.dev/nais-management-233d/teammelosys/dhi-bun
```

`imagetools create` copies the multi-platform index by digest, so the mirrored
digest equals the upstream one. To move to a new DHI release:

1. Sign in to Docker Hub on your workstation (`docker login dhi.io`).
2. Resolve the new digests:

   ```sh
   docker buildx imagetools inspect dhi.io/bun:1 --format '{{.Manifest.Digest}}'
   docker buildx imagetools inspect dhi.io/bun:1-dev --format '{{.Manifest.Digest}}'
   ```

3. Mirror each digest under a tag that names the Bun and Debian versions:

   ```sh
   G=europe-north1-docker.pkg.dev/nais-management-233d/teammelosys/dhi-bun
   docker buildx imagetools create -t "$G:<bun>-debian13"     dhi.io/bun:1@<runtime digest>
   docker buildx imagetools create -t "$G:<bun>-debian13-dev" dhi.io/bun:1-dev@<build digest>
   ```

4. Update both `FROM` lines in `build/Dockerfile.nais` and open a pull request.
   The deploy's scan decides whether the new base ships.

The mirror does not update itself. Until a digest updater and a daily rescan
exist (PR 2b in the mimir plan), a new CVE in a base package surfaces only on
the next deploy's scan.

## What the deploy checks before it deploys

The workflow builds and pushes once, pulls the pushed digest back, and runs
every check against that digest. The deploy uses the same reference.

| Check | Stops the deploy when |
|---|---|
| Upstream parity | The sha256 of upstream's `Dockerfile` or `scripts/docker-entrypoint.sh`, or its `scripts.start`, differs from `build/upstream-dockerfile-pin.txt`. |
| Bot set | `/app/bots` is absent, empty, or not exactly this repo's `bots/`, or a bot lacks a `CLAUDE.md` or a non-CLI connector. |
| Binaries | `sh`, `bash`, `curl`, `ffmpeg` or `claude` is on `PATH`. |
| Ownership | The image's own user (65532) can write any path under `/app`. |
| Embedding | The model does not return a 384-dimensional vector with no network, a read-only root filesystem and UID 1069. |
| Entrypoint | With no reachable database, the container exits with anything but 2, or without `build/nais-entrypoint.ts`'s own refusal line. |
| Trivy | Any Critical, any High with a fixed version, a scanner error, or a report with no OS detected. |

Trivy covers Debian packages and the npm tree under `node_modules`. It does not see inside the Bun binary or the prebuilt `.so` files that `onnxruntime-node` and `sharp` ship.

The vulnerability database is downloaded on every run; nothing caches it. A registry rate limit on the download fails the scan, and the deploy with it.

The parity pin is whole-file, so a comment-only upstream edit also stops the deploy. Read the upstream diff, mirror what matters, then re-pin from the muninn checkout's root:

```sh
printf 'sha256 Dockerfile %s\nsha256 scripts/docker-entrypoint.sh %s\nscripts.start %s\n' \
  "$(sha256sum Dockerfile | cut -d' ' -f1)" \
  "$(sha256sum scripts/docker-entrypoint.sh | cut -d' ' -f1)" \
  "$(jq -r .scripts.start package.json)" > ../deploy/build/upstream-dockerfile-pin.txt
```

## Findings the gate lets through

Trivy 0.74.0 reports two High findings in the DHI runtime with no fixed
version. Both are in Debian packages the runtime inherits:

| CVE | Package | Status |
|---|---|---|
| CVE-2026-54369 | `libacl1` 2.3.2-2+dhi1 | affected, no fix |
| CVE-2026-16742 | `libsystemd0` 257.13-1~deb13u1+dhi2 | affected, no fix |

Owner: `@navikt/teammelosys`. Next review: 2026-10-15.

Docker Scout reported 0 High for the DHI base, most likely because it applies
DHI's VEX statements; exporting the VEX failed, so that is not verified per CVE. Trivy is the gate, so the report NAIS Console shows can differ from
the workflow's. Explain a difference per CVE, not in total.

## Debugging a pod without a shell

`kubectl exec … -- sh` fails: the image has no shell. Run bun instead:

```sh
kubectl exec -n teammelosys deploy/melosys-muninn-q2 -c melosys-muninn-q2 -- \
  bun -e 'console.log(process.env.MUNINN_REF)'
```

A pod needing a different command sets `command:` in its spec, which replaces
the entrypoint. `nais/provision-job.yaml` does this with
`bun db/provision.ts`.

## The entrypoint

`build/nais-entrypoint.ts` replaces upstream's `scripts/docker-entrypoint.sh`
and keeps its order: adopt `DB_URL`, run `db/require-provisioned.ts`, run
`db/migrate.ts`, start the server. It passes a failing script's exit code
through, and imports `src/index.ts` in its own process, so bun stays PID 1 and
receives SIGTERM. Upstream's `exec "$@"` is not carried over.
