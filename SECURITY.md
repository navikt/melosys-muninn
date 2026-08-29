# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository
(*Security → Report a vulnerability*), or contact **@navikt/teammelosys**
through the team's internal channel. For NAV-wide coordinated disclosure, follow
the process at <https://nav.no/sikkerhet> / `security.txt` on nav.no.

## What is in scope

This repository is a **deploy artifact**: a nais `Application` manifest, its
variables, a bot folder and a GitHub Actions workflow. It contains no
application source. The application is **muninn**, built from its own public
repository — named in `MUNINN_REPO` in `.github/workflows/deploy.yml` — at a ref
this repo pins.

So a report about this repository is usually one of:

- a value that should not be here (see below),
- a manifest or workflow setting that weakens the deployment — the sidecar
  configuration, the group gate, the egress allowlist, the origin list, or the
  workflow's triggers and permissions,
- a supply-chain concern in the pipeline: the pinned muninn ref, the actions it
  uses, or what lands in the image.

Application vulnerabilities belong in the muninn repository.

## What is deliberately *not* a secret here

Everything in `nais/vars-q2.json` is infrastructure naming — namespace, team,
ingress hostnames, the Entra tenant, a group object id, a GCP project id and a
region. Those are public across `navikt` by the hundred; access is granted by
Entra group membership and GCP IAM, not by the obscurity of an identifier.

There is **no model credential anywhere in this repo**. The pod authenticates to
Vertex AI with its own workload-identity service account.

The one thing that must never be committed here is the **admin `oid` list**: an
`oid` is a stable personal identifier for a named human in the directory. It
lives in a Kubernetes secret (`docs/PREREQUISITES.md` §10) and is mounted with
`envFrom`. A pull request that reintroduces it as a variable is a security bug,
not a convenience.

## Scope of the deployment itself

This is a **dev-gcp** deployment. Colleague chat content is personopplysninger
and lands in two Cloud SQL stores (`messages`, `activity_log`) keyed to a
NAVident; retention is an open question and is the reason there is no prod
deployment. See `docs/PREREQUISITES.md`.
