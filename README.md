# HIMS — Multi-tenant Hospital Management System

A multi-tenant HMS built around one idea: **the guarantees that matter most are
the ones a developer cannot forget.** Tenant isolation, double-booking
prevention, immutable clinical records and an unforgeable audit trail all live
in the database as constraints and policies, not in application conventions.

Everything below has been run: migrations applied to PostgreSQL 16, 34
invariants verified, both services booted, and the flows exercised end to end
against seeded data.

![Dashboard](docs/screenshots/light-02-dashboard.png)

---

## Stack

The brief left these open; the choices and their reasons:

| Layer | Choice | Why |
|---|---|---|
| Database | **PostgreSQL 16** | Row-Level Security, `EXCLUDE` constraints over ranges, and generated columns are load-bearing here. MySQL has none of the three. |
| Backend | **Node 22 · TypeScript · Express 5** | Express 5's native async error handling removes a class of swallowed rejection. Plain SQL over an ORM, because the tenant contract has to be visible at the call site. |
| Frontend | **Next.js 15 · React 19 · Tailwind v4** | App Router, server-rendered shell, a token-based design system rather than a component library whose defaults would have to be fought on status colour. |
| Auth | **JWT access + rotating refresh, Argon2id, two-layer RBAC** | Short access tokens with a permission cache; refresh rotation with reuse detection. |

---

## Quick start

```bash
# 1. PostgreSQL (and Redis). Optional services sit behind a profile, so a
#    registry hiccup in one of them can never stop the database coming up.
#    This gives you a bare server with the stock `postgres` superuser —
#    the application's roles and database come from step 3.
docker compose -f infra/docker-compose.yml up -d

# 2. Configuration
cp .env.example .env
#    Generate real keys — the API refuses to boot on the placeholders:
#      openssl rand -base64 32   # MASTER_KEY
#      openssl rand -base64 32   # BLIND_INDEX_KEY   (must differ)
#      openssl rand -base64 48   # JWT_ACCESS_SECRET
#      openssl rand -base64 48   # JWT_REFRESH_SECRET (must differ)

# 3. Database, schema and demo data
pnpm install
pnpm db:create    # creates the `hims` database and its four roles
pnpm db:migrate   # applies the schema
pnpm db:seed      # two hospitals of demo data

# 4. Run
pnpm dev          # API on :4000, web on :3000
```

### Already have PostgreSQL installed?

Skip step 1 entirely. `pnpm db:create` works against any PostgreSQL 15+ —
point it at yours and it creates the database and roles for you:

```bash
# .env
DATABASE_ADMIN_URL=postgresql://postgres:yourpassword@localhost:5432/postgres
```

It is idempotent, so it is safe to re-run; `pnpm db:create -- --drop` recreates
from scratch (and refuses to run against anything that is not localhost).

### Why four database roles

`db:create` makes `hims_owner`, `hims_app`, `hims_platform` and
`hims_analytics` rather than running everything as one user. The separation is
part of the security model, not ceremony: **an API connected as a superuser
silently bypasses every row-level security policy in the schema**, so the
isolation tests would pass while the running system leaked.

| Role | Used by | Privileges |
|---|---|---|
| `hims_owner` | `pnpm db:migrate` | Owns the schema. Not a superuser — trusted extensions work because it owns the database. |
| `hims_app` | The API at runtime | No `BYPASSRLS`. Row-level security applies to every query it makes. |
| `hims_platform` | Break-glass support, cross-tenant jobs | `BYPASSRLS`, deliberately narrow, everything it does is audited. |
| `hims_analytics` | BI / warehouse export | Reporting views only. |

The container's `POSTGRES_USER` stays `postgres` for exactly this reason. Making
it `hims_owner` would make the schema owner a superuser, and the privilege
separation would look correct while being inert.

### Troubleshooting

**`password authentication failed for user "postgres"`**

Something is listening on 5432 but rejecting the credentials. PostgreSQL
returns this same message whether the password is wrong *or* the role does not
exist, so there are two candidates — `pnpm db:create` prints both, with the
commands to check each.

1. **A container from an earlier version of this compose file.** `POSTGRES_USER`
   is read only when the data volume is first initialised, so changing it later
   does nothing until the volume is gone. After pulling an update:

   ```bash
   docker compose -f infra/docker-compose.yml down -v
   docker compose -f infra/docker-compose.yml up -d
   ```

   To see which superuser the running container actually has:

   ```bash
   docker exec hims-postgres psql -U postgres -c "\du"
   ```

   Do **not** work around this by pointing `DATABASE_ADMIN_URL` at the old
   `hims_owner` superuser. That makes the schema owner a superuser, which
   bypasses row-level security entirely — the isolation guarantees would be
   inert while appearing to hold.

2. **A locally installed PostgreSQL already on 5432.** Common on Windows and
   macOS, where the installer registers a service that starts at boot.

   ```powershell
   netstat -ano | findstr :5432      # Windows
   ```
   ```bash
   lsof -nP -iTCP:5432 -sTCP:LISTEN  # macOS
   ss -lptn "sport = :5432"          # Linux
   ```

   Either point `DATABASE_ADMIN_URL` at that server with its own password, or
   move the bundled one aside:

   ```bash
   POSTGRES_PORT=5433 docker compose -f infra/docker-compose.yml up -d
   ```

   then set `:5433` in `DATABASE_ADMIN_URL`, `DATABASE_URL` and
   `DATABASE_MIGRATION_URL`.

**The API refuses to boot.** It validates configuration on startup and exits
rather than running unsafely — placeholder encryption keys, `MASTER_KEY` equal
to `BLIND_INDEX_KEY`, or the two JWT secrets matching will all stop it. The
message names the field.

### Optional services

Object storage and the mail catcher are behind the `extras` profile:

```bash
docker compose -f infra/docker-compose.yml --profile extras up -d
```

> **Note.** MinIO is no longer published on Docker Hub — `minio/minio:latest`
> fails with *"pull access denied … repository does not exist"*. The compose
> file pulls from MinIO's own registry (quay.io) instead, and `MINIO_IMAGE` in
> `.env` overrides it if you need a specific dated `RELEASE` tag or a different
> S3-compatible server. Nothing in the `extras` profile is needed to run the
> application.

### Demo accounts

Two hospitals are seeded, so tenant isolation is visible immediately — sign in
as Mercy and St Jude's patients simply do not exist.

| Account | Role | Password |
|---|---|---|
| `admin@mercy.test` | Hospital administrator | `CorrectHorseBattery7!` |
| `doctor@mercy.test` | Physician | `CorrectHorseBattery7!` |
| `nurse@mercy.test` | Nurse | `CorrectHorseBattery7!` |
| `reception@mercy.test` | Receptionist | `CorrectHorseBattery7!` |
| `pharmacy@mercy.test` | Pharmacist | `CorrectHorseBattery7!` |
| `billing@mercy.test` | Billing officer | `CorrectHorseBattery7!` |

The same six exist at `@stjude.test`.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/01-architecture.md`](docs/01-architecture.md) | Topology, request lifecycle, the two-layer access model, multi-tenancy, module boundaries |
| [`docs/02-data-model.md`](docs/02-data-model.md) | ERD, core tables, encryption tiering, money handling, indexing |
| [`docs/03-api.md`](docs/03-api.md) | Full REST specification with payloads, error codes and rate limits |
| [`docs/04-security-and-hipaa.md`](docs/04-security-and-hipaa.md) | Safeguard mapping, encryption design, audit trail, **and what is deliberately out of scope** |
| [`docs/05-execution-plan.md`](docs/05-execution-plan.md) | Phasing, team shape, risks, definition of done |
| [`docs/06-ui-design.md`](docs/06-ui-design.md) | Clinical UI constraints, validated palette, form choices, accessibility |

---

## What is actually enforced

These are not conventions. Each is a database object, and each is verified by
`apps/api/seeds/verify_invariants.sql`:

| Guarantee | Mechanism | Verified |
|---|---|---|
| One tenant cannot read, write, update or delete another's data | RLS, FORCE'd, on all 65 tenant tables | ✅ 8 checks |
| A provider cannot be double-booked | `EXCLUDE USING gist (provider_id WITH =, slot WITH &&)` | ✅ 5 concurrent requests → 1 booking, 4 × 409 |
| A signed clinical note cannot be edited | `BEFORE UPDATE` trigger; corrections are amendments | ✅ |
| Stock cannot go negative, and the ledger cannot be rewritten | Ledger trigger + append-only guard | ✅ 4 checks |
| Invoice totals always match their lines | `AFTER` trigger recomputing the header | ✅ `8445 − 100 + 375 = 8720` |
| A payment cannot exceed the invoice balance | `BEFORE INSERT` guard on allocations | ✅ |
| The audit trail is tamper-evident | Hash chain + append-only trigger | ✅ a trigger-bypassing edit is still detected |
| No view bypasses row-level security | `security_invoker` assertion at migration time | ✅ |
| Every cascading foreign key is index-backed | Derived in migration 0011 | ✅ |

```
$ psql -d hims_check -f apps/api/seeds/verify_invariants.sql
############ 1. multi-tenant isolation ############
PASS  tenant A sees only its own patient roster
PASS  direct primary-key read of a foreign chart returns nothing
PASS  cross-tenant INSERT refused by WITH CHECK
PASS  no context leak across transactions; unset context returns zero rows
...
############ all invariants verified ############    34 passing, 0 failures
```

---

## Modules

| Module | Highlights |
|---|---|
| **Patients** | Registration with three-tier duplicate detection (blind-index exact match, then fuzzy), encrypted PHI with searchable identifiers, break-glass emergency access |
| **Appointments** | DST-correct availability engine in one SQL query, database-enforced booking, waitlist offers on cancellation, reminder planning in the booking transaction |
| **Clinical** | SOAP documentation with per-section encryption, electronic signing that locks the record, formal amendments, NEWS2 scoring with automatic escalation |
| **Prescriptions** | Allergy and duplicate-therapy screening, controlled-substance authority checks, blocking warnings that require a documented override |
| **Inventory** | Append-only stock ledger, FEFO batch picking, idempotent low-stock alerting, mandatory second signature on controlled-drug adjustments |
| **Billing** | Price snapshotting, trigger-maintained totals, AR ageing, X12-shaped claim construction with pre-submission validation |
| **Reports** | Read-only transactions, permission-aware projections, HIPAA §164.528 disclosure accounting |

---

## Screenshots

| | |
|---|---|
| ![Patient chart](docs/screenshots/light-04-chart.png) | ![Inventory, dark](docs/screenshots/dark-06-inventory.png) |
| Allergy banner, decrypted PHI, computed BMI and NEWS2, and the access basis shown back to the user | Stock meters with reorder thresholds marked on the track; status carried by glyph and label, never colour alone |

More in [`docs/screenshots/`](docs/screenshots/), including both themes and a
390px ward tablet.

---

## Commands

```bash
pnpm dev                 # API + web
pnpm build               # both
pnpm typecheck           # both — currently clean
pnpm db:create           # create the database and its roles (idempotent)
pnpm db:create -- --drop # drop and recreate (localhost only)
pnpm db:migrate          # apply pending migrations
pnpm db:status           # applied vs pending
pnpm db:verify           # checksums, RLS coverage, audit-chain integrity
pnpm db:seed             # two hospitals of demo data

pnpm --filter @hims/api worker:notifications   # outbox drain
pnpm --filter @hims/api worker:scheduler       # maintenance tasks
```

---

## Project layout

```
apps/
  api/
    migrations/      13 ordered SQL migrations; the authoritative schema
    seeds/           verify_invariants.sql — 34 behavioural checks
    src/
      config/        environment validation; exits on unsafe configuration
      db/            pool, tenant transaction contract, migration runner, seed
      security/      crypto, password, tokens, RBAC
      middleware/    request context, auth, authorize, tenant, audit, errors
      modules/       auth, patients, appointments, clinical, prescriptions,
                     inventory, billing, staff, reports, tenants
      jobs/          notification worker, scheduler
  web/
    src/
      app/           App Router pages
      components/    ui primitives, layout shell, charts
      lib/           API client, session, theme, formatters
      styles/        design tokens
docs/                architecture, data model, API, security, plan, UI
infra/               docker compose (bare PostgreSQL + Redis; extras behind a profile)
```

---

## Status

**Phase 0 is complete and verified.** The security model, data model and core
API are production-shaped. Known gaps are named explicitly in
[`docs/04-security-and-hipaa.md §8`](docs/04-security-and-hipaa.md) — chiefly
KMS integration, TOTP verification, a licensed drug-interaction database, and
X12 transmission — and scheduled in
[`docs/05-execution-plan.md`](docs/05-execution-plan.md).

> **This is not a HIPAA-compliant deployment.** It implements the technical
> safeguards; compliance additionally requires BAAs, a risk analysis, workforce
> training, incident response, and physical and administrative safeguards that
> no codebase can supply.
