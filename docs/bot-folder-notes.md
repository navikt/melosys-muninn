# Why the nais bot folder looks the way it does

_Prose lives here rather than in `bots/melosys/` because an unknown key in
`config.json` warns at discovery and a stray file ships in the image._

Five things in here are not preferences. Each is the difference between a
working pod and a broken one, and none of them is visible from the file it
lives in.

## 1. The folder must exist at all

`bots/*` is gitignored in public muninn and only `bots/jarvis/` is tracked, so a
build from that repo contains no bot. `discoverAllBots()` finding zero folders
calls `process.exit(1)` — the failure is a CrashLoopBackOff, not an empty chat.
This folder is copied into the build context by `.github/workflows/deploy.yml`,
which also strips the `bots/` line out of the checkout's own `.dockerignore` —
**derived in the workflow, behind a `grep -q` that refuses if the line is not
there**, rather than checked in as a second copy of that file. An upstream
rename breaks the build instead of silently dropping an exclusion.

A bot needs only a `CLAUDE.md` to be discovered. Platform tokens (Telegram,
Slack) are what make it a *live bot*, and this one deliberately has none:
without them no scheduler starts and no watchers run, which is exactly what a
chat-only pod wants. **Do not add `SCHEDULER_ENABLED` to the manifest** without
re-reading that sentence.

## 2. `connector` must be pinned, and must not be `claude-cli`

`resolveConnector` falls back to `claude-cli` when a bot names no connector, and
the nais image is built `--build-arg WITH_CLI=false` — there is no `claude`
binary in it. muninn's `nais` profile refuses CLI spawns in `spawnHaiku`, which
covers the Haiku router, the watchers and the scheduler — but **not the chat
connector**. So an unpinned bot spawns a missing binary on every turn, and this
one line is the only thing standing between the pod and that. muninn's own boot
log says so.

## 3. `haikuBackend` must be pinned too — and `vertex` is the same endpoint as the turn

The default for a non-`copilot-sdk` bot is `cli`, which does not exist here.
`vertex` is set instead, and it reaches **the same approved Vertex endpoint the
chat turn does** — which was the whole compliance point of muninn #484. It needs
no addition to `accessPolicy.outbound.external`, and it defaults to
`google/gemini-2.5-flash-lite` (override with `HAIKU_VERTEX_MODEL`), measured
reachable in `europe-north1`.

An earlier version of this file pinned `anthropic` and argued the opposite way:
Haiku is almost never called on this pod (the three extractors are force-disabled
for an `entra` identity, the `research_knowledge` decomposer needs an MCP tool
that does not exist here — §4 — and the scheduler never starts, §1), so leaving
`api.anthropic.com` off the default-deny egress list would make an unexpected
call fail at the network rather than reach an unapproved provider.

That argument was sound and is now the weaker one, because **it rests on a
negative that a later config change breaks quietly**: the day huginn lands on
nais and `.mcp.json` gains the `research` entry, the decomposer starts calling
Haiku on every lookup and the `anthropic` pin becomes a hard failure in front of
a colleague. Correct-by-construction beats fails-closed-by-absence here.

Unlike the chat connector, this backend derives nothing from `baseUrl`:
`resolveVertexHaikuTarget` reads `ANTHROPIC_VERTEX_PROJECT_ID` **or**
`VERTEX_PROJECT_ID`, and `CLOUD_ML_REGION` **or** `VERTEX_REGION`. That is why
`nais/app.yaml` still carries two Vertex env variables after
`CLAUDE_CODE_USE_VERTEX` was deleted — they exist for this one consumer, under
muninn's own names, with the SDK's names left unset so the `claude-sdk` path
stays off.

## 4. `.mcp.json` has no servers, and that is the design

muninn's `research_knowledge` is a **proxy**: the in-process MCP server queries
huginn over HTTP at the bot's `knowledgeApiUrl`. huginn is not on nais in v1, so
shipping the tool would give the model something that connection-refuses on
every call — which the colleague sees as a stalled answer or a confident one
with no sources. Better to have no tool than a broken one.

The bot's persona (`CLAUDE.md`) must therefore SAY it has no source lookup in
this deployment. A model that believes it can search and cannot is the failure
mode this whole file is arranged against.

Two consequences worth knowing:

- The Jira composer's `Full` depth is unreachable (it requires the `code` and
  `yggdrasil` MCP servers). Its pre-flight fails cleanly, but the message reads
  "the server is down" rather than "not in this instance".
- With one fewer retrieval path there is no double-bookkeeping between muninn's
  own `research_knowledge` and huginn's `search_knowledge` — the thing
  `src/research/huginn-hits.ts` exists to untangle. That is a small improvement,
  not a reason to keep huginn away.

When huginn lands on nais, this file becomes one entry:

```json
{ "mcpServers": { "research": { "type": "http", "url": "http://127.0.0.1:9190/mcp/melosys" } } }
```

…plus a `knowledgeApiUrl` pointing at a huginn the pod can actually reach, and
an `accessPolicy.outbound.rules` entry for it.

## 5. `model` is pinned; `baseUrl` is the one the workflow writes

`model` is `google/gemini-2.5-flash` — **with the `google/` publisher prefix**,
without which Vertex answers `400`. It is no longer an open question: measured
2026-08-28, `europe-north1` carries zero Claude models, so the `claude-sdk` +
`CLAUDE_CODE_USE_VERTEX` path this folder used to describe is dropped. See
`docs/PREREQUISITES.md` §7.

`baseUrl` is the value that is still `REPLACE_ME_vertex_baseurl`, and it stays
that way in git **on purpose**. The deploy workflow builds it from `gcp_project`
and `vertex_region` and `jq`-assigns it into the copy of this folder it overlays
into the build context, so the project and the region are stated once in
`nais/vars-q2.json` and derived everywhere else.

Two consequences:

- **Do not fill it in by hand.** A hand-written copy is a second place the
  project and the region live, and nothing compares them. A project mismatch
  means `roles/aiplatform.user` is granted on one project while every turn calls
  another: Google answers `403`, and the connector's refresh matches `401` only,
  so there is no retry and no diagnostic.
- **The KEY must stay present.** A `jq` assign would happily create a missing
  key, and then the workflow's `REPLACE_ME` backstop has nothing to catch — a
  removed or non-matching assign would ship a bot with no `baseUrl` and no guard
  firing.

Nor is the URL a literal with angle brackets. `REPLACE_ME_vertex_baseurl` is
what the grep can see; a `https://<region>-…` placeholder is invisible to it and
would ship `<region>` into every request URL.
