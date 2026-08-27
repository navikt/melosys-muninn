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
| 4 | Apply `db/init.sql` | **the app user** | the elevated role owns ~20 tables and the pod gets *permission denied* at first query — not a schema error, so it reads as a code bug |
| 5 | `bun db/migrate.ts --baseline` | **the app user** | without `--baseline`, migrations 006–074 re-run over the consolidated schema `init.sql` already contains |

Step 5 is *mark-applied*, not *apply*. `init.sql` is the consolidated schema;
baselining records every existing migration as done so the entrypoint's ordinary
`bun db/migrate.ts` has nothing pending on the first boot and picks up only what
lands later.

## Running steps 4 and 5 from inside the cluster

The app user's credentials exist only in the pod, so these run there. Two forms,
and both **bypass the entrypoint** — which is why `db/migrate.ts` and
`db/require-provisioned.ts` read `DB_URL` themselves rather than relying on the
entrypoint's `DATABASE_URL` export:

```bash
# a) a debug copy of the running pod, with the entrypoint replaced
kubectl debug -n <namespace> <pod> --copy-to=muninn-schema \
  --container=muninn -- bun db/migrate.ts --baseline

# b) a naisjob with its own `command:` — the same image, the same env
```

`db/migrate.ts` prints `Database: host:port/db` before it acts. Read that line.
It is the only thing standing between "baselined the pod's database" and
"baselined a laptop".

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
