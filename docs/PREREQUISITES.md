# What the team has to supply before this deploys

Everything below is either a NAV provisioning action or a decision that is not
an engineering call. **Each one alone makes the pod useless**, which is why they
are a checklist and not a list of nice-to-haves. Nothing here can be invented
from the muninn side.

`nais/vars-q2.json` carries a `REPLACE_ME_` placeholder for most of them, and
the deploy workflow refuses to run while any placeholder survives — a
half-filled file is the failure mode that deploys something almost-right and
quietly.

**Do not work this list by hunting `REPLACE_ME`s.** Most of these sections are
actions or decisions rather than values, and they include the two slowest things
on the list:

- **§1** — an application registration and its admin consent. The longest pole
  in the schedule, and nothing in any file marks it.
- **§10** — a Kubernetes secret created in the namespace. A cluster action.
- **§5** — no value of its own by design, and it says so in its own first line;
  the oid list it describes lives in §10's secret.
- **§6** — Cloud SQL plus the schema run. Its three `db_*` keys already carry
  working defaults, so no placeholder draws attention to it.
- **§7** — the model, decided; the value lives in the bot folder, not here.
- **§9** — a slug in the workflow, plus registry and deploy-identity access.
- **§0** — a proof to run, not a value at all.

That leaves §2, §3, §4 and §8 as the sections that *are* values you fill in
`vars-q2.json` — and **two placeholders belong to no section at all**:
`REPLACE_ME_namespace` and `REPLACE_ME_team`. Both are the team's own nais
namespace and team slug, both come from the same place every other
`navikt`/`teammelosys` repo gets them (`melosys-console`'s own vars file is the
precedent), and both block every deploy. They are named here because a reader
working section by section would otherwise never be told where to get them.

**This repo is public**, so two rules apply to what is written down here.
*Values*: the infrastructure names — namespace, team, ingresses, tenant, project,
region — are public by the hundred across `navikt`, and the one value that is
about **people** (the admin `oid` list) has been moved out into a secret (§5,
§10). *Owners*: **every** `Owner:` line below is a GitHub team handle, never a
personal name. Filling them in with colleagues' names would publish an internal
responsibility map — who owns Entra consent, who owns the admin allowlist, who
owns Cloud SQL — which is the same disclosure in prose that `admin_oids` was in
JSON. Keep a personal name in an internal doc if the team wants one. There is no
exempt slot; a count here would only invite one.

---

## 0. Step zero — prove the WebSocket first

**Before buying any of the rest**, deploy a stub and prove that a WebSocket
upgrade round-trips through the ingress *and* the wonderwall sidecar. The socket
is the only channel a chat-only pod has; if it does not survive the sidecar,
nothing below matters.

It is first but it is not free: proving it *through the sidecar* needs
**§1, §2, §3 and §4** already in place, because `autoLogin` refuses an
unauthenticated upgrade at the sidecar and it never reaches the app. §1 is in
that list deliberately — an earlier draft of this paragraph said "§2, §3 and
§4", but the login `autoLogin` performs runs against the app registration and
its **admin consent**, so leaving §1 out describes a step zero that cannot get
past the sidecar at all. It also needs the registry and deploy-identity half of
**§9** to push and apply the stub — but *not* §6 (Cloud SQL), §7 (the GCP
project and Vertex quota) or §8 (egress), which is the whole point of running it
first.

`scripts/wonderwall-ws-harness.sh` in the muninn repo established the header
behaviour locally — a WS upgrade does arrive carrying `Authorization: Bearer`,
and the session cookie is `SameSite=Lax`. The ingress is the untested half.

**Everything step zero needs is in this repo**: `build/echo/` (the WebSocket
echo image), `nais/step-zero/` (the stub `Application` and its own seven-value
vars file) and `.github/workflows/step-zero.yml`, which builds the image,
pushes it and applies the stub in one `workflow_dispatch`. Fill
`vars-step-zero.json` and dispatch it. There is deliberately **no by-hand
path** — the deploy identity below is federated inside GitHub Actions and no
human holds a credential for it. See `step-zero-websocket.md` for what to look
for once it is up.

---

## 1. An Entra app registration, with admin consent

Owner: **@navikt/teammelosys**

The nais manifest asks for it (`azure.application.enabled: true`), but consent is
a directory action. Two claim requests ride along and both are already in
`nais/app.yaml`:

- **`claims.extra: ["NAVident"]`.** Entra emits `NAVident` only for an app that
  asks — melosys-console does not, which is exactly why its own `velgUserId`
  treats it as a third-choice fallback. Without it muninn mints user ids from
  `oid`: login still works, admin still resolves (role matching covers `oid`
  too), but every id and display name becomes unreadable and there is no
  backfill.
- **`claims.groups`** — the group id from §2, for the day role resolution moves
  off the env allowlist.

## 2. A group, and the decision that it is the gate

Value: `group_muninn_bruker` — an object id (UUID).
Owner: **@navikt/teammelosys**

`allowAllUsers: false` plus one team group, exactly as melosys-console. This is
load-bearing in a way worth stating: **muninn has no in-app login allowlist.**
The sidecar group is the only thing deciding who may reach the app at all.
`MUNINN_ADMIN_IDENTS` is a second axis on top (who is an operator), never a
second gate at the door.

## 3. The tenant

Value: `tenant` — e.g. the directory melosys-console names in its own vars.
Owner: **@navikt/teammelosys**

Used twice, and they are different uses: the sidecar's
`azure.application.tenant` (which really does select a directory) and muninn's
`MUNINN_TENANT`, which is written verbatim into `user_identities.tenant` as
**provenance** and is deliberately never compared against a token's own `tid` —
Texas is the authority on which directory it introspected, and a config value
overruling it would be a second, weaker check in front of the real one.

## 4. The ingress hostnames — TWO of them

Values: `ingress_intern` and `ingress_ansatt` — full `https://…` URLs.
Owner: **@navikt/teammelosys**

**Supply two hostnames, not one.** This is the shape `melosys-console` already
serves, and its reason is not cosmetic: `intern.dev.nav.no` requires naisdevice,
so a team member **without developer access** reaches the app only through
`ansatt.dev.nav.no`. Both feed `spec.ingresses`.

They are used a second time, and the second use is the one that bites.
`MUNINN_ALLOWED_ORIGINS` is **derived** from the pair in `nais/app.yaml`
(`value: "{{ ingress_intern }},{{ ingress_ansatt }}"`), and that variable stops
the pod in two different ways:

- an authenticating mode **refuses to boot** on an empty value, and
- the origin check compares `Origin` against this list and **never** against the
  request's own `Host` — deliberately, as a DNS-rebinding fix — so a
  *same-origin* POST from the deployed page is refused unless that page's origin
  is listed **verbatim, scheme included**. The same list gates `/chat/ws`.

A wrong value here is a pod that loads the chat page and fails every write, with
no error that names the cause. **A missing second value has exactly that
symptom for exactly half the team**: everyone arriving on the ansatt domain.

There is deliberately **no third `allowed_origins` variable**. One would
reproduce the bug it looks like it prevents — a third ingress, or a hostname
correction, updates two values and leaves the third stale, with the same silent
symptom. Give the two hostnames; the origin list follows from them.

## 5. Admin identities — a namespace secret, not a variable

Value: **none in this repo.** `MUNINN_ADMIN_IDENTS` comes from the nais secret
named by `admin_secret` in `nais/vars-q2.json`. See §10 for creating it.
Owner: **@navikt/teammelosys**

This used to be `admin_oids` in the vars file. It is the one *value* in this
repo that is about people rather than infrastructure — an `oid` is a **stable
personal identifier for a named human** in the directory — and this repo is
public, so it moved into a secret. Nothing else here changed: it is still a
comma-separated list, still matched case-insensitively, still a second axis on
top of the group in §2 (who is an operator) and never a second gate at the door.

⚠️ **Use `oid` values, not NAVidents.** A NAVident is re-issued when someone
leaves, so the newcomer who inherits it would resolve to `admin` on their first
login. `user_identities` is keyed on `oid` and refuses to adopt the account, but
this allowlist has no such protection. Role matching accepts either, so nothing
forces the safe choice — this line is the only thing that does.

The durable answer is not a better-curated list: resolve the admin role from the
**`groups` claim** the manifest already requests, and then no personal
identifier exists in any deploy artifact, secret or otherwise. That is a change
in muninn, not here.

## 6. Cloud SQL, and a schema step with the actor named on every line

Owner: **@navikt/teammelosys**

The full runbook is `db-setup.md`. The short version, and the reason it is not
automated: **the nais app user cannot create extensions**, and `db/init.sql`
line 5 is `CREATE EXTENSION IF NOT EXISTS vector`. Ordered, with the actor named
on each step because getting the middle one wrong fails *silently*:

1. Declare the instance in the manifest and apply it.
2. Superuser reset (the `navikt/kbs-guide` procedure).
3. `CREATE EXTENSION vector` — **elevated role, this step only.**
4. `bun db/provision.ts --yes` — **as the app user.** Applies `db/init.sql` and
   baselines in one command, from the image (muninn #486; the pinned muninn ref
   must contain it). If the elevated role runs it, the
   app user ends up without ownership of any of init.sql's 33 tables and the
   pod gets permission-denied at first query rather than a clear schema error.

Step 4 is two things in one command: apply the consolidated schema, then
*mark-applied* every shipped migration. Without the second half, migrations 006
onwards re-run over a schema that already carries them and the pod crash-loops.

The entrypoint attempts none of these. It refuses an unprovisioned *and* an
unbaselined database and prints remedies that are executable in the state that
prints them — which became true with muninn #486; before it, the remedy for an
empty database named `psql`, which the image does not ship and which no machine
can run against a private-IP instance.

Sequencing note: the instance does not exist until the manifest is applied, so
either deploy once expecting a crash-loop, or scale to zero replicas first.

## 7. The model — decided, with one procurement question left

Owner: **@navikt/teammelosys** · Decision: **Team KI** (the region and model half is answered)

There is no model credential in this repo at all. The pod authenticates to
**GCP Vertex AI** with its own workload-identity service account, so the ROS
line is about a *region* and a *model*, not about whose token it is.

**Measured 2026-08-28 and decided: Gemini 2.5 Flash in `europe-north1`, over the
OpenAI-compatible Vertex endpoint.** The path that this file used to describe —
`connector: "claude-sdk"` plus `CLAUDE_CODE_USE_VERTEX=1` — is **dropped**, and
not for a code reason: `europe-north1` carries **zero** Claude models, and every
Claude is reachable only through the `eu` multi-region endpoint at quota zero.
The full measurement is in the mimir plan `muninn-nav-vertex-models`.

So `bots/melosys/config.json` reads:

```json
"connector": "openai-compat",
"model": "google/gemini-2.5-flash",
"baseUrl": "https://<region>-aiplatform.googleapis.com/v1/projects/<project>/locations/<region>/endpoints/openapi"
```

Three things about that are load-bearing:

- **The `google/` publisher prefix is required.** Vertex answers `400` without it.
- **The `baseUrl` is written by the deploy workflow**, from `gcp_project` and
  `vertex_region`, into the copy of the bot folder it overlays. It is checked in
  as `REPLACE_ME_vertex_baseurl` so that a removed or non-matching assign is
  caught by the placeholder grep instead of shipping a bot with no `baseUrl`.
  **Do not fill it in by hand** — see §8.
- **`thinkingMaxTokens: 16000` is not a thinking budget on this connector.** On
  `openai-compat` it is `max_tokens` for the whole response — Gemini's reasoning
  tokens and the answer share it. And `openai-compat` never inspects
  `finish_reason`: a response that exhausts the budget is returned as an
  ordinary answer, with nothing in the trace saying why it stopped. That is why
  acceptance asserts a *whole* answer rather than "a reply arrived".

What is still open, and it is procurement rather than engineering:

1. **Which GCP project owns the Vertex quota**, and is pay-as-you-go enough?
2. **Does the pod's own workload-identity SA need `roles/aiplatform.user` on
   its own nais project, or on a separate team project that owns the quota?**
   nais documents `gcp.permissions` as being for resources *not* provisioned
   through nais. Unverified — a question for nais/Team KI.

Team KI's `eu`-multi-region question does **not** block this deploy. It only
ever gated Claude, and Claude is dropped. It stays open for a future model
change — which is why nothing here hardcodes one of the two Vertex host shapes.

## 8. Egress, and the texas annotation

Values: `gcp_project`, `vertex_region`. **There is no `vertex_host` to supply** —
the egress host is derived by the deploy workflow from those two and passed to
`nais/deploy` as a `VAR`. Do not add the key back: left in as a `REPLACE_ME` the
first run hard-fails on it, and filled in by hand the computed `VAR` silently
overrides it — which is the duplicate-value failure the derivation exists to
remove, rebuilt.
Owner: **@navikt/teammelosys**

nais egress is default-deny, so every external host is enumerated. Four notes:

- The model host is the only entry in `accessPolicy.outbound.external` today,
  and it is **computed, not maintained**. Vertex has two host shapes —
  `<region>-aiplatform.googleapis.com` for a region,
  `aiplatform.<mr>.rep.googleapis.com` for a multi-region — and the workflow
  applies muninn's own rule (a hyphen in the location means the first form).
  A hardcoded copy of one shape is an allowlist naming a host nothing dials the
  day the other is needed, which is not hypothetical: `eu` is where every Claude
  lives. Whether Vertex traffic needs an egress entry at all, or routes over
  Google-private paths, is **unverified** — a question for nais/Team KI rather
  than something to assume. Listing it costs nothing and fails closed.
- **The credential hop is not in that list, deliberately.** Application Default
  Credentials are fetched from `http://metadata.google.internal/computeMetadata/v1/…`
  on a 700 ms budget. The assumption is that GKE metadata is node-local and
  therefore outside `accessPolicy` altogether. Write it down rather than
  rediscover it: the fallback when that fetch fails is the **`gcloud` CLI**,
  which this image does not carry under any build arg (`WITH_CLI` gates the
  *Claude* CLI installer; the Google Cloud SDK is never installed), so the
  failure surfaces as an error message telling an operator to run
  `gcloud auth application-default login` — nonsense inside a pod, and pointing
  away from the real cause.
- `texas.nais.io/enabled: "true"` is already set. Without it
  `NAIS_TOKEN_INTROSPECTION_ENDPOINT` is never injected and muninn's boot assert
  fires — a refusal, not a crash, but the pod does not start.
- The embedding model is **baked into the image** (`WITH_EMBEDDINGS=true`), so it
  needs no runtime egress host. That is deliberate: `warmupEmbeddings()` catches
  its own failure, so a pod that cannot reach the model host looks healthy while
  every memory search silently returns nothing. The requirement moves to the
  *builder*, which needs egress to huggingface.co at build time.

## 9. The registry and the deploy identity

Values: the team's GAR access, and `MUNINN_REPO` in `.github/workflows/deploy.yml`.
Owner: **@navikt/teammelosys**

The push is wired: `nais/docker-build-push@v0` does the `nais/login`, names the
image and pushes it, and `nais/deploy/actions/deploy@v2` applies the manifest.
Two things still have to exist outside this repo.

- **The team's registry and deploy identity.** `melosys-console`'s precedent is
  `europe-north1-docker.pkg.dev/nais-management-233d/<team>`; the action derives
  that path itself from the `team` input, which the workflow reads out of
  `vars-q2.json` rather than hardcoding — a hardcoded copy beside the file's own
  `team` value would push to one team's GAR and label the app with another.
  Nothing here needs a token: the workflow declares `id-token: write` at
  **workflow** level and `nais/login` federates. ⚠️ That is also why there is
  no by-hand deploy anywhere in this repo, including step zero: this identity
  exists **inside a workflow run** and a human at a laptop cannot present it.

  Note the **image is named after this repo**, lowercased — the repo is
  `navikt/melosys-muninn`, so it is `…/<team>/melosys-muninn`, not
  `…/<team>/muninn`. Step zero's echo image lands in the same repo-named path
  and is told apart by its `echo-<sha>` tag.

- **`MUNINN_REPO`** — the `owner/repo` slug of PUBLIC muninn. It is still a
  placeholder, and the workflow refuses on it before it queries anything.

  The dispatch input accepts **a tag that exists upstream, or a 40-character
  commit SHA**, and the two arms are checked differently — worth knowing,
  because only one of them consults the remote. The workflow fetches the ref
  list once and compares exact fields: a value matching `refs/heads/<it>` is
  refused as a branch, and a TAG is accepted only if `refs/tags/<it>` is
  actually there. A **SHA is accepted on SHAPE alone** (40 hex, either case) —
  nothing can ask a remote whether an arbitrary commit exists without fetching
  it, so a typo'd SHA passes this step and fails inside `actions/checkout`.
  A branch, a `refs/heads/…` spelling, a glob and a short SHA are all refused.

  Measured 2026-08-29: public muninn carries **no tags at all**, so until
  someone tags it, a commit SHA is the only value the first deploy can be
  given — which is also why the SHA arm accepts upper case.

Two properties of that pipeline worth knowing before someone "simplifies" them:

1. **The image is asserted BEFORE it is pushed.** The action is called twice —
   once with `push_image: "false"` and `outputs: type=docker`, which loads the
   image into the runner's daemon for three assertion steps (the bot set, the
   absent CLI and ffmpeg, the embedding weights), and once to push from the
   shared cache. A bad image therefore never reaches GAR. The two calls repeat
   `team`, `docker_context`, `build_args`, `tag` and `salsa` verbatim — that
   identity is the only thing tying the asserted image to the pushed one — and
   differ in exactly three inputs, all deliberate: `push_image`, `outputs`, and
   `pull`, which the push call turns off so a base image republished between
   them cannot substitute an uninspected build. That last one **narrows the
   window rather than closing it**, and nothing in the pipeline can detect it
   regressing; the shape that would close it is the fallback third job, which
   pulls the pushed image and re-runs the assertions against it.
2. **A deploy names the muninn commit it shipped.** The dispatched ref is
   resolved to a SHA right after the checkout, and that SHA becomes both a GAR
   tag (`muninn-<sha>`) and the pod's `MUNINN_REF`. The deployed `Application`'s
   `image` field is *not* the place to read it: the action's default date-sha tag
   outranks a custom one (priority 9002 vs 9001), so that field names the
   date-sha.

## 10. The `MUNINN_ADMIN_IDENTS` secret

Value: a Kubernetes secret in the namespace, named by `admin_secret` in
`nais/vars-q2.json` (`melosys-muninn-q2-admin-idents`), carrying **one key,
spelled exactly `MUNINN_ADMIN_IDENTS`**, whose value is the comma-separated oid
list from §5.
Owner: **@navikt/teammelosys**

This is the only prerequisite that is a *cluster action rather than a value*,
and it exists because the repo is public (§5). `nais/app.yaml` mounts it with

```yaml
envFrom:
  - secret: {{ admin_secret }}
```

Three things about it, each of which has a distinct failure:

- **The key name is not free.** `envFrom` injects a secret's keys verbatim as
  environment variables, so a key called `admin_oids` or `ADMIN_IDENTS` produces
  a pod with no `MUNINN_ADMIN_IDENTS` at all.
- **The two half-done states fail differently, and telling them apart is the
  difference between looking at the cluster and looking at the code.** An
  **absent** secret never reaches muninn: the kubelet reports
  `CreateContainerConfigError` and there is no application log. A secret that
  exists with a wrong or empty key does reach muninn, and its boot assert
  refuses to start with a message naming the variable — `MUNINN_AUTH="entra"`
  requires a non-empty list, because in that mode it *is* the role source.
- **An empty list is not a safe default.** It does not mean "no admins"
  in a useful sense; it means the boot refuses. Set it to at least one oid.

It gates the **first deploy**, not the push: publishing the repo needs only the
file half of this change (`admin_oids` gone, `envFrom` in).

---

## Not prerequisites, but decided

- **v1 stops at dev-gcp.** Prod carries a personopplysninger decision that is not
  an engineering call.
- **Chat-only.** No huginn on nais in v1, so the bot has no knowledge tools and
  its persona says so. See `bot-folder-notes.md` §4.
- **One replica, `Recreate`.** A correctness constraint, not capacity — see the
  comment in `nais/app.yaml`.
- **No scheduler, no watchers.** They start only for bots with platform tokens,
  and this bot has none. Do not add `SCHEDULER_ENABLED`.
- **Colleague chat content is personopplysninger, and lands in two stores** —
  `messages` and `activity_log`, both in Cloud SQL, keyed to a NAVident. The
  `nais` profile drops the log line that used to preview message text at `info`;
  the `activity_log` copy is admin-zone by design. Retention is **not** answered
  here and should be before colleagues are invited. This is the item that keeps
  v1 at dev.

  **Two stores, and the manifest is what makes that true.** muninn's file sink
  defaults to a daily-rotating JSONL under `./logs`, so without `LOG_DIR=none`
  there would be a THIRD copy on the container filesystem — bounded only by its
  own 7-day rotation, on a pod with no volume, and carrying message previews
  from the handlers the `nais` profile's `info`→`debug` demotion does not cover
  (it demotes `src/core/message-processor.ts` only; the Slack, voice and
  response handlers log previews of their own). `nais/app.yaml` sets it. Nothing
  is lost: the console sink still goes to the platform's log aggregator, and the
  `/api/logs*` route group is not registered on this profile anyway, so nothing
  could read the file.
