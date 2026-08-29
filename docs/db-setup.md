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

**The nais app user cannot create extensions.** `navikt/kbs-guide` documents the
superuser-reset procedure for exactly this. So the schema arrives in two
privilege levels, and only one statement needs the higher one.

## The order, with the actor on every line

| # | Step | Who runs it | If you get it wrong |
|---|---|---|---|
| 1 | Declare `gcp.sqlInstances` in `nais/app.yaml` and apply | the deploy | — |
| 2 | Superuser reset on the instance | GCP console, team project | you cannot do step 3 |
| 3 | `CREATE EXTENSION vector` | **elevated role, this step only** | migrations fail at the first `vector(384)` column |
| 4 | `bun db/provision.ts --yes` — applies `db/init.sql` **and** baselines | **the app user** | the elevated role owns ~20 tables and the pod gets *permission denied* at first query — not a schema error, so it reads as a code bug |

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
  --container=muninn --profile=general -- bun db/provision.ts --yes

# b) a naisjob with its own `command:` — the same image, the same env
```

`--yes` is required and the script prints `Database: host:port/db` **before**
asking for it. Read that line. It is the only thing standing between
"provisioned the pod's database" and "provisioned a laptop" — and the reason the
confirmation exists at all is that Bun auto-loads `.env`, so a bare invocation in
a checkout resolves whatever that file names.

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
