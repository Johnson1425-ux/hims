# Execution plan

Phasing for a team of 4–6 engineers plus a clinical lead. Durations assume that
cadence; the ordering matters more than the numbers.

The sequencing principle: **build the things that are expensive to retrofit
first.** Tenant isolation, the audit trail and the encryption boundary cannot be
added to a system that already holds patient data without a migration that
touches every table and a re-encryption of everything. Scheduling UI can wait.

---

## Phase 0 — Foundations ✅ *delivered in this repository*

| Deliverable | State |
|---|---|
| Multi-tenant schema, 65 tables, 13 migrations | Applied and verified |
| RLS on every tenant table, with migration-time assertions | 34 invariants passing |
| Envelope encryption + blind indexes | Round-trip verified through the API |
| Hash-chained audit trail | Tamper detection verified |
| Auth: Argon2id, JWT, rotation with reuse detection | Verified end to end |
| Two-layer RBAC | Verified: permission and relationship refusals |
| Migration runner with checksum enforcement | `pnpm db:migrate` |
| Invariant suite | `seeds/verify_invariants.sql` |
| API: auth, patients, appointments, clinical, prescriptions, inventory, billing, staff, reports, tenant | Implemented, typechecked, exercised |
| Web: design system, shell, dashboard, roster, chart, scheduling, inventory, billing | Builds; screenshotted light/dark/mobile |

**Exit criteria met:** two hospitals in one database cannot see each other;
double-booking is impossible under concurrency; signed notes and the stock
ledger are immutable; the audit chain detects tampering.

---

## Phase 1 — Close the known gaps (3–4 weeks)

These are named in `docs/04-security-and-hipaa.md §8`. Nothing here is a
surprise; all of it is required before a real patient record is entered.

1. **KMS integration.** Replace the local master key with AWS KMS / Vault.
   The envelope format already carries a key version, so this is a wrapper swap
   plus a re-encryption job.
2. **TOTP MFA.** Schema, challenge and encrypted secret column exist; wire
   verification and enrolment.
3. **Document storage.** Presigned S3 upload/download with SSE-KMS, virus
   scanning on ingest, and the retention-hold honoured by the purge job.
4. **Patient-portal surface.** The permissions (`portal:self_read`,
   `portal:self_booking`) and the service-layer narrowing exist; the portal UI
   does not.
5. **Notification transports.** SMTP/SES and Twilio behind the existing worker
   interface, with the `phi_safe` refusal already enforced.
6. **Test suite.** The invariant suite covers the database. Add Vitest coverage
   for the services, and Playwright for the three flows where a regression is a
   clinical incident: prescribing against an allergy, dispensing against stock,
   and cross-tenant access.

**Exit:** a penetration test against a staging deployment, and a restore
rehearsal from an encrypted backup.

---

## Phase 2 — Clinical depth (6–8 weeks)

The modules a hospital will not go live without, in the order they block
operations.

| Workstream | Content |
|---|---|
| **Orders & results** | Lab/imaging ordering UI, specimen labelling, result entry, critical-result escalation with acknowledgement tracking (the schema and index exist) |
| **Inpatient** | Wards, beds, admissions, transfers, discharge summaries, the MAR as a working bedside screen |
| **Documentation** | Template-driven notes per specialty, voice dictation, a problem-oriented chart view |
| **Decision support** | Licensed interaction database, renal and weight-based dosing, immunisation schedules, screening recall |
| **Care coordination** | Referral tracking with two-week-wait pathways, discharge planning |

The highest-value item is **critical-result acknowledgement**. The schema
already escalates until acknowledged; the workflow around it — who is paged,
after how long, and what happens if nobody responds — is a clinical governance
decision, not an engineering one, and needs the clinical lead.

---

## Phase 3 — Revenue cycle (4–6 weeks)

| Workstream | Content |
|---|---|
| **Eligibility** | Real-time X12 270/271 at check-in; the schema stores the response |
| **Claims** | 837P/837I generation, clearinghouse transmission, 835 remittance posting |
| **Denials** | Worklist driven by the CARC/RARC codes already stored, appeal tracking against the deadline column |
| **Patient billing** | Statements, payment plans, online payment, financial counselling |
| **Coding** | Charge capture from encounters, coder worklist, CPT/ICD-10 validation before submission |

Denial management is where the money is. The trending query exists
(`/reports/revenue` → `topDenialReasons`); the worklist that acts on it does not.

---

## Phase 4 — Scale and operate (ongoing)

| Workstream | Content |
|---|---|
| **Partitioning** | `audit_events` and `stock_movements` by month, with detach-to-cold-storage |
| **Read replicas** | Route reporting to a replica; the `READ ONLY` transactions are already marked |
| **Caching** | Redis for permission sets and the slot grid, invalidated on write |
| **Observability** | OpenTelemetry traces, per-tenant SLOs, alerting on audit-write failures (currently logged at `error` and nothing more) |
| **FHIR** | An R4 facade over the existing model for interoperability and patient-access rules |
| **Analytics** | De-identified warehouse export for the `hims_analytics` role that already exists |

---

## Team shape

| Role | Count | Focus |
|---|---|---|
| Backend | 2 | API, workers, integrations |
| Frontend | 2 | Clinical surfaces — the highest-risk UI in the product |
| Data/platform | 1 | Migrations, performance, backups, key management |
| Clinical lead | 0.5 | Workflow validation, terminology, safety sign-off |
| Security/compliance | 0.5 | Risk analysis, BAAs, audit review, pen-test coordination |

The clinical lead is not optional. Every screen in Phase 2 encodes a workflow
decision that an engineer is not qualified to make alone, and the cost of
getting one wrong is measured in patient harm rather than churn.

---

## Risks

| Risk | Mitigation |
|---|---|
| **Cross-tenant leak** | Four independent defences; migration-time assertions; the invariant suite in CI |
| **Wrong-patient error** | Duplicate detection at registration; three identifiers in every chart header; MRN on every list row |
| **Alert fatigue** | Blocking warnings are rare and specific; stock alerts are one-per-item-and-location by unique index; NEWS2 escalates only at ≥ 5 |
| **Clinician rejection** | Keyboard-first, `/` to search from anywhere, no modal confirmations in the documentation path |
| **Audit volume** | Partitioning planned; searches audited once per search rather than per row |
| **Key loss** | Crypto-shredding is a feature, so key backup and escrow are a Phase 1 deliverable, not an afterthought |

---

## Definition of done, per feature

1. Database constraints express every invariant the feature claims.
2. Permission *and* relationship checks, with the basis audited.
3. PHI encrypted at the right tier; blind index where exact lookup is needed.
4. Errors translated into language a clinician can act on.
5. The invariant suite extended if a new structural guarantee was added.
6. Light and dark, keyboard-navigable, usable at 390px.
7. Reviewed by the clinical lead where it touches a clinical workflow.
