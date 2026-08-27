# Why the nais bot folder looks the way it does

_Prose lives here rather than in `bots/melosys/` because an unknown key in
`config.json` warns at discovery and a stray file ships in the image._

Four things in here are not preferences. Each is the difference between a
working pod and a broken one, and none of them is visible from the file it
lives in.

## 1. The folder must exist at all

`bots/*` is gitignored in public muninn and only `bots/jarvis/` is tracked, so a
build from that repo contains no bot. `discoverAllBots()` finding zero folders
calls `process.exit(1)` — the failure is a CrashLoopBackOff, not an empty chat.
This folder is copied into the build context by `.github/workflows/deploy.yml`
and let through by `build/Dockerfile.dockerignore`.

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

## 3. `haikuBackend` must be pinned too — and its value is a fail-closed choice

The default for a non-`copilot-sdk` bot is `cli`, which does not exist here.
`anthropic` is set instead, and **its host is deliberately absent from the
manifest's `accessPolicy.outbound.external`**. That is not an oversight:

- On this pod Haiku is almost certainly never called. The three extractors are
  force-disabled for an `entra` identity, the `research_knowledge` decomposer
  needs an MCP tool that does not exist here (§4), and the scheduler never
  starts (§1).
- If something ever does call it, `api.anthropic.com` is not a NAV-approved
  model endpoint. nais egress is default-deny, so the call fails at the network
  rather than reaching an unapproved provider. A visible failure is the correct
  outcome; a working call would be the bug.

When the Vertex work lands a fourth Haiku backend (see the `muninn-nav-vertex-models`
plan, PR 3), change this value and add nothing to the egress list.

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

## 5. `model` is REPLACE_ME on purpose

It depends on an unanswered question — which region, and therefore which model,
Team KI accepts. See `docs/PREREQUISITES.md` §7.
