# What the team has to supply before this deploys

Everything below is either a NAV provisioning action or a decision that is not
an engineering call. **Each one alone makes the pod useless**, which is why they
are a checklist and not a list of nice-to-haves. Nothing here can be invented
from the muninn side, and none of these values may ever land in the public
muninn repo.

`nais/vars-q2.json` carries a `REPLACE_ME_` placeholder for each. The deploy
workflow refuses to run while any of them survives — a half-filled file is the
failure mode that deploys something almost-right and quietly.

---

## 0. Step zero — prove the WebSocket first

**Before buying any of the rest**, deploy a stub and prove that a WebSocket
upgrade round-trips through the ingress *and* the wonderwall sidecar. The socket
is the only channel a chat-only pod has; if it does not survive the sidecar,
nothing below matters.

It is first but it is not free: proving it *through the sidecar* needs §2, §3
and §4 already in place, because `autoLogin` refuses an unauthenticated upgrade
at the sidecar and it never reaches the app. `scripts/wonderwall-ws-harness.sh`
in the muninn repo established the header behaviour locally — a WS upgrade does
arrive carrying `Authorization: Bearer`, and the session cookie is `SameSite=Lax`.
The ingress is the untested half. See `step-zero-websocket.md`.

---

## 1. An Entra app registration, with admin consent

Owner: **REPLACE_ME**

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
Owner: **REPLACE_ME**

`allowAllUsers: false` plus one team group, exactly as melosys-console. This is
load-bearing in a way worth stating: **muninn has no in-app login allowlist.**
The sidecar group is the only thing deciding who may reach the app at all.
`MUNINN_ADMIN_IDENTS` is a second axis on top (who is an operator), never a
second gate at the door.

## 3. The tenant

Value: `tenant` — e.g. the directory melosys-console names in its own vars.
Owner: **REPLACE_ME**

Used twice, and they are different uses: the sidecar's
`azure.application.tenant` (which really does select a directory) and muninn's
`MUNINN_TENANT`, which is written verbatim into `user_identities.tenant` as
**provenance** and is deliberately never compared against a token's own `tid` —
Texas is the authority on which directory it introspected, and a config value
overruling it would be a second, weaker check in front of the real one.

## 4. The ingress hostnames — TWO of them

Values: `ingress_intern` and `ingress_ansatt` — full `https://…` URLs.
Owner: **REPLACE_ME**

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

## 5. Admin identities

Value: `admin_oids` — comma-separated.
Owner: **REPLACE_ME**

⚠️ **Use `oid` values, not NAVidents.** A NAVident is re-issued when someone
leaves, so the newcomer who inherits it would resolve to `admin` on their first
login. `user_identities` is keyed on `oid` and refuses to adopt the account, but
this allowlist has no such protection. Role matching accepts either, so nothing
forces the safe choice — this line is the only thing that does.

## 6. Cloud SQL, and a schema step with the actor named on every line

Owner: **REPLACE_ME**

The full runbook is `db-setup.md`. The short version, and the reason it is not
automated: **the nais app user cannot create extensions**, and `db/init.sql`
line 5 is `CREATE EXTENSION IF NOT EXISTS vector`. Ordered, with the actor named
on each step because getting the middle one wrong fails *silently*:

1. Declare the instance in the manifest and apply it.
2. Superuser reset (the `navikt/kbs-guide` procedure).
3. `CREATE EXTENSION vector` — **elevated role, this step only.**
4. Apply `db/init.sql` — **as the app user.** If the elevated role runs it, the
   app user ends up without ownership of ~20 tables and the pod gets
   permission-denied at first query rather than a clear schema error.
5. `bun db/migrate.ts --baseline` — **app user**; mark-applied, *not* apply, or
   migrations 006–074 re-run over the consolidated schema.

The entrypoint attempts none of these. It refuses an unprovisioned *and* an
unbaselined database and prints remedies that are executable in the state that
prints them.

Sequencing note: the instance does not exist until the manifest is applied, so
either deploy once expecting a crash-loop, or scale to zero replicas first.

## 7. The model — decided, with one procurement question left

Owner: **REPLACE_ME** · Decision: **Team KI** (the region and model half is answered)

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
Owner: **REPLACE_ME**

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
Owner: **REPLACE_ME**

The push is wired: `nais/docker-build-push@v0` does the `nais/login`, names the
image and pushes it, and `nais/deploy/actions/deploy@v2` applies the manifest.
Two things still have to exist outside this repo.

- **The team's registry and deploy identity.** `melosys-console`'s precedent is
  `europe-north1-docker.pkg.dev/nais-management-233d/<team>`; the action derives
  that path itself from the `team` input, which the workflow reads out of
  `vars-q2.json` rather than hardcoding — a hardcoded copy beside the file's own
  `team` value would push to one team's GAR and label the app with another.
  Nothing here needs a token: the workflow declares `id-token: write` at
  **workflow** level and `nais/login` federates.

  Note the **image is named after this repo**, lowercased — so it is
  `…/<team>/melosys-muninn`, not `…/<team>/muninn`.

- **`MUNINN_REPO`** — the `owner/repo` slug of PUBLIC muninn. It is still a
  placeholder, and the workflow refuses on it before it queries anything.

Two properties of that pipeline worth knowing before someone "simplifies" them:

1. **The image is asserted BEFORE it is pushed.** The action is called twice —
   once with `push_image: false` and `outputs: type=docker`, which loads the
   image into the runner's daemon for four `docker run` assertions, and once to
   push from the shared cache. A bad image therefore never reaches GAR. The two
   calls repeat `team`, `docker_context`, `build_args` and `tag` verbatim: that
   identity is the only thing tying the asserted image to the pushed one.
2. **A deploy names the muninn commit it shipped.** The dispatched ref is
   resolved to a SHA right after the checkout, and that SHA becomes both a GAR
   tag (`muninn-<sha>`) and the pod's `MUNINN_REF`. The deployed `Application`'s
   `image` field is *not* the place to read it: the action's default date-sha tag
   outranks a custom one (priority 9002 vs 9001), so that field names the
   date-sha.

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
