# System architecture

## 1. The shape of the problem

A hospital management system is not a CRUD application with a medical theme.
Four properties drive almost every design decision in this repository:

| Property | Consequence |
|---|---|
| **One tenant's data must never reach another** | Isolation is enforced by the database, not by application `WHERE` clauses |
| **Reads are as sensitive as writes** | The audit trail records chart views, not just edits |
| **Some records become legal documents** | Signed notes and the stock ledger are append-only, enforced by triggers |
| **Concurrency errors are clinical errors** | Double-booking and overselling stock are prevented by constraints, not checks |

Everything below follows from those four lines.

## 2. Topology

```
                         ┌──────────────────────────┐
                         │  Browser / ward tablet   │
                         │  Next.js 15 · React 19   │
                         └────────────┬─────────────┘
                     access token (15m, memory only)
                     refresh token (7d, httpOnly cookie)
                                      │
                         ┌────────────▼─────────────┐
                         │  API — Node 22 / Express │
                         │  ───────────────────────  │
                         │  authenticate            │  ← session liveness, idle timeout
                         │  authorize               │  ← permission gate (layer 1)
                         │  runInTenant             │  ← opens the RLS transaction
                         │  handlers + services     │  ← relationship check (layer 2)
                         │  audit writer            │  ← same transaction as the change
                         └────────────┬─────────────┘
                     connects as hims_app (NO bypassrls)
                                      │
              ┌───────────────────────▼────────────────────────┐
              │  PostgreSQL 16                                  │
              │  ─────────────────────────────────────────────  │
              │  Row-Level Security on all 65 tenant tables     │
              │  EXCLUDE constraint   → no double-booking       │
              │  append-only triggers → ledger + audit trail    │
              │  hash-chained audit   → tamper evident          │
              │  envelope-encrypted PHI columns (AES-256-GCM)   │
              └───────────────────────┬────────────────────────┘
                                      │
          ┌───────────────────────────┼────────────────────────────┐
          │                           │                            │
   ┌──────▼──────┐            ┌───────▼────────┐          ┌────────▼───────┐
   │ Object      │            │ Notification   │          │ Scheduler      │
   │ storage     │            │ worker         │          │ (maintenance)  │
   │ (SSE-KMS)   │            │ outbox drain   │          │ advisory locks │
   └─────────────┘            └────────────────┘          └────────────────┘
```

## 3. Request lifecycle

A single request to `GET /api/v1/patients/:id` passes through:

1. **`requestContext`** — assigns a correlation id, echoed as `X-Request-Id`.
2. **`securityHeaders`** — among them `Cache-Control: no-store`, so a shared
   workstation cannot serve the previous user's chart from the back-forward cache.
3. **`apiLimiter`** — keyed per user when signed in, per IP otherwise, so a busy
   ward behind one NAT address does not throttle itself.
4. **`authenticate`** — verifies the JWT, confirms the session row is still live
   (sign-out and the 15-minute idle timeout both take effect immediately), and
   re-resolves permissions from the database when the token is older than 120s.
5. **`requirePermission('patient:read')`** — RBAC layer 1. A refusal is pushed
   onto the audit queue before the 403 is thrown.
6. **`runInTenant`** — opens a transaction, calls
   `hims_util.set_request_context($tenant, $actor, local => true)`, and hands the
   handler a `Queryable` scoped by RLS.
7. **`assertPatientAccess`** — RBAC layer 2. Resolves *why* this user may see
   this patient: care team, treating provider, an appointment, administrative
   necessity, or an active break-glass grant. The reason is returned, not just a
   boolean.
8. **Handler** — reads the row, decrypts the Tier-1 columns with the tenant's
   data key, and queues an audit entry carrying the access basis.
9. **Commit** — the audit row and the business change commit together.

Step 6 is the one worth dwelling on. The session variable is set with
`is_local => true`, so it is scoped to the **transaction**. Behind PgBouncer in
transaction-pooling mode, a session-level `SET` would leak to whichever tenant's
request next borrowed that physical connection. Transaction scope is the only
safe choice, and it is why every request path opens a transaction.

## 4. The two-layer access model

Systems that implement only the permission layer are the reason "staff member
looked up a celebrity's chart" keeps making the news. Both layers are required:

| Layer | Question | Where | Failure mode it prevents |
|---|---|---|---|
| **Permission** | May this *role* do this *kind* of thing? | `requirePermission` | A receptionist signing a clinical note |
| **Relationship** | May this *person* do it to *this patient*? | `assertPatientAccess` | A doctor browsing a chart they have no part in |

Layer 2 returns an `AccessBasis` — `care_team`, `treating_provider`,
`appointment`, `administrative`, `self`, or `break_glass` — and that value is
written to `audit_events.metadata.accessBasis`. "Dr. Okafor opened this chart"
is not an answer in an investigation; "as the named treating provider" is.

Break-glass access is granted **immediately** — arguing about authorisation
while a patient is unconscious is the wrong failure mode — then queued for
mandatory review. The justification has a 20-character minimum enforced by both
the schema and a database `CHECK`, because that text is what makes the later
review possible.

## 5. Multi-tenancy

**Shared schema, `tenant_id` discriminator, PostgreSQL RLS.**

Considered and rejected:

| Model | Why not |
|---|---|
| Schema per tenant | Migrations become O(tenants); 500 hospitals is 500 schema changes per release |
| Database per tenant | Strongest isolation, but connection pooling and cross-tenant reporting become painful, and it is the wrong default before the first enterprise customer asks for it |
| Shared schema, app-level filtering only | One forgotten `WHERE` clause is a cross-tenant PHI breach |

The chosen model gets database-enforced isolation at shared-schema cost. The
API connects as `hims_app`, which holds **no** `BYPASSRLS`; with no tenant
context set, `current_tenant_id()` is NULL, every policy evaluates false, and
queries return zero rows. Failing closed is deliberate.

Three structural guard rails make this durable rather than aspirational, and all
three fail the migration if violated:

1. Every table with a `tenant_id` column must have RLS enabled.
2. Every view must set `security_invoker = true` — a view otherwise runs with
   its *owner's* permissions and silently bypasses RLS on its base tables. This
   regressed once during development and the only visible symptom was duplicated
   rows on the stock board.
3. Every single-column `CASCADE`/`RESTRICT` foreign key must be index-backed.

`seeds/verify_invariants.sql` re-checks all three, plus 31 behavioural
invariants, against a throwaway database.

## 6. Encryption

Envelope encryption, two levels deep:

```
  MASTER KEY (KMS in production, env var in development)
      │ wraps
  TENANT DATA KEY — one per hospital, stored wrapped in tenants.dek_wrapped
      │ encrypts
  FIELD CIPHERTEXT — the *_encrypted bytea columns
```

Per-tenant keys mean one hospital's compromise does not decrypt another's, and
offboarding becomes crypto-shredding (destroy the key) rather than a `DELETE`
that leaves rows in backups for years.

AES-256-GCM binds each ciphertext to its row through Additional Authenticated
Data (`tenant | table | column | record id`). A ciphertext lifted from one
patient's row and pasted into another's fails to decrypt rather than silently
mixing up two charts. The `recordId` is a **required** field on `CryptoContext`
precisely so this cannot be forgotten — which moves a whole class of bug from
"surfaces when someone opens that chart" to "fails at compile time".

Searchability is preserved by **blind indexes**: deterministic HMAC-SHA256 of
the normalised value, namespaced per tenant and per field. Exact match works;
ordering and ranges do not. Reserved for high-entropy identifiers only — a blind
index over a low-cardinality field is trivially brute-forced.

See `docs/04-security-and-hipaa.md` for the full tiering and its rationale.

## 7. Invariants pushed into the database

These cannot live in application code, because two concurrent requests that both
pass an application check will both commit:

| Invariant | Mechanism |
|---|---|
| A provider cannot hold two overlapping bookings | `EXCLUDE USING gist (provider_id WITH =, slot WITH &&)` |
| Stock can never go negative | `BEFORE INSERT` trigger on the ledger |
| The stock ledger cannot be rewritten | `BEFORE UPDATE OR DELETE` trigger that always raises |
| A signed clinical note cannot be edited | Trigger comparing the narrative columns |
| The audit trail cannot be rewritten | Same append-only trigger, plus a hash chain |
| Invoice totals match their lines | `AFTER` trigger recomputing the header |
| A payment cannot exceed the invoice balance | `BEFORE INSERT` guard on allocations |

The API's job is to translate the resulting SQLSTATE into language a clinician
can act on — `23P01` becomes *"That time slot has just been taken."*, not a 500.

## 8. Background work

**Transactional outbox.** The API writes `notifications` rows in the same
transaction as the business change; a worker drains them. This is what keeps
"appointment booked" and "confirmation sent" from diverging when the SMS gateway
is down. Workers claim rows with `FOR UPDATE SKIP LOCKED`, so replicas share the
queue without sending anything twice.

The scheduler runs idempotent maintenance (expire sessions, mark no-shows,
refresh consumption rates, sweep stock alerts, verify the audit chain) under
PostgreSQL advisory locks, so only one replica runs each task.

**No PHI in an SMS.** A text message traverses carriers in the clear and lands
on a lock screen. A reminder may say *when* and *where*; it may not say *why*.
Templates must be explicitly marked `phi_safe` to render over SMS at all, and
the worker refuses rather than sending an unmarked one.

## 9. Module boundaries

```
apps/api/src/
  config/          environment validation — exits on unsafe configuration
  db/              pool, the tenant transaction contract, migration runner, seed
  security/        crypto, password, tokens, RBAC
  middleware/      request context, auth, authorize, tenant, audit, errors, limits
  modules/
    auth/          login, refresh rotation with reuse detection, password reset
    patients/      registration with duplicate detection, chart reads, break-glass
    appointments/  availability engine, booking, reschedule, cancel, check-in
    clinical/      encounters, SOAP documentation, signing, amendments, vitals
    prescriptions/ safety screening, issuing, the pharmacy queue
    inventory/     stock ledger, FEFO dispensing, low-stock alerting
    billing/       invoices, payments, insurance claims
    staff/         directory, roles, credentials, rota
    reports/       dashboards, utilisation, revenue, disclosure accounting
    tenants/       hospital configuration
  jobs/            notification worker, scheduler
```

Each module owns its routes, schemas, service and (where it earns one) a
repository. Routes declare their own permission gates, so a route cannot be
added without a visible `requirePermission` call in the same file.
