# What the team has to supply before this deploys

Everything below is either a NAV provisioning action or a decision that is not
an engineering call. **Each one alone makes the pod useless**, which is why they
are a checklist and not a list of nice-to-haves. Nothing here can be invented
from the muninn side, and none of these values may ever land in the public
muninn repo.

`nais/vars-dev.json` carries a `REPLACE_ME_` placeholder for each. The deploy
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

## 4. The ingress hostname

Value: `ingress` — the full `https://…` URL.
Owner: **REPLACE_ME**

It is used **twice from one variable**, and the second use is the one that bites.
Besides `spec.ingresses`, it is `MUNINN_ALLOWED_ORIGINS`, and that stops the pod
in two different ways:

- an authenticating mode **refuses to boot** on an empty value, and
- the origin check compares `Origin` against this list and **never** against the
  request's own `Host` — deliberately, as a DNS-rebinding fix — so a
  *same-origin* POST from the deployed page is refused unless the ingress origin
  is listed **verbatim, scheme included**. The same list gates `/chat/ws`.

A wrong value here is a pod that loads the chat page and fails every write, with
no error that names the cause.

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

## 7. The model — OPEN, and the one item that can stall this

Owner: **REPLACE_ME** · Decision: **Team KI**

This is no longer "a personal Copilot token in a nais secret with an owner and
an expiry". Team KI's guidance points at **GCP Vertex AI**, which the pod
authenticates to with its own workload-identity service account — so there is no
model credential in this repo at all, and the ROS line changes shape: it is
about a *region* and a *model*, not about whose token it is.

`nais/app.yaml` already carries the lever (`gcp.permissions` →
`roles/aiplatform.user`) and the env (`CLAUDE_CODE_USE_VERTEX`,
`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`). What is missing is the answer
to a measured conflict, documented in full in the mimir plan
`muninn-nav-vertex-models`:

> **Claude is not available in `europe-north1` at all.** Gemini 2.5 is. Claude
> 4.6 exists in `europe-west1`; Claude 5 only on the `eu` multi-region endpoint.
> The guidance recommends the nais region and forbids `global`, but does not say
> whether `eu` multi-region counts as an EU/EØS region.

So three questions, in the order that unblocks the most:

1. Is `europe-west1` acceptable when `europe-north1` does not have the model?
2. Does the `eu` multi-region endpoint count as an EU/EØS region?
3. Which GCP project owns the quota, and is pay-as-you-go enough?

**And one engineering caveat that is not in the manifest's power to fix:** the
zero-code Vertex path (`connector: "claude-sdk"` + `CLAUDE_CODE_USE_VERTEX=1`) is
blocked today by `assertHaveAuth()` in `src/ai/connectors/claude-sdk.ts`, which
requires `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and throws before the
SDK — which needs neither on Vertex — is ever reached. That is a one-line change
in public muninn (`muninn-nav-vertex-models` PR 5), and it must land before this
bot answers anything.

## 8. Egress, and the texas annotation

Value: `vertex_host`, `gcp_project`.
Owner: **REPLACE_ME**

nais egress is default-deny, so every external host is enumerated. Three notes:

- The model host is the only entry in `accessPolicy.outbound.external` today.
  Whether Vertex traffic needs one at all, or routes over Google-private paths,
  is **unverified** — a question for nais/Team KI rather than something to
  assume.
- `texas.nais.io/enabled: "true"` is already set. Without it
  `NAIS_TOKEN_INTROSPECTION_ENDPOINT` is never injected and muninn's boot assert
  fires — a refusal, not a crash, but the pod does not start.
- The embedding model is **baked into the image** (`WITH_EMBEDDINGS=true`), so it
  needs no runtime egress host. That is deliberate: `warmupEmbeddings()` catches
  its own failure, so a pod that cannot reach the model host looks healthy while
  every memory search silently returns nothing. The requirement moves to the
  *builder*, which needs egress to huggingface.co at build time.

## 9. The registry and the deploy identity

Values: the GAR path, and `MUNINN_REPO` in `.github/workflows/deploy.yml`.
Owner: **REPLACE_ME**

melosys-console's precedent is
`europe-north1-docker.pkg.dev/nais-management-233d/<team>`. The workflow has an
explicit `exit 1` where the push belongs, so a half-wired deploy fails at the
push rather than deploying a stale image.

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
