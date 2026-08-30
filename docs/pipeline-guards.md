# The deploy workflow's guards, and every form of them that was wrong

This page is where the deploy workflow's guard history lives, so the workflow
can state the rule instead of the archaeology — the comments grew to several
times the code they documented, and three separate rounds of editing them
introduced false statements into a file that is about to be public.

**It documents the guards that got something wrong, not every refusal in the
workflow** — there are more than two dozen `exit 1`s, and the `vertex_region=global`
refusal has no history worth a section. Deliberately no exact count: three
earlier drafts of this line stated one and all three were wrong, which is itself
the best argument for not stating one.

**Almost none of this was found by reading.** Every mechanism below was measured
by extracting the step's `run:` body and executing it — except §2b and §4b,
which are an ordering claim and a repo-history claim, verified with `git show`.

## How to measure a guard here, and the two ways it has gone wrong

Both of these produced a CONFIDENT, WRITTEN, FALSE claim in this repo. Neither
was caught by review of the change; both were caught by someone re-running the
measurement. If you are about to add a row below, read this first.

1. **Extract the WHOLE `run:` body, with a YAML parser, and drive that.** Never
   a slice of it, and never a retyped copy. Round 8 claimed a fix made a
   read-only `muninn/` produce an annotation; it does not, because that state
   dies at a `mkdir -p` three lines *above* the slice the harness started from.
   The claim reached a commit message, a workflow comment and this page before
   a reviewer drove the whole body and got `rc=1 ann=0` from both versions.
2. **Build fixtures IN-PROCESS, and make each one isolate the property.** Not
   through `$( )`, which strips a trailing newline before the fixture exists —
   so the case you meant to test silently does not exist. And not a fixture
   that fails for a second reason: a guard was once "proved" to refuse a newline
   by a value that was refused for containing `=`. If a case passes, mutate the
   fix and confirm that case flips. A test that cannot fail is not evidence.

The corollary for prose: **a sentence asserting a mechanism belongs next to the
measurement that produced it, or it does not belong here.** Four claims in this
repo have now been wrong in the direction of sounding authoritative — twice
about `idleTimeout`, once about which guard refuses a ghost folder, once about
the read-only case above.

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

**Rule:** everything under `deploy/bots/` is a directory whose name is a plain
slug; each holds a non-empty regular-file `CLAUDE.md` and a `config.json` that
is exactly ONE json object pinning `connector` to `copilot-sdk`,
`openai-compat` or `claude-sdk`; and no `REPLACE_ME` survives anywhere under it.

| Form | Why it was wrong |
|---|---|
| `if grep -rn "REPLACE_ME" deploy/bots/; then` | `grep -r` on a **missing path exits 2**, which makes the `if` false. The backstop passed precisely when the thing it guards was absent. |
| `[ -d deploy/bots ]` alone | An **empty** `deploy/bots/` still passes: the directory exists and the grep matches nothing. |
| `set -- deploy/bots/*/config.json; [ ! -e "$1" ]` | `[ -e ]` is true for a directory, so a directory *named* `config.json` satisfied it. And the message ("nothing to overlay") was wrong for a bot folder carrying only a `CLAUDE.md`. |
| `[ -f "$d/config.json" ]` | **Asserted a proxy, not the property.** A `config.json` containing `{}` — or `{"connector":"claude-cli"}` — passed. So did a *mistyped* value: discovery **warns and drops** an unknown enum, so `"openai_compat"` reads as pinned in the file and is unset at runtime. Check the connector by VALUE against an allowlist. |
| `[ -s "$d/CLAUDE.md" ]` | `[ -s ]` is **true for a directory** — the same gap that `-f` had just been introduced to close, one line below. A `CLAUDE.md` that is a directory passed here AND the image assertion (also `test -s`), then threw an uncaught `EISDIR` from `readFileSync` at pod boot: CrashLoopBackOff with all fifteen steps green. |
| `jq -e '.connector == …'` on `config.json` | **No `-s`.** Exactly the hole §3 row 4 documents for the vars file, written one step later in the same commit that documented it: jq judges only the LAST document, so a concatenated `{"connector":"claude-cli"}{"connector":"openai-compat"}` passed — while muninn's own `JSON.parse` **throws** on it, the throw is caught, `botSettings` stays `{}`, and `resolveConnector` returns `claude-cli`. Measured both halves. |
| `for d in deploy/bots/*/` | A glob does **not match a dotfile**. A `.ghost/` directory was inspected by nothing here, hidden from the image assertion's `ls -1` on both sides, copied by `cp -R`, and then DISCOVERED by muninn's `readdirSync` (which filters on `isDirectory()` only) — a second, connector-less bot in the chat picker with every step green. `find -mindepth 1 -maxdepth 1` sees it, and both `ls -1` became `ls -1A`. |
| `for e in $(find …)` | Word-splits a name containing a space, so the refusal named a truncated path. `find … > file` then `while IFS= read -r` — not `find … \| while`, whose subshell would swallow both the counter and the `exit 1`. The file comes from `mktemp` under `${RUNNER_TEMP:-/tmp}`, not a fixed `/tmp` path, which two concurrent dispatches on a shared-`/tmp` runner would truncate under each other — and not a `$$` suffix either, since separate PID namespaces sharing a `/tmp` mount hand out identical low PIDs. A `trap … EXIT` removes it; without one they accumulate per dispatch forever (measured: 3 runs, 3 files). `mktemp` failing is caught with an `::error::`, where a bare redirection died with none. |
| `ls -1` on both sides of the image's exact-set assertion | Hid a dot-directory from the comparison **and** from the `for bot in $WANT` loop, so a ghost present only in the image passed. `ls -1A` closes that. Measured, and worth stating precisely: a ghost on BOTH sides still satisfies `GOT == WANT`, and the per-bot loop does **not** refuse it either unless it is malformed — a well-formed `.ghost/` (non-empty `CLAUDE.md`, pinned connector) passes the whole image step. What refuses the both-sides case is the **slug guard** in the bot-folder step — it has no row of its own in this table; it is the *"And the folder names"* paragraph below — which runs before the overlay. All three fixtures measured. |
| `set -o pipefail` on the image listing | Added to improve an error message; it deleted one. `ls -1A` on a MISSING directory exits 2, so under `bash -e` the assignment aborted the step **before** `::error::/app/bots is empty` could print — pre-fix rc 1 WITH the annotation, post-fix rc 1 with none at all. And it was **inert for the pipeline its own comment named**: in the per-bot `docker run \| jq`, jq is rightmost and already exits non-zero, measured identical with and without. Do not reach for it here; split the commands instead. |
| `if ! RAW=$(docker run … 'ls -1A /app/bots')` | **Discards the status, so two states it claimed to separate arrive as one.** The comment above it claimed five distinguishable states each with their own message; there were four, and the two merged were the two whose diagnosis differs most — "your daemon is broken" vs "go read upstream's `.dockerignore`". Ask `docker image inspect` FIRST, then let a failing `ls` mean one thing. Deliberately **not** an exit-code `case`: a missing image is 125 but an unreachable daemon is 1, so branching on the code misfiles the very state it was added to name. |
| no `[ -n "$IMG" ]` before the assertions | With an empty image reference the whole step **passed**, asserting nothing about any artifact — measured against a shim. `outputs.image` on the non-push call being set is a documented assumption of `nais/docker-build-push@v0`, and an assumption a guard is built on has to be checked by that guard. |
| `WANT=$(ls -1A deploy/bots \| sort)` | The same status conflation as the row above, on the other side of the comparison, left in place one line below where it had just been split apart. Unreachable today (`deploy/bots` is `-d`-checked three steps earlier) — recorded because leaving the shape intact is what teaches the next reader that the shape is fine, which is how it got written the first time. |
| `echo "MUNINN_SHA=$(git … rev-parse HEAD)" >> "$GITHUB_ENV"` | **The status of `echo "X=$(cmd)" >> file` is ECHO'S, never the substitution's** — so a failing `rev-parse` exported an EMPTY value and the step went GREEN. Measured: `fatal: not a git repository`, step rc 0, `GITHUB_ENV` carrying `MUNINN_SHA=`. Downstream that is `tag: muninn-` on both `docker-build-push` calls and `muninn_ref=` rendered into the DEPLOYED MANIFEST, with every assertion in the file still passing — the only write here whose silent failure reaches the cluster. A sweep that claimed to have enumerated every write cleared this one by reading it. Assign, check, then export; the shape check is 40 hex through `jq` and slurped (`-Rs`), since the non-slurped form judges only the last line. |
| `rm -rf muninn/bots` / `mkdir -p` / `cp -R deploy/bots/.` | Three unguarded writes in the overlay step, **missed by the Class-A sweep that rewrote that very step** while claiming to have enumerated every write in the file. `cp` failing measured at rc 1 with ZERO annotations. They are also what a read-only `muninn/` hits first, which is why the sweep's headline claim — that its `mktemp`/`mv` "names" that state — was false: the step dies here and never reaches that line. Specifically at `rm -rf`, not `mkdir -p`: `actions/checkout` of public muninn always leaves `muninn/bots` present (`git ls-tree fb5e6b5d bots/` → `bots/CLAUDE.md`, `bots/jarvis`; the same tree object at the August floor and at main), so the `rm` always has something to remove. The first correction named `mkdir` because its fixture had no `muninn/bots` — the un-representative-fixture failure above, committed alongside the note warning about it. |
| `grep -v '^bots/$' … > /tmp/di && mv /tmp/di …` | **The rest of the temp-file class, missed by the sweep that condemned `$$`.** Fixed `/tmp` path, no uniqueness, no `trap`, no `::error::`. Measured with `muninn/` at mode 500: rc 1, `Permission denied` on stderr, **zero annotations**, and `.dockerignore` left UNSTRIPPED so the overlay would not land. It survives `set -e` because `-e` is exempt for the non-final command of an `&&` list. Second defect in the same line: **`grep -v` exits 1 when it selects no lines** — a `.dockerignore` whose only entry is `bots/` — so the `&& mv` never ran, the exclusion survived, and the step died on the list's status with nothing printed. Treat exit 1 as a legitimate empty result and only >1 as an error. |
| `cat "$STRIPPED" > muninn/.dockerignore` | *Written and reverted during the fix above, before commit.* `cat >` truncates the TARGET, so it refuses a read-only `.dockerignore` that the previous `mv` form replaced without complaint — a stricter failure on a state that works today, i.e. the repair injecting its own defect. `mv` keeps the behaviour and gains the annotation. Measured four ways: read-only file, `bots/`-only file, happy path, and a missing `RUNNER_TEMP`. (A fifth, "read-only dir", was listed here and is not a measurement of this line at all — that state never reaches it — see the `rm -rf muninn/bots` row above.) |

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
— and that single test covers unset, mistyped, explicitly-`claude-cli` and
unparseable alike. It is asserted **twice**: on `deploy/bots/` before the build, and on the built
IMAGE before it is pushed, because nothing else binds the source tree to the
artifact. ⚠️ **Not on the pushed artifact** — that is a different image (the
assertion call is `push_image: "false"`), and the workflow is explicit that
nothing ties the two together; see the `pull` comment on the push call.

⚠️ **The allowlist is hardcoded and has a maintenance obligation.** The day
muninn gains a fifth connector, a correctly-pinned bot using it is refused here.
That is the right failure direction — fail-closed on an unknown connector beats
shipping a pod that falls back to `claude-cli` — but the error message says so
rather than insisting the value is mistyped. See `bot-folder-notes.md` §2.

**And the folder names.** Every entry under `deploy/bots/` must BE a directory
(a stray file rides `cp -R` into the image and then fails the per-bot assertion
with a message about discovery, concerning a file discovery ignores), and each
name must be a plain slug — it is used unquoted in the image assertion's
`for bot in $WANT` loop and as a container path.
