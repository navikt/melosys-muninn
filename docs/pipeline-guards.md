# The deploy workflow's guards, and every form of them that was wrong

`.github/workflows/deploy.yml` carries seven refusals. Each one is short in the
file and each one arrived there after at least one form that looked right and
was not. This page is where that history lives, so the workflow can state the
rule instead of the archaeology — the comments grew to several times the code
they documented, and three separate rounds of editing them introduced false
statements into a file that is about to be public.

**None of this was found by reading.** Every entry below was measured by
extracting the step's `run:` body and executing it.

---

## 1. "No placeholder survives in the vars file"

**Rule:** the VALUES of keys that do not begin with `_` must not contain
`REPLACE_ME`.

| Form | Why it was wrong |
|---|---|
| `grep REPLACE_ME deploy/nais/vars-q2.json` | Also reads the file's own `_comment` keys, which say the token *while explaining it*. It refused a **correctly filled** vars file — forever. This shipped in the first commit of this repo and the deploy could never have run. |

A `jq` walk over non-`_` keys replaced it, and it names which values are still
unfilled, which a grep cannot.

## 2. "The ref must be a tag or a full commit SHA, never a branch"

**Rule:** only a tag that exists upstream, or a 40-hex commit SHA in either
case. Fetch the ref list once; compare exact fields.

| Form | Why it was wrong |
|---|---|
| `[ "$REF" = "main" ] \|\| [ "$REF" = "master" ]` | Knows two names. `feature/x` deployed a floating branch. |
| `git ls-remote --heads URL "$REF"` | `ls-remote` patterns are **globs matched from the right on `/` boundaries**. The legitimate tag `x` was reported as a branch whenever any `feature/x` existed upstream — fail-closed, but with an error message that was simply untrue, sending the operator to look for a branch that does not exist. A glob like `*` was a pattern rather than a name. |
| `git ls-remote --heads URL "refs/heads/$REF"` | Anchoring fixed the false positive and **opened a bypass**: `refs/heads/main` matched nothing, and `actions/checkout` accepts that spelling and resolves it to the branch tip. |
| `awk -v w="refs/heads/$REF"` | `awk -v` expands escape sequences in the assigned value *before* the comparison, so `REF='a\142'` was compared as `ab` — the guard passed judgement on a different string than the one `actions/checkout` is handed. Use `ENVIRON`. |
| `test("\A[0-9a-f]{40}\z")` | Case-sensitive. git and `actions/checkout` both accept an uppercase object name, and since public muninn has **no tags at all**, a pasted SHA is the only usable input — so this refused the one path the first deploy will take, with a message denying the value was a SHA. |

Two properties survive from the earliest version and still matter: `MUNINN_REPO`
is an `owner/repo` slug, not a valid remote on its own; and the **exit status is
checked separately from the output**, because "returns empty" is also satisfied
by a command that errored.

**The two arms are checked differently.** A tag is verified against the remote's
ref list. A SHA is accepted on **shape alone**, so a typo'd SHA passes this step
and fails inside `actions/checkout`. That is a choice, not an impossibility:
GitHub's `GET /repos/{owner}/{repo}/commits/{sha}` answers it over HTTP, and
`git fetch <url> <sha>` works where `uploadpack.allowReachableSHA1InWant` is on.
Neither is used here — `ls-remote` cannot do it, and the failure mode is a loud
one step later — but the hardening exists if a bad SHA ever costs a build.

## 2b. "MUNINN_REPO must be filled in"

**Rule:** refuse while the slug is a placeholder — and do it **before** the ref
guard, not after. The ref guard queries the remote, so with a placeholder repo
it dies on a git transport error first: fail-closed either way, misdiagnosed on
the very first run of a fresh clone. The staged workflow had the placeholder
check as step 4 and the ref guard as step 2.

## 3. "Derive the Vertex base URL" — the value shape check

**Rule:** `gcp_project`, `vertex_region` and `team` must be lowercase letters,
digits and inner hyphens. They leave the step by three routes that all trust
their shape: a URL, a `$GITHUB_ENV` line, and the comma-separated `VAR:` input.

| Form | Why it was wrong |
|---|---|
| `case "$val" in *[!a-z0-9-]*)` | A bracket range is a **collation** range, not an ASCII one. It is ASCII where bash's `globasciiranges` is on (bash ≥ 5, so it was sound on the runner) and not otherwise. *Written and discarded before it was committed* — recorded because the obvious spelling is the one that looks right. |
| `[ -n "$(printf %s "$val" \| tr -d "$SAFE")" ]` | **Command substitution strips trailing newlines.** A value whose only illegal characters were newlines passed. Measured: `vertex_region` = `"eu\nrogue"` exited 0, wrote a two-line `VERTEX_HOST` and baked a broken `baseUrl` into the shipped bot config. |
| `test("^[a-z0-9-]+$")` in jq | Oniguruma's `$` matches **before a trailing newline**, so `"eu\n"` passed. Use `\A` and `\z`. |
| `jq -e 'type == "object"'` as the precondition | Judges only the LAST output. A **concatenated JSON stream** (`{...}{...}` — a merge conflict resolved by keeping both sides) runs the program once per document, each individually clean, and `jq -r '.team'` then returns a multi-line value. Slurp and require `length == 1`. |
| *(no precondition at all)* | jq given an empty or whitespace-only document runs the program zero times, emits nothing and exits 0 — so the offending-keys list came back empty and the step passed, deriving `https://aiplatform..rep.googleapis.com/v1/projects//locations//endpoints/openapi`. |

The check lives in `jq` and **the values never cross into the shell** — only the
names of offending keys do. That is the mechanism, not a style preference.

## 4. The assign loop

`set -e` is **exempt for the non-final command of an `&&` list**, and the loop
body's last command was an `echo`. So an unmatched glob ran the body once on the
literal pattern `deploy/bots/*/config.json`, failed the redirect, and exited 0
having assigned nothing. Counting the assignments and refusing zero is what
makes the step's own claim true.

## 4b. The derived build-context ignore

**Rule:** `grep -q '^bots/$' muninn/.dockerignore` must SUCCEED before the line
is stripped. The file is derived from public muninn's own `.dockerignore` rather
than checked in as a second copy — the repo used to carry
`build/Dockerfile.dockerignore`, a hand-maintained duplicate whose own header
said "keep it in sync", with nothing enforcing it. The `grep -q` is what makes
an upstream rename break the build instead of silently dropping an exclusion.

## 5. "No placeholder survives in the bot folder"

**Rule:** every `deploy/bots/<bot>/` has a non-empty `CLAUDE.md` and a
`config.json`, and no `REPLACE_ME` survives anywhere under it.

| Form | Why it was wrong |
|---|---|
| `if grep -rn "REPLACE_ME" deploy/bots/; then` | `grep -r` on a **missing path exits 2**, which makes the `if` false. The backstop passed precisely when the thing it guards was absent. |
| `[ -d deploy/bots ]` alone | An **empty** `deploy/bots/` still passes: the directory exists and the grep matches nothing. |
| `set -- deploy/bots/*/config.json; [ ! -e "$1" ]` | `[ -e ]` is true for a directory, so a directory *named* `config.json` satisfied it. And the message ("nothing to overlay") was wrong for a bot folder carrying only a `CLAUDE.md`. |
| `[ -f "$d/config.json" ]` | **Asserted a proxy, not the property.** A `config.json` containing `{}` — or `{"connector":"claude-cli"}` — passed. So did a *mistyped* value: discovery **warns and drops** an unknown enum, so `"openai_compat"` reads as pinned in the file and is unset at runtime. Check the connector by VALUE against an allowlist. |
| `[ -s "$d/CLAUDE.md" ]` | `[ -s ]` is **true for a directory** — the same gap that `-f` had just been introduced to close, one line below. A `CLAUDE.md` that is a directory passed here AND the image assertion (also `test -s`), then threw an uncaught `EISDIR` from `readFileSync` at pod boot: CrashLoopBackOff with all fifteen steps green. |

**Why the CONNECTOR, not just the file.** `discoverAllBots` needs only a
`CLAUDE.md`, and `config.json` is an optional per-bot override — that is muninn
generally. On **this pod** the connector is mandatory, and muninn's own nais
boot line says so: *"every bot on this deployment must be pinned to a non-CLI
connector"* — the profile's CLI refusal lives in `spawnHaiku` and covers the
Haiku router, the watchers and the scheduler, but **not the chat connector**.
`resolveConnector` is `botConfig.connector ?? "claude-cli"` and the image is
built `WITH_CLI=false`, so an unpinned bot spawns a missing binary on every
turn, in front of a colleague, with the whole pipeline green.

The guard therefore checks the VALUE against the allowlist `copilot-sdk` /
`openai-compat` / `claude-sdk` — which is `CONNECTOR_VALUES` minus `claude-cli`
— and that single test covers unset, mistyped and explicitly-`claude-cli` alike.
See `bot-folder-notes.md` §2.

**And the folder names.** Every entry under `deploy/bots/` must BE a directory
(a stray file rides `cp -R` into the image and then fails the per-bot assertion
with a message about discovery, concerning a file discovery ignores), and each
name must be a plain slug — it is used unquoted in the image assertion's
`for bot in $WANT` loop and as a container path.
