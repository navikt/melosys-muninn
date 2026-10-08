# The schema step

muninn's entrypoint deliberately does **not** create a database. It refuses an
unprovisioned one and prints remedies, because provisioning is an operator
action with a privileged actor in the middle of it — and getting that actor
wrong fails silently rather than loudly.

Read the whole page before running step 1. The instance does not exist until the
manifest is applied, so the first rollout either crash-loops on purpose or runs
against `replicas: 0`.

## Why this is not automated

`db/init.sql` line 5 is:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Creating an extension needs privileges an ordinary database user does not have,
so muninn's entrypoint refuses rather than guessing. **What it does NOT mean is
that a superuser reset is required** — see the measurement below.

<!-- Everything from here to "The mechanism, decided" was rewritten on
     2026-09-12, the day this ran against a real instance for the first time.
     The previous text asserted that the nais app user cannot create
     extensions and made a superuser reset step 2 of 4, unconditionally. Both
     were wrong here, and the cost of leaving them would have been an operator
     resetting a production-adjacent postgres password for no reason. -->

### Measured 2026-09-12: the app user creates the extension itself

On the dev deployment in dev-gcp, the nais-provisioned application user is a
member of **`cloudsqlsuperuser`**:

```
<app user>         -> member of cloudsqlsuperuser
rune.lind@nav.no   -> member of cloudsqliamuser
```

Not yet re-measured in prod-gcp. nais provisions the user the same way there,
so expect the same, and let `--dry-run`'s output confirm it.

`cloudsqlsuperuser` is the Cloud SQL role permitted to create extensions, so
`db/provision.ts --yes` run as the app user applied all of `init.sql` —
`CREATE EXTENSION vector` included — and finished `exit 0`. Verified after the
fact, independently of the applier's own log: 33 base tables, **all 33 owned by
the app user**, `vector 0.8.5` installed, 71 rows in
`schema_migrations`.

Note which way round the privileges fall. A **personal** IAM identity is in
`cloudsqliamuser`, not `cloudsqlsuperuser` — so the human is the one who
probably *cannot* create the extension, which is the opposite of what the
superuser-reset procedure assumes.

`navikt/kbs-guide`'s `appendices/pgvector.qmd` documents resetting the
`postgres` password and running `CREATE EXTENSION` from Cloud SQL Studio. Treat
that as the **fallback for an instance whose app user lacks the role**, not as a
prerequisite. `db/provision.ts` reports the privilege wall explicitly if it hits
one; run it first and let it tell you.

## The order, with the actor on every line

| # | Step | Who runs it | If you get it wrong |
|---|---|---|---|
| 1 | Declare `gcp.sqlInstances` in `nais/app.yaml` and apply | the deploy | — |
| 2 | `bun db/provision.ts --dry-run` — reports the resolved database and schema state | **the app user** | you provision the wrong database, or discover the privilege wall during a write |
| 3 | `bun db/provision.ts --yes` — applies `db/init.sql` **and** baselines | **the app user** | the running role owns all 33 of init.sql's tables and the pod gets *permission denied* at first query — not a schema error, so it reads as a code bug |
| 3b | *only if step 3 reports a privilege error*: `CREATE EXTENSION vector` via the kbs-guide procedure, then repeat step 3 | elevated role | — |

**"The app user" is a constraint on the connection, not a figure of speech.**
The credentials live in the nais-generated `google-sql-<app>` secret, which the
team cannot read — `container.secrets.get` is not granted — so there is no way
to type them into a proxy session. That rules out `nais postgres proxy`, whose
IAM login authenticates as the *human*: the tables would come out owned by a
personal identity. The next section is the route that does work.

Step 4 does two things that used to be two steps. It applies `init.sql` — the
consolidated schema — and then *marks applied* every shipped migration, so the
entrypoint's ordinary `bun db/migrate.ts` has nothing pending on the first boot
and picks up only what lands later. Without the baseline half, migrations 006
onwards re-run over a schema that already contains them and the pod crash-loops
on `column "bot_name" of relation "messages" already exists`.

## The mechanism, decided

The plan offered two ways to apply `init.sql` as the app user and this is the
one that was built: **an applier shipped in the image**, muninn PR #486
(squash `21b436b`). It is not optional trivia — it constrains this repo's
input, because the workflow pins a muninn ref and **that ref must contain
#486**. Public muninn carries no tags, so the first deploy pins a commit SHA;
any SHA at or after `21b436b` has it.

⚠️ **`21b436b` is the FLOOR, not the value to dispatch.** Two different things,
and conflating them pins the pod to a commit that was current in August:

- the **floor** is `21b436be9b66f8614bb84ef8f4352b6416f8d99c` — any ref at or
  after it carries `db/provision.ts`, and a ref before it does not;
- the **dispatch value** is whatever public muninn's `main` is when you deploy.

⚠️ **Pass the FULL 40 characters** either way. The ref guard accepts a tag that
really exists upstream, or a 40-hex commit SHA, and nothing else — an
abbreviated one is refused with *"neither a tag … nor a full 40-character
commit SHA"*. `21b436b` is written short in prose because that is how a commit
is named; it is never what you paste.

Get the current value with:

```bash
git ls-remote https://github.com/<owner>/muninn main
```

As of 2026-08-30 that is `fb5e6b5dcba98c0b5dfb2a540405ac677881d2de` (muninn
#494), verified a descendant of the floor with `git merge-base --is-ancestor`.
Re-read it rather than pasting that one: the deploy names the commit it
shipped, so a stale value here silently deploys a stale muninn.

The alternative — `kubectl debug` onto an image carrying `postgresql-client` —
was rejected because it needs a psql image in an allowed registry AND the
transport of `db/init.sql` into it, and it leaves muninn's own printed remedy
pointing at a machine that does not exist for a private-IP instance.

## Running step 4 from inside the cluster

The app user's credentials exist only in the pod, so this runs there. Both forms
**bypass the entrypoint** — which is why `db/provision.ts`, `db/migrate.ts` and
`db/require-provisioned.ts` read `DB_URL` themselves rather than relying on the
entrypoint's `DATABASE_URL` export:

```bash
# a) a debug copy of the running pod, with the entrypoint replaced
kubectl debug -n <namespace> <pod> --copy-to=muninn-schema \
  --container=melosys-muninn --profile=general -- bun db/provision.ts --yes

# b) a naisjob with its own `command:` — the same image, the same env
```

### Form (a) is not available to the team, and (b) needs three things

Measured 2026-09-12 in `teammelosys` / dev-gcp. A team member's own access:

| action | allowed |
|---|---|
| `create pods`, `create pods/exec` | **no** |
| `create jobs` | **no** |
| `create naisjobs.nais.io` | **yes** |

So **(a) is closed** — `kubectl debug` copies a pod, and that is a pod create.
`nais postgres proxy` is closed for a different reason (see the previous
section: it logs in as the human). **(b) is the route**, and a working Naisjob
needs three things, of which only the first is obvious:

1. **`envFrom: google-sql-<app>`** — the app user's credentials and `DB_URL`,
   injected by Kubernetes so nobody has to read the secret.
2. **`filesFrom`** the `sqeletor-<app>-<hash>` secret at
   `/var/run/secrets/nais.io/sqlcertificate` — `DB_URL` is `sslmode=verify-ca`
   against a private IP and names three files under that path. Without it the
   connection fails in TLS, not in SQL.
3. **A NetworkPolicy granting egress to the instance's IPs.** This is
   the one that costs an hour. NAIS generates `sql-<instance>-<app>` selecting
   `app: <app>`, and the job's pods are `app: <app>-provision`, so they match
   nothing and the connection dies as `CONNECT_TIMEOUT` — which reads like a
   firewall problem with no firewall in sight.

⚠️ **Do not "fix" (3) by giving the Naisjob its own `gcp.sqlInstances`.** It
looks like the tidy answer and NAIS would indeed generate the netpol — along
with a **second SQL user named after the job**, which would then own every
table `init.sql` creates. That is the ownership failure this whole page is
organised around, arrived at from a new direction. Copy the one egress rule
instead:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sql-provision-<app>
spec:
  podSelector:
    matchLabels:
      app: <app>-provision
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock:
            cidr: <read it from the app's own sql-<instance>-<app> policy>
        # one `- ipBlock:` entry per address that policy lists
```

Copy EVERY `ipBlock` the generated policy lists, one entry each: the prod
instance's policy named two addresses on 2026-10-05 (the private IP the job
connected on, and a public one), where the dev instance's named one. Copying
all of them keeps the job's egress identical to the app's, whichever address
the URL names.

Read the CIDR from the generated policy rather than from `gcloud`, so it cannot
drift from what the app itself is allowed to reach. Delete the policy with the
job — it names an instance IP and must not outlive it.

`--yes` is required and the script prints `Database: host:port/db` **before**
asking for it. Read that line. It is the only thing standing between
"provisioned the pod's database" and "provisioned a laptop" — and the reason the
confirmation exists at all is that Bun auto-loads `.env`, so a bare invocation in
a checkout resolves whatever that file names.

After a successful `--yes`, the app's crash-looping pod starts by itself on its
next retry, within five minutes. A team member cannot hurry it:
`kubectl rollout restart` is refused with `container.deployments.update`, a
permission the team lacks (measured in prod 2026-10-05); `kubectl wait --for=condition=ready pod -l
app=<app>` shows when it is up.

## A muninn ref that adds a table

Provisioning happens once. After it, the entrypoint's own `bun db/migrate.ts`
carries the schema forward on every boot, with one exception: a migration that
adds a **table**. The entrypoint runs `db/require-provisioned.ts` before
`db/migrate.ts`, and that check refuses a database missing any table
`db/init.sql` declares. The new image's `init.sql` already declares the table
and the database does not have it yet, so the pod stops before the step that
would create it, and crash-loops.

The only prod deploy run so far, 37362902145 on 2026-10-05, shipped muninn
`8ae738bf`. The run itself concluded *failure* (FailedMount and IAM on the
first rollout, then a timeout waiting for the rollout). PR #9 records that the
pod started by itself after provisioning; it does not name the image. To read
the ref prod runs:

```sh
kubectl --context prod-gcp get deploy -n teammelosys melosys-muninn -o jsonpath='{.spec.template.spec.containers[?(@.name=="melosys-muninn")].env[?(@.name=="MUNINN_REF")].value}'
```

`8ae738bf` predates two table-adding migrations: 079 (`summary_factchecks`) and 082
(`wiki_answers`, answer cards). If prod runs it, the next deploy of a ref at or
after 082 is refused with two missing tables,
`summary_factchecks (079-summary-factchecks.sql)` and
`wiki_answers (082-wiki-answers.sql)`, and one run of the job creates both.
The refusal names the tables that are actually missing.
Every later migration that adds a table needs the same step. A migration that
only adds columns or indexes does not: the check compares tables, not columns.

### The order

The deploy workflow builds, pushes and rolls out in one run, and nothing in
this repo can run the job before the rollout reliably. On the last three deploy
runs (one prod, two dev), `Deploy to nais` started 1m24s to 1m45s after
`Build and push the image` finished (runs 36850525530 and 37136042299 on
dev-gcp, 37362902145 on prod-gcp). That window is too short to read the image
reference, fill two manifests, apply the policy, run and read the dry-run job,
and run the real one. `scripts/deploy.sh` also discards the run's log: it
prints the run URL (`kjøring: <url>`) and then nothing until the run ends.
Plan for a short outage instead:

| # | Step | Who runs it | What you see |
|---|---|---|---|
| 1 | `make deploy` (or `scripts/deploy.sh <sha>`) with a muninn ref that adds a table | operator | The run builds, pushes and rolls out. `Recreate` stops the old pod when the rollout starts, so the app is down from then until step 6. |
| 2 | The rollout | — | The new pod crash-loops. The workflow's `nais/deploy` step waits for the rollout and fails, so `make deploy` stops with `workflowen feilet`. On run 37362902145 that step waited about ten minutes before it failed. Do not wait for it: watch the pod in step 3. |
| 3 | Read the pod log, in a second terminal while `make deploy` waits | operator | `kubectl --context prod-gcp -n teammelosys get pods -l app=melosys-muninn` shows the new pod restarting. `kubectl --context prod-gcp -n teammelosys logs deploy/melosys-muninn` prints the log; add `--previous` once the container has restarted. `db/require-provisioned.ts` exits 1 and names each missing table and the migration that creates it, with `bun db/migrate.ts` as the remedy, and the entrypoint prints `[entrypoint] db/require-provisioned.ts failed (exit 1); not starting the server`. Start step 4 as soon as that refusal shows. |
| 4 | Read the image from the Deployment, fill in and apply `nais/migrate-netpol.yaml`, then `nais/migrate-job.yaml` as shipped | operator | The Deployment names the new image even while its pod is failing; the `image:` command in `nais/migrate-job.yaml`'s header (the same one `nais/provision-job.yaml` uses) prints it. `--dry-run`: the job prints `Database: host:port/db` and the pending migrations, for example `079-summary-factchecks.sql` through `082-wiki-answers.sql`, applies none and exits 0. |
| 5 | Delete the job, remove its last argument (`--dry-run`), apply it again | operator | The job runs `bun db/migrate.ts` **as the app user**, applies the pending migrations and exits 0. |
| 6 | Wait for the pod | nobody | The crash-looping pod passes `db/require-provisioned.ts` on its next retry, within five minutes, finds nothing pending and starts (`kubectl rollout restart` is not granted to the team). |
| 7 | Delete the job and the policy | operator | `kubectl delete -f nais/migrate-job.yaml -f nais/migrate-netpol.yaml` |

The runner takes `pg_advisory_lock` for the whole pending list, so if the pod
reaches its own migrate step while the job is still running, the two serialize
and the second finds nothing pending.

The secret in the job is read the way `nais/provision-job.yaml`'s is, with the
command in `nais/migrate-job.yaml`'s header. The IP in the policy is read with
the command in `nais/migrate-netpol.yaml`'s header.

⚠️ **Do not follow the `DROP SCHEMA` line in that refusal.** The check prints
it for a half-applied `init.sql`, and it destroys every row. A database that is
behind the image by table-adding migrations needs `bun db/migrate.ts` and
nothing else.

This is the same shape as the first rollout on 2026-10-05: an expected
crash-loop, a Naisjob as the app user, and a pod that recovers by itself.

To remove the outage, add a build-only mode to `deploy.yml` that pushes and
checks the image without rolling out. The job then runs with that image before
the rollout, which is safe: the migrations are additive and the old code
ignores tables it does not know. That mode does not exist yet.

## What it refuses, and why the refusal matters

`db/provision.ts` writes only into an **empty** database. Four other states are
refused by name, and the remedy differs per state — getting that wrong is what
makes a database unrepairable:

| State | What it says |
|---|---|
| Complete schema, ledger has rows | already provisioned; nothing written |
| Complete schema, ledger empty | run `bun db/migrate.ts --baseline` |
| **Incomplete** — some of init.sql's tables | refused by name, listing present and missing, and told **not** to baseline |
| Only `schema_migrations` | `DROP TABLE schema_migrations`, then re-run |
| Tables that never came from init.sql | almost certainly the wrong database |

The third row is the one worth understanding. `users` is `init.sql`'s **first**
table and `schema_migrations` its **last**, so a `psql -f db/init.sql` that died
mid-file leaves `users` present and no ledger. Read through a `users`-only
predicate that looks like "provisioned but never baselined" — and `--baseline`
there *succeeds*, satisfies `db/require-provisioned.ts`, boots the pod on a stump
of a schema, and records every migration as applied so nothing can repair it.
Both the applier and the entrypoint's own check now compare the **whole table
set**, parsed out of `init.sql` itself.

## TLS, and why the URL needs translating

nais Cloud SQL instances created after 2024-04-18 are **private-IP with client
certificates**, so `DB_URL` looks like:

```
postgresql://user:pass@10.x.x.x:5432/db?sslcert=%2F…&sslkey=%2F…&sslrootcert=%2F…&sslmode=verify-ca
```

Public muninn handles this in `db/postgres-connection.ts` — it must, because
`postgres.js` reads none of those parameters as TLS material and forwards
unknown ones into the Postgres **startup packet**, where the server rejects them
(`unrecognized configuration parameter "sslcert"`). Two consequences worth
knowing when you are debugging a pod that will not connect:

- `verify-ca` verifies the certificate chain but **waives the hostname check**.
  It has to: a Cloud SQL certificate names the instance, and the URL dials an IP.
- The boot log prints a `Database TLS:` line naming every file it read and
  whether the hostname check was waived. If that line is absent, the URL carried
  no TLS parameters — which on nais means you are not looking at the injected
  one.

The muninn repo carries `bun scripts/smoke-nais-db-tls.ts`, which reproduces the
whole shape locally against a throwaway server with a private CA and mandatory
client certificates.

## Checking it worked

Acceptance row 28 is "the **app user** can INSERT and SELECT on `users` and
`messages` from a running pod" — the ownership assertion step 4 exists for. Run
it as the app user, from the pod, not from a console session as the elevated
role, or it proves the opposite of what it looks like.
