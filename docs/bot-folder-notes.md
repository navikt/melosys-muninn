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
the nais image (`build/Dockerfile.nais`) installs no Claude CLI — there is no `claude`
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
nais and `.mcp.json` gains its entry (§4), the decomposer starts calling
Haiku on every lookup and the `anthropic` pin becomes a hard failure in front of
a colleague. Correct-by-construction beats fails-closed-by-absence here.

Unlike the chat connector, this backend derives nothing from `baseUrl`:
`resolveVertexHaikuTarget` reads `ANTHROPIC_VERTEX_PROJECT_ID` **or**
`VERTEX_PROJECT_ID`, and `CLOUD_ML_REGION` **or** `VERTEX_REGION`. That is why
`nais/app.yaml` still carries two Vertex env variables after
`CLAUDE_CODE_USE_VERTEX` was deleted — they exist for this one consumer, under
muninn's own names, with the SDK's names left unset so the `claude-sdk` path
stays off.

## 4. `.mcp.json` has one entry, keyed `knowledge`, and it needs huginn on nais

muninn's `research_knowledge` is a **proxy**: the in-process MCP server on
`127.0.0.1:9190` queries huginn over HTTP at `KNOWLEDGE_API_URL`, a pod-wide
env variable, not a value in this folder. The entry therefore points at muninn's
own loopback server, and the huginn address lives in `nais/app.yaml`:

```json
{ "mcpServers": { "knowledge": { "type": "http", "url": "http://127.0.0.1:9190/mcp/melosys",
  "env": { "KNOWLEDGE_COLLECTIONS": "nav-wiki,melosys-confluence-v3,jira-issues" } } } }
```

**Do not merge this entry without huginn.** It ships in the image on the next
redeploy from `main`, for any reason, and then fails in one of the ways below. Each
failing turn still makes the decomposer's Haiku call on Vertex first.

- **No `KNOWLEDGE_API_URL` in `nais/app.yaml`, or no `melosys-huginn-q2`
  app:** muninn falls back to `http://localhost:8321` (`src/config.ts`) when the
  variable is missing, where nothing listens; a hostname with no app behind it
  does not resolve. Either way every sub-search fails within milliseconds
  (measured locally against muninn's own client), and the tool tells the model
  that knowledge search is unavailable. The colleague gets an answer with no
  sources on every corpus question.
- **`KNOWLEDGE_API_URL=http://melosys-huginn-q2`, but no
  `accessPolicy.outbound.rules` entry:** nais drops the packets, so the
  sub-searches wait out muninn's 30-second search timeout before the tool
  reports knowledge search as unavailable. The colleague sees a stalled answer,
  then one with no sources.
- **The app exists but no pod is ready** (huginn still loading its models, or
  failing its probe): not measured on nais. Whether the Service rejects the
  connection at once or drops it for 30 seconds depends on the cluster's
  dataplane.
- **The pod answers, but with an error:** for example huginn skipped one of the
  three collections at load and the readiness probe is not huginn's `/ready`
  (which answers `503` until every requested collection is served, so with it
  this case becomes the previous one). huginn answers `404` for the whole request when any
  requested collection is not served, and every sub-search sends all three, so
  every sub-search fails at once and the tool reports knowledge search as
  unavailable although huginn is up. A `503` looks the same. Check the
  collections on huginn's `/ready` before the network.

The change that adds the pod and those manifest lines merges together with this
one.

Three details are not visible from the file:

- **The key is `knowledge`, not `research`.** muninn appends a system-prompt
  nudge when, and only when, a bot has an entry keyed exactly `research`
  (`hasResearchKnowledge` in `src/bots/config.ts`). The nudge tells the model
  to use `search_knowledge` for simple lookups, and that tool comes from
  huginn's stdio adapter, which this pod cannot run. The key gates nothing
  else: the tool loads from any entry.
- **`KNOWLEDGE_COLLECTIONS` names exactly the collections the huginn image
  bakes.** muninn reads it off any entry, whatever its type, as the tool's
  default scope; huginn answers `404` for a collection it does not serve.
- **The persona carries what the nudge would have said.** `CLAUDE.md` tells
  the model to use `research_knowledge` for every corpus question, simple ones
  included, and that people appear as aliases. The index is pseudonymised and
  this pod has no alias map, so a real name cannot be looked up; the persona
  tells the model not to search on one.

The Jira composer's `Full` depth stays unreachable (it requires the `code` and
`yggdrasil` MCP servers). Its pre-flight refuses cleanly and says the code tools
are not available in this installation.

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
