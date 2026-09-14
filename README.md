# melosys-muninn

The deploy artifact for running muninn on nais. It holds everything NAV-specific
— the manifest, the ingresses, the tenant, the group ids, the bot persona — so
that the muninn repo itself carries none of it. The public muninn repo is named
in exactly one place: `MUNINN_REPO` in `.github/workflows/deploy.yml`.

**Nothing here is a fork.** The image is built from public muninn at a pinned
ref — a tag, or a full 40-character commit SHA — with this repo's `bots/` folder
overlaid into the build context. There is no patched Dockerfile and no vendored
source. Public muninn carries no tags today, so in practice the first deploy
names a SHA; see the deploy section below.

## Why `CLAUDE.md` and `claude-cli` appear in this repo

muninn is the upstream application, and these are its identifiers — not a
statement about how this code was written. `CLAUDE.md` is the filename muninn
discovers a bot by (`src/bots/config.ts`); `claude-cli` and `claude-sdk` are
members of its connector enum; `CLAUDE_CODE_USE_VERTEX` and
`ANTHROPIC_VERTEX_PROJECT_ID` are the Agent SDK's env names, and nothing here
sets them — every occurrence is a comment or a doc line explaining the absence.

This pod runs none of those paths. The bot pins `openai-compat` against Vertex,
and the image is built `--build-arg WITH_CLI=false`, so it carries no `claude`
binary at all — `deploy.yml` asserts both against the built image before it
deploys. `docs/bot-folder-notes.md` §2 says what the connector pin buys.

The names stay as upstream spells them. A local rename would leave the guards
asserting something the pod does not boot on, which is the one thing they exist
to prevent.

## Layout

| Path | What it is |
|---|---|
| `nais/app.yaml` | The Application manifest. Templated with `{{ }}`; every comment in it explains a constraint that is easy to "simplify" into an outage. |
| `nais/vars-q2.json` | The values. Ships full of `REPLACE_ME_` — see `docs/PREREQUISITES.md`. |
| `bots/melosys/` | The bot: persona, `config.json`, an empty `.mcp.json`. Copied into `bots/` in the build context. |
| `.github/workflows/deploy.yml` | Check out muninn at a pinned ref → resolve it to a SHA → assign the Vertex base URL → overlay → build and push → pull the digest → assert → scan → deploy. |
| `build/Dockerfile.nais` + `build/nais-entrypoint.ts` | The deployed image: Docker Hardened Images Bun, no shell, and a shell-free entrypoint. See `docs/runtime-image.md`. |
| `build/upstream-copy-lines.txt` | Upstream's Dockerfile COPY lines as last mirrored. The workflow stops when they change. |
| `nais/step-zero/` | The stub `Application` and its own vars file, for proving the WebSocket upgrade **before** buying Cloud SQL and the GCP project. |
| `nais/provision-job.yaml` + `nais/provision-netpol.yaml` | The one-shot schema step, as a Naisjob. Applied by hand, not by a workflow — `kubectl debug` is unavailable to the team and the job needs a NetworkPolicy nais will not generate for it. See `docs/db-setup.md`. |
| `.github/workflows/step-zero.yml` | Builds the echo image → pushes it → applies the stub. Deliberately separate from `deploy.yml`, which refuses while `vars-q2.json` holds a `REPLACE_ME`. |
| `build/echo/` | The WebSocket echo image step zero deploys. Built by the workflow above; it has nothing to do with the muninn build. |
| `CODEOWNERS` | The team, on everything. This repo is public and takes outside pull requests. |
| `docs/` | The prerequisites, the schema runbook, step zero, why the bot folder looks the way it does, and every form of the pipeline's guards that was wrong. |

## The overlay, and the two things that make it land

Public muninn's `.dockerignore` excludes `bots/` — it must, because the folders
are gitignored and a developer building locally must not bake whichever bots are
on their laptop into an image. This deployment needs exactly the opposite for
exactly one folder.

So the workflow **derives** the build-context ignore: it copies this repo's
`bots/` over the checkout's and strips the `bots/` line out of
`./muninn/.dockerignore`, which is the file the build action reads at the
context root. There is deliberately **no checked-in second copy** of that file.
An earlier version of this repo carried one (`build/Dockerfile.dockerignore`,
relying on BuildKit preferring `<dockerfile>.dockerignore`), and it was a
hand-maintained duplicate whose own header said "keep it in sync" with nothing
enforcing it — an exclusion added upstream would have been silently dropped from
the image.

Deriving it means the removal is **guarded**:

```bash
grep -q '^bots/$' muninn/.dockerignore || { echo "::error::…"; exit 1; }
grep -v '^bots/$' muninn/.dockerignore > /tmp/di && mv /tmp/di muninn/.dockerignore
```

An upstream rename now breaks the build instead of passing quietly.

Two more things about that step are not optional, and both were found by
building it:

- **`rm -rf muninn/bots` first.** Public muninn *tracks* `bots/jarvis/`, so
  dropping the exclusion lets jarvis ride along — measured, the first build
  produced `bots/ baked into the image: CLAUDE.md jarvis melosys`. A pod that
  discovers jarvis offers it to a colleague in the picker, with a wikiDir that
  does not exist and MCP servers that need `uv`. This repo's `bots/` is the whole
  set, not an addition.
- **Assert the EXACT SET afterwards.** `COPY bot[s] ./bots/` tolerates an absent
  folder, so a build that copies *nothing* succeeds. Too few is a
  CrashLoopBackOff; too many is a broken bot in front of a colleague.

## The one value the workflow writes into the bot folder

`bots/melosys/config.json` ships with `"baseUrl": "REPLACE_ME_vertex_baseurl"`,
and the workflow fills it in — building
`https://<host>/v1/projects/<project>/locations/<region>/endpoints/openapi` from
`gcp_project` and `vertex_region` and `jq`-assigning it into the copy it
overlays. nais VARS templating rewrites only the manifest, never files under
`bots/`, so without this the project and the region would live in four places
that nothing compares — and both mismatches are silent (a wrong project is a
Google `403` with no retry and no diagnostic; a wrong region is an egress
allowlist naming a host nothing dials).

The step order around it is load-bearing and the workflow says so in place:
refuse a placeholder in the vars file → assign → refuse a placeholder in the bot
folder. The last one is a **backstop**, which is why the checked-in key must
exist: a `jq` assign would happily create a missing one, and then the grep would
have nothing to catch.

## Deploying

`workflow_dispatch` with a muninn tag or a **40-character commit SHA**. The
guard is positive rather than a list of names to refuse: it fetches the remote's
ref list once and compares exact fields, so a branch, a `refs/heads/…` spelling
and a glob are all refused, and a tag is accepted only if it is really there. A
SHA is accepted on shape alone — nothing can ask a remote whether an arbitrary
commit exists — so a short SHA is refused and a typo'd one fails later in
`actions/checkout`. The point is that a rollback has to be "redeploy X", not
"hope main has not moved". Whatever is dispatched is resolved to a commit SHA
immediately, and that SHA is what the GAR tag (`muninn-<sha>`) and the pod's
`MUNINN_REF` carry: a tag can be moved upstream. Public muninn has no tags
today, so the first deploy will name a SHA.

Before the first deploy, work through **`docs/PREREQUISITES.md`**. §1–§10 are
ten items and each one alone makes the pod useless; §0 is not one of them, it
is a proof to run *before* buying the expensive ones. The slowest is not
engineering work at all: the Entra app registration with admin consent. The
model question is **answered** — Gemini 2.5 Flash in `europe-north1` over
Vertex's OpenAI-compatible endpoint — and what remains of it is which GCP
project owns the quota.

## What this pod is

- **dev-gcp only, as `melosys-muninn-q2`.** Prod carries a personopplysninger
  decision that is not an engineering call.
- **One ingress**, on `intern.dev.nav.no`, which needs naisdevice.
  `MUNINN_ALLOWED_ORIGINS` is derived from it rather than maintained beside it.
  `ansatt.dev.nav.no` was served until 2026-09-12 and was dropped: that domain
  authenticates through a single shared SSO client, which leaves this app's
  group gate out of the login — and that gate is the only thing deciding who
  reaches the pod. `docs/PREREQUISITES.md` §4 has the measurement and the one
  test that would allow it back.
- **Chat only.** `MUNINN_PROFILE=nais` drops thirteen route groups; the wiki,
  the plans board, the capture verticals and the logs page are not registered.
  What is left is `/chat`, the operator dashboard, and two health paths.
- **One human at a time in the identity sense**: every request carries an Entra
  token, introspected through the Texas sidecar. There is no loopback bypass and
  no pinned identity in this mode.
- **No knowledge tools.** huginn is not on nais in v1. The bot's persona says so
  — see `docs/bot-folder-notes.md`.
