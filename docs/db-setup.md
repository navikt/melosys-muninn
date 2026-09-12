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

On `melosys-muninn-q2` in dev-gcp, the nais-provisioned application user is a
member of **`cloudsqlsuperuser`**:

```
melosys-muninn-q2  -> member of cloudsqlsuperuser
rune.lind@nav.no   -> member of cloudsqliamuser
```

`cloudsqlsuperuser` is the Cloud SQL role permitted to create extensions, so
`db/provision.ts --yes` run as the app user applied all of `init.sql` —
`CREATE EXTENSION vector` included — and finished `exit 0`. Verified after the
fact, independently of the applier's own log: 33 base tables, **all 33 owned by
`melosys-muninn-q2`**, `vector 0.8.5` installed, 71 rows in
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
  --container=melosys-muninn-q2 --profile=general -- bun db/provision.ts --yes

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
3. **A NetworkPolicy granting egress to the instance's private IP.** This is
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
```

Read the CIDR from the generated policy rather than from `gcloud`, so it cannot
drift from what the app itself is allowed to reach. Delete the policy with the
job — it names an instance IP and must not outlive it.

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
