# muninn-nais

The deploy artifact for running [muninn](https://github.com/REPLACE_ME) on nais.
It holds everything NAV-specific — the manifest, the ingress, the tenant, the
group ids, the bot persona — so that the muninn repo itself can stay public and
carry none of it.

**Nothing here is a fork.** The image is built from public muninn at a pinned
tag, with this repo's `bots/` folder overlaid into the build context. There is no
patched Dockerfile and no vendored source.

## Layout

| Path | What it is |
|---|---|
| `nais/app.yaml` | The Application manifest. Templated with `{{ }}`; every comment in it explains a constraint that is easy to "simplify" into an outage. |
| `nais/vars-dev.json` | The values. Ships full of `REPLACE_ME_` — see `docs/PREREQUISITES.md`. |
| `bots/melosys/` | The bot: persona, `config.json`, an empty `.mcp.json`. Copied into `bots/` in the build context. |
| `build/Dockerfile.dockerignore` | The one file that makes the overlay land. See below. |
| `.github/workflows/deploy.yml` | Check out muninn at a tag → overlay → build → assert → push → deploy. |
| `docs/` | The prerequisites, the schema runbook, step zero, and why the bot folder looks the way it does. |

## The overlay, and the one trick in it

Public muninn's `.dockerignore` excludes `bots/` — it must, because the folders
are gitignored and a developer building locally must not bake whichever bots are
on their laptop into an image. This deployment needs exactly the opposite for
exactly one folder.

BuildKit resolves `<dockerfile-name>.dockerignore` in preference to
`.dockerignore`, so the workflow copies `build/Dockerfile.dockerignore` next to
the checked-out `Dockerfile` and the public repo is never edited. Measured on
Docker 29.6.2:

```
.dockerignore excludes bots/          → [build] NO BOTS
+ Dockerfile.dockerignore             → [build] bots present: melosys
                                        docker run … ls /app/bots → melosys
```

Two things about that step are not optional, and both were found by building it:

- **`rm -rf muninn/bots` first.** Public muninn *tracks* `bots/jarvis/`, so
  dropping the exclusion lets jarvis ride along — measured, the first build
  produced `bots/ baked into the image: CLAUDE.md jarvis melosys`. A pod that
  discovers jarvis offers it to a colleague in the picker, with a wikiDir that
  does not exist and MCP servers that need `uv`. This repo's `bots/` is the whole
  set, not an addition.
- **Assert the EXACT SET afterwards.** `COPY bot[s] ./bots/` tolerates an absent
  folder, so a build that copies *nothing* succeeds. Too few is a
  CrashLoopBackOff; too many is a broken bot in front of a colleague.

## Deploying

`workflow_dispatch` with a muninn tag or commit SHA. Branches are refused: a
rollback has to be "redeploy tag X", not "hope main has not moved".

Before the first deploy, work through **`docs/PREREQUISITES.md`**. It is eight
items and each one alone makes the pod useless. Two of them are not engineering
work at all — the Entra app registration with admin consent, and the model
region decision that is open with Team KI.

## What this pod is

- **dev-gcp only.** Prod carries a personopplysninger decision that is not an
  engineering call.
- **Chat only.** `MUNINN_PROFILE=nais` drops thirteen route groups; the wiki,
  the plans board, the capture verticals and the logs page are not registered.
  What is left is `/chat`, the operator dashboard, and two health paths.
- **One human at a time in the identity sense**: every request carries an Entra
  token, introspected through the Texas sidecar. There is no loopback bypass and
  no pinned identity in this mode.
- **No knowledge tools.** huginn is not on nais in v1. The bot's persona says so
  — see `docs/bot-folder-notes.md`.
