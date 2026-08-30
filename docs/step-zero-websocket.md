# Step zero: prove the WebSocket through the ingress

A chat-only muninn has exactly one channel for a turn: `/chat/ws`. Everything
else on the page is a fetch that could, at a pinch, be worked around. The socket
cannot. So this is the first thing to prove and the reason to prove it before
buying anything expensive.

## What is already known

`scripts/wonderwall-ws-harness.sh` in the muninn repo established two facts
locally, and they are load-bearing:

- a WebSocket upgrade through wonderwall **does** arrive at the app carrying
  `Authorization: Bearer …`, and
- wonderwall's session cookie is sent `SameSite=Lax`.

That matters because **muninn mints no session cookie in `entra` mode** —
`writeSessionCookie` returns early when there is no local config. The socket is
authenticated from the Bearer channel or not at all.

## What is not known

The ingress. wonderwall proxying an upgrade on a developer's machine is not the
same as an nginx ingress controller doing it in dev-gcp, and this is the half
that has surprised people before.

## The catch

Step zero is first but it is **not free**. Proving the upgrade *through the
sidecar* requires §1–§4 of `PREREQUISITES.md` already in place — the app
registration, admin consent, the group and **both** ingresses — because `autoLogin`
refuses an unauthenticated upgrade **at the sidecar**, and it never reaches the
app at all. The harness measured exactly that locally.

So the sequence is:

1. Buy §1–§4 (app registration + consent + group + the two ingresses).
2. Deploy a **stub** `Application` — same `app_name`, same `azure` block, same
   sidecar settings and ingresses — by dispatching `.github/workflows/step-zero.yml`,
   which is **outside** the placeholder-guarded deploy workflow.
3. Only then can the upgrade be attempted end to end.

**It must be a stub, and it must be a WebSocket echo server.** Two shortcuts
look available here and neither is:

- *"Deploy this image with a database that is not yet provisioned."* Dead. The
  entrypoint runs under `set -eu` and calls `bun db/require-provisioned.ts`
  **before** the server starts, so an unprovisioned pod exits rather than
  degrading. There is no `/api/live`, no upstream behind the ingress, and a
  `/chat/ws` upgrade cannot reach the app at all — the proof would prove nothing.
- *"Any hello-world image will do."* No: a plain HTTP server answers an upgrade
  request as an ordinary request, which is one of the failure signatures below.
  A hello-world stub reports the very failure it is meant to detect. It has to
  echo, which means an image in an allowed registry — the team GAR.
  `step-zero.yml` builds and pushes it; that is still a real cost in a build and
  a stored image, it is just not a manual one.

**Both artifacts are in this repo — you do not have to write them.**

| What | Where |
|---|---|
| The echo server + its Dockerfile | `build/echo/` |
| The stub `Application` | `nais/step-zero/stub.yaml` + `nais/step-zero/vars-step-zero.json` |
| The thing that runs them | `.github/workflows/step-zero.yml` |

**How to run it: fill `nais/step-zero/vars-step-zero.json`, then dispatch
`step-zero` from the Actions tab.** One dispatch builds the echo image, pushes
it to the team GAR and applies the stub.

There is **no by-hand path, and do not go looking for one.** An earlier draft of
this page gave a command — `RESOURCE=… VARS=… CLUSTER=dev-gcp nais/deploy` —
and it was wrong twice over. `nais/deploy` is a *GitHub Action* path
(`nais/deploy/actions/deploy@v2`), not a binary: a shell resolves the slash as a
path and answers `no such file or directory`, exit 127. The installed `nais`
CLI has no `deploy` subcommand at all, and its `apply` takes no `--vars-file`,
so it cannot render this manifest's `{{ }}` tokens. And the identity that draft
told you to authenticate — §9's — is `id-token: write` federated **inside GitHub
Actions**; no human holds a credential for it. Step zero runs where the identity
already is.

`step-zero.yml` is separate from `deploy.yml` for one reason: `deploy.yml`
refuses while any `REPLACE_ME` survives in `vars-q2.json`, and `gcp_project` /
`vertex_region` are still placeholders at this point in the schedule.
`step-zero.yml` reads `vars-step-zero.json` instead, which carries only what
§1–§4 already bought.

**The seven values in `vars-step-zero.json` are a subset of `vars-q2.json`, and
must be identical in both files** — `app_name`, `namespace`, `team`, `tenant`,
`group_muninn_bruker` and the two ingresses. Nothing compares the two files for
you; they are separate precisely so step zero need not wait on `gcp_project` and
`vertex_region`, and the cost of that is a copy nobody checks. Get one wrong and
step zero proves the upgrade for a different app than the one that is deployed.

The echo image reference is **not** one of them — it does not exist until the
workflow's own build has run, which is why the workflow hands it to
`nais/deploy` rather than reading it from the file.

The stub is **replaced** by the first real deploy — same `app_name`, so it is
an update rather than a second Application.

And the stub must carry the **same `app_name` as the real app**: nais provisions
one Entra application registration per `Application`, so a differently-named stub
needs its own registration and its own admin consent — the slowest procurement
item, done twice — and two `Application`s cannot both claim one ingress host
anyway. The first real deploy then replaces it.

There is no shortcut that proves the sidecar half without the login half.

## How to check it

Open the ingress in a browser and complete the wonderwall login, then open a
WebSocket to the stub's echo path from the page's own origin (the browser
console is enough) and watch the network panel. Do this from **both** ingress
domains. What you are looking for, in order:

- **101 Switching Protocols.** A 401 means the token did not arrive; a 200 with
  an HTML body means something in the path answered the upgrade as an ordinary
  request.
- **The socket survives past ~60s with no application traffic.** An ingress that
  closes long-lived upgrades turns every long turn into a dropped answer.
  muninn's client retries in ~2 s, but the turn in flight does not come back.

  It **is** a genuine idle test at that timescale, and an earlier version of
  this page said twice that it could not be. Measured on the wire, decoding
  opcode 9 with a client that never pongs:

  | | first server PING | closed |
  |---|---|---|
  | the stub, as shipped | t=104.0 s | t=120.0 s |
  | + `websocket.idleTimeout: 255` | none | still open past t=150 s |

  Nothing is sent in either direction between the greeting at t=0 and that
  first ping at ~104 s, so across the ~60 s window the connection is idle. If
  the socket dies at 60 s, **that is the ingress** — the single most important
  result step zero can produce. There is no keepalive explanation available at
  that timescale; do not go looking for one.

  **And the stub matches muninn here.** muninn sets `idleTimeout: 255` at the
  *server* level (`src/index.ts`, ref `21b436b`, for SSE) and sets no
  `websocket.idleTimeout` — and the second row shows the websocket-level value
  is the one that governs. So both run Bun's websocket default and whatever the
  ingress does to this socket it will do to muninn's. An earlier revision of
  this page denied that parity; it was conflating the two settings. The day
  muninn sets `websocket.idleTimeout`, the parity breaks and nothing here will
  notice.

A third check — *a turn completes over it*, a message in and a streamed reply
out — is **not** part of step zero. An echo stub cannot answer one, and it needs
the model and the database, i.e. everything step zero exists to avoid buying
first. It belongs to acceptance, after the first real deploy.

## The ways this fails that are not the ingress

Rule these out before blaming the proxy. **They are about the STUB** — an
earlier draft of this list described muninn instead, which is worse than no
list: it would have you checking a variable and a model credential that step
zero does not deploy, at the exact moment the transport really had failed.

1. **You are not in the group.** `allowAllUsers: false` plus
   `claims.groups` means the sidecar refuses the login itself, and a refused
   login looks a lot like a refused upgrade. Confirm you land on the stub at all
   before concluding anything about the socket.
2. **The two vars files disagree.** `app_name` or an ingress differing between
   `vars-step-zero.json` and `vars-q2.json` means the stub is proving the
   upgrade for a different app than the one that will be deployed. Nothing
   checks this; diff them.
3. **`Recreate` + one replica.** Every rollout drops every socket, by design. A
   reconnect right after a re-dispatch is not a bug. (This item was carried over
   from the muninn-describing draft while `stub.yaml` declared no `strategy` at
   all — so nais defaulted it to RollingUpdate and the sentence was false of
   what was deployed. `stub.yaml` now carries `strategy: Recreate`, matching the
   real app, which is also what stops a second echo pod flipping the ingress
   endpoint list mid-test.)
4. **The image did not pull.** `ImagePullBackOff` reads like a registry
   permission problem and usually is not. `step-zero.yml` now guards the
   placeholder case and asserts the pushed reference is digest-pinned, so what
   is left here is a genuine GAR permission question — `PREREQUISITES.md` §9.

**Two things that are NOT on this list, deliberately**, because the stub has
neither and reaching for them wastes the failure: `MUNINN_ALLOWED_ORIGINS`
(`stub.yaml` has no `env:` and no `envFrom:`, and the echo server performs no
origin check at all — it upgrades from any origin) and the model credential
(there is no bot, no model and no `gcp.permissions` here). Both become real for
the first *real* deploy, and both are in `PREREQUISITES.md` — §4 and §7.
