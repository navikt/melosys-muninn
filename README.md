# muninn-nais

The deploy artifact for running muninn on nais. It holds everything NAV-specific
— the manifest, the ingresses, the tenant, the group ids, the bot persona — so
that the muninn repo itself carries none of it. The public muninn repo is named
in exactly one place: `MUNINN_REPO` in `.github/workflows/deploy.yml`.

**Nothing here is a fork.** The image is built from public muninn at a pinned
tag, with this repo's `bots/` folder overlaid into the build context. There is no
patched Dockerfile and no vendored source.

## Layout

| Path | What it is |
|---|---|
| `nais/app.yaml` | The Application manifest. Templated with `{{ }}`; every comment in it explains a constraint that is easy to "simplify" into an outage. |
| `nais/vars-q2.json` | The values. Ships full of `REPLACE_ME_` — see `docs/PREREQUISITES.md`. |
| `bots/melosys/` | The bot: persona, `config.json`, an empty `.mcp.json`. Copied into `bots/` in the build context. |
| `.github/workflows/deploy.yml` | Check out muninn at a pinned ref → resolve it to a SHA → assign the Vertex base URL → overlay → build → assert → push → deploy. |
| `docs/` | The prerequisites, the schema runbook, step zero, and why the bot folder looks the way it does. |

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

`workflow_dispatch` with a muninn tag or commit SHA. Branches are refused — by
asking the remote, not by testing two literal names — because a rollback has to
be "redeploy tag X", not "hope main has not moved". Whatever is dispatched is
resolved to a commit SHA immediately, and that SHA is what the GAR tag
(`muninn-<sha>`) and the pod's `MUNINN_REF` carry: a tag can be moved upstream.

Before the first deploy, work through **`docs/PREREQUISITES.md`**. It is ten
items and each one alone makes the pod useless, and the slowest is not engineering work at all: the
Entra app registration with admin consent. The model question is **answered** —
Gemini 2.5 Flash in `europe-north1` over Vertex's OpenAI-compatible endpoint —
and what remains of it is which GCP project owns the quota.

## What this pod is

- **dev-gcp only, as `melosys-muninn-q2`.** Prod carries a personopplysninger
  decision that is not an engineering call.
- **Two ingresses.** `intern.dev.nav.no` needs naisdevice; `ansatt.dev.nav.no` is
  how a team member without developer access reaches it. `MUNINN_ALLOWED_ORIGINS`
  is derived from the pair rather than maintained beside them.
- **Chat only.** `MUNINN_PROFILE=nais` drops thirteen route groups; the wiki,
  the plans board, the capture verticals and the logs page are not registered.
  What is left is `/chat`, the operator dashboard, and two health paths.
- **One human at a time in the identity sense**: every request carries an Entra
  token, introspected through the Texas sidecar. There is no loopback bypass and
  no pinned identity in this mode.
- **No knowledge tools.** huginn is not on nais in v1. The bot's persona says so
  — see `docs/bot-folder-notes.md`.
