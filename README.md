# melosys-muninn

The deploy artifact for running muninn on nais. It holds everything NAV-specific
— the manifest, the ingresses, the tenant, the group ids, the bot persona — so
that the muninn repo itself carries none of it. The public muninn repo is named
in exactly one place: `MUNINN_REPO` in `.github/workflows/deploy.yml`.

**Nothing here is a fork.** The image is built from public muninn at a pinned
ref — a tag, or a full 40-character commit SHA — with this repo's `bots/` folder
overlaid into the build context. There is no vendored source. The Dockerfile is
this repo's own `build/Dockerfile.nais` (hardened, shell-free runtime), which
mirrors upstream's and stops the deploy when upstream's build or entrypoint
changes; see `docs/runtime-image.md`. Public muninn carries no tags today, so in
practice the first deploy names a SHA; see the deploy section below.

## Why `CLAUDE.md` and `claude-cli` appear in this repo

muninn is the upstream application, and these are its identifiers — not a
statement about how this code was written. `CLAUDE.md` is the filename muninn
discovers a bot by (`src/bots/config.ts`); `claude-cli` and `claude-sdk` are
members of its connector enum; `CLAUDE_CODE_USE_VERTEX` and
`ANTHROPIC_VERTEX_PROJECT_ID` are the Agent SDK's env names, and nothing here
sets them — every occurrence is a comment or a doc line explaining the absence.

This pod runs none of those paths. The bot pins `openai-compat` against Vertex,
and `build/Dockerfile.nais` installs no Claude CLI, so it carries no `claude`
binary at all — `deploy.yml` asserts both against the pushed image before it
deploys. `docs/bot-folder-notes.md` §2 says what the connector pin buys.

The names stay as upstream spells them. A local rename would leave the guards
asserting something the pod does not boot on, which is the one thing they exist
to prevent.

## Layout

| Path | What it is |
|---|---|
| `nais/app.yaml` | The Application manifest. Templated with `{{ }}`; every comment in it explains a constraint that is easy to "simplify" into an outage. |
| `nais/vars.json` | The values. Ships full of `REPLACE_ME_` — see `docs/PREREQUISITES.md`. |
| `bots/melosys/` | The bot: persona, `config.json`, an empty `.mcp.json`. Copied into `bots/` in the build context. |
| `.github/workflows/deploy.yml` | Check out muninn at a pinned ref → resolve it to a SHA → assign the Vertex base URL → overlay → build and push → pull the digest → assert → scan → deploy. |
| `build/Dockerfile.nais` + `build/nais-entrypoint.ts` | The deployed image: Docker Hardened Images Bun, no shell, and a shell-free entrypoint. See `docs/runtime-image.md`. |
| `build/upstream-dockerfile-pin.txt` | The sha256 of upstream's whole `Dockerfile` and `scripts/docker-entrypoint.sh`, and its `scripts.start`, as last mirrored. The workflow stops when any of them changes. |
| `nais/step-zero/` | The stub `Application` and its own vars file, for proving the WebSocket upgrade **before** buying Cloud SQL and the GCP project. |
| `nais/provision-job.yaml` + `nais/provision-netpol.yaml` | The one-shot schema step, as a Naisjob. Applied by hand, not by a workflow — `kubectl debug` is unavailable to the team and the job needs a NetworkPolicy nais will not generate for it. See `docs/db-setup.md`. |
| `nais/migrate-job.yaml` + `nais/migrate-netpol.yaml` | `bun db/migrate.ts` as a Naisjob, for a muninn ref whose migration adds a table: the entrypoint refuses that database before it migrates. Applied by hand with the image the deploy run pushed, `--dry-run` first. See `docs/db-setup.md`. |
| `.github/workflows/step-zero.yml` | Builds the echo image → pushes it → applies the stub. Deliberately separate from `deploy.yml`, which refuses while `vars.json` holds a `REPLACE_ME`. |
| `build/echo/` | The WebSocket echo image step zero deploys. Built by the workflow above; it has nothing to do with the muninn build. |
| `scripts/publiser-felles-wiki.ts` | The curator's publish and retract script for the felles-wiki bucket: path, size and identifier checks, then an upload of the scanned bytes (`gcloud storage cp -`); `--fjern` deletes. |
| `build/svar-skanner.ts` | The answer scanner muninn loads through `WIKI_ANSWER_SCANNER`: `scanAnswer` runs the publish script's scanner over an answer to a `<Question>` card. It passes e-mail addresses and NAV idents, always refuses a fødselsnummer, D-nummer or H-nummer, and refuses an organisasjonsnummer only in a data context (for example a keyword such as `orgnr`, a table row, a `key: value` line or a code block), the script's own rule for pages. The workflow copies it and the script into the image under `/app/nais-skanner/`, and checks that it loads there. |
| Tests | `bun test scripts/ build/` runs the script's and the answer scanner's tests (no install step; Bun only). |
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

From a laptop, `make deploy` does the whole round: it resolves muninn
`main` to a SHA, checks the upstream pin before dispatching, watches the run
and then checks that the deployment's `MUNINN_REF` is that SHA and that the
pod is ready. The ingress itself cannot be checked from outside on
`ansatt.nav.no`: the domain answers every host with its own login, so the
script says so and you open `/chat` in a browser. `make deploy-sjekk` runs
only the pre-dispatch checks — the ref, the upstream pin, and a read of the
running deployment's `MUNINN_REF` — and starts nothing.
To
deploy a specific tag or SHA, run `scripts/deploy.sh <tag|sha>` (prefix
`DRY_RUN=1` to check only); the make targets take no ref. It needs `gh`, `jq`,
`kubectl` on context `prod-gcp` and naisdevice.

A muninn ref whose migration adds a table crash-loops on rollout until
`nais/migrate-job.yaml` has run with the new image, so expect a short outage.
The only prod deploy run so far shipped muninn `8ae738bf`; if prod still runs
it, the next deploy of a ref at or after 082 is missing two tables:
`summary_factchecks` (079) and `wiki_answers` (082). `docs/db-setup.md` has
how to read the ref prod runs, and the order: deploy, let the pod crash-loop,
then run the job with the image the Deployment names.

Before the first deploy, work through **`docs/PREREQUISITES.md`**. §1–§10 are
ten items and each one alone makes the pod useless; §0 is not one of them, it
is a proof to run *before* buying the expensive ones. The slowest is not
engineering work at all: the Entra app registration with admin consent. The
model question is **answered** — Gemini 2.5 Flash in `europe-north1` over
Vertex's OpenAI-compatible endpoint — and what remains of it is which GCP
project owns the quota.

## What this pod is

- **prod-gcp, as `melosys-muninn`**, with its own Entra group in tenant
  `nav.no`. It ran in dev-gcp as `melosys-muninn-q2` until 2026-10. Colleague
  chat content is personopplysninger; see `SECURITY.md` for what is still
  open.
- **One ingress**, on `ansatt.nav.no`. `MUNINN_ALLOWED_ORIGINS` is derived
  from it rather than maintained beside it. That domain authenticates through
  a single shared SSO client ahead of the sidecar, so whether this app's group
  gate takes part in the login has to be checked once after the first deploy —
  `docs/PREREQUISITES.md` §4 has the test.
- **The dev deployment is not managed from here any more.** `melosys-muninn-q2`
  in dev-gcp, its Cloud SQL instance (colleague chat content), the
  `melosys-felles-wiki-q2` bucket and its admin secret keep running until
  someone deletes them. Pages in the dev bucket are not copied to the prod one;
  republish them with `scripts/publiser-felles-wiki.ts`.
- **Chat, plus one read-only wiki.** `MUNINN_PROFILE=nais` drops fourteen
  route groups; the plans board, the capture verticals and the logs page are
  not registered. What is left is `/chat`, the operator dashboard, two health
  paths and — on a muninn ref that carries it — the read-only felles-wiki
  prototype, mirrored from a private bucket. See `docs/PREREQUISITES.md`,
  "Felles-wiki (prototype)".
- **One human at a time in the identity sense**: every request carries an Entra
  token, introspected through the Texas sidecar. There is no loopback bypass and
  no pinned identity in this mode.
- **No knowledge tools.** huginn is not on nais in v1. The bot's persona says so
  — see `docs/bot-folder-notes.md`.
