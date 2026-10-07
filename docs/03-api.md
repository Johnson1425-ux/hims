# API specification

Base URL: `/api/v1` · JSON throughout · Bearer-token authentication.

## Conventions

**Success**

```jsonc
{
  "data": { /* the resource, or an array of them */ },
  "meta": { /* pagination, totals, access basis, warnings */ }
}
```

**Error**

```jsonc
{
  "error": {
    "code": "SLOT_UNAVAILABLE",
    "message": "That time slot has just been taken. Please pick another.",
    "issues": [{ "field": "startsAt", "message": "..." }],
    "requestId": "8f2c1e40-..."
  }
}
```

Messages are written for a clinician to read. No stack trace, SQL fragment,
constraint name or PHI ever crosses the boundary: unexpected errors are replaced
with a generic message and only logged, against the `requestId` the caller can
quote to support.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Schema rejection; `issues` names the fields |
| `UNAUTHENTICATED` | 401 | Missing, expired or revoked session |
| `FORBIDDEN` | 403 | Permission or care-relationship refusal |
| `NOT_FOUND` | 404 | Also returned for cross-tenant reads — confirming a record exists elsewhere is itself a leak |
| `CONFLICT` | 409 | Generic state conflict |
| `SLOT_UNAVAILABLE` | 409 | Translated from the booking exclusion constraint (`23P01`) |
| `DUPLICATE_PATIENT` | 409 | Registration matched an existing chart |
| `INSUFFICIENT_STOCK` | 409 | The ledger refused to go negative |
| `RECORD_LOCKED` | 409 | Signed note or append-only register |
| `PAYMENT_EXCEEDS_BALANCE` | 409 | Allocation larger than the invoice balance |
| `PRECONDITION_FAILED` | 409 | Workflow-state violation |
| `RATE_LIMITED` | 429 | Tiered per endpoint |
| `TENANT_SUSPENDED` | 403 | Hospital account not active |
| `INTERNAL` | 500/503 | Logged in full, generic to the caller |

### Rate limits

| Scope | Window | Limit | Keyed on |
|---|---|---|---|
| Default API | 1 min | 300 | user, else IP |
| Login | 15 min | 10 | IP + email |
| Password reset | 1 hr | 5 | email |
| Patient search | 1 hr | 400 | user |
| Export / disclosure report | 24 hr | 20 | user |

Patient search and export are limited because they are the insider-abuse and
exfiltration paths, not because of load.

---

## Authentication

### `POST /auth/login`

```jsonc
// request
{ "email": "doctor@mercy.test", "password": "…", "tenantSlug": "mercy", "mfaCode": "123456" }

// 200 — the refresh token is set as an httpOnly cookie, never in the body
{
  "data": {
    "accessToken": "eyJ…",
    "expiresIn": 900,
    "user": {
      "id": "…", "email": "…", "fullName": "Ada Okafor",
      "tenantId": "…", "tenantSlug": "mercy", "tenantName": "Mercy General Hospital",
      "roles": ["doctor"],
      "permissions": ["patient:read", "encounter:sign", …],
      "staffProfileId": "…", "patientId": null,
      "mustChangePassword": false
    }
  }
}
```

`tenantSlug` is required only when the same email exists at more than one
hospital group — common for locums and consultants.

Wrong password, unknown email, locked account and suspended tenant all return
the **same** message with comparable timing, so the endpoint cannot be used to
enumerate staff. The real reason is logged and audited.

### `POST /auth/refresh`

Reads the httpOnly cookie (or `refreshToken` in the body for native clients).
Rotates on every use.

**Reuse detection:** presenting an already-rotated token revokes the entire
session family — the thief and the victim cannot both keep using the session.
*Verified: rotation succeeds; replaying a rotated token returns 401 and kills
the legitimate successor too.*

| Endpoint | Purpose |
|---|---|
| `POST /auth/logout` | Revoke this session |
| `POST /auth/logout-all` | Revoke every session for this user |
| `GET /auth/me` | Rehydrate the signed-in principal |
| `POST /auth/change-password` | Revokes all other sessions on success |
| `POST /auth/password-reset/request` | Always 202, whether or not the address exists |
| `POST /auth/password-reset/complete` | Single-use token; consumed before the change |

---

## Patients

| Method | Path | Permission |
|---|---|---|
| `GET` | `/patients` | `patient:read` |
| `POST` | `/patients` | `patient:write` |
| `GET` | `/patients/:patientId` | `patient:read` + relationship |
| `PATCH` | `/patients/:patientId` | `patient:write` + relationship |
| `POST` | `/patients/:patientId/allergies` | `vitals:write` or `encounter:write` |
| `POST` | `/patients/break-glass` | `patient:read` |

### `GET /patients`

Query: `q`, `mrn`, `phone`, `nationalId`, `email`, `dateOfBirth`, `status`,
`primaryProviderId`, `facilityId`, `page`, `pageSize`, `sort`.

`q` is free text over name and MRN with trigram tolerance. `phone`,
`nationalId` and `email` are **exact-match through blind indexes** — no
decryption of the roster.

List responses mask contact details (`"•••• 0001"`). A roster screen is visible
to anyone standing at the desk; full details require the individual record,
which is an audited read.

Audited once per search with the result count and which criteria were used —
never the values typed in. A 25-row page should not produce 25 audit entries,
but an insider pulling 4,000 results across an afternoon is visible.

### `POST /patients`

```jsonc
{
  "givenName": "Grace", "familyName": "Mensah",
  "dateOfBirth": "1974-03-11", "sexAtBirth": "female",
  "phone": "+15550100001", "email": "…", "nationalId": "472-11-8830",
  "address": { "line1": "12 Elm Street", "city": "Springfield", "region": "IL", "postalCode": "62704" },
  "emergencyContact": { "name": "…", "relationship": "spouse", "phone": "…" },
  "primaryProviderId": "…",
  "acknowledgeDuplicates": false
}
```

Duplicate detection runs **before** insert, in three tiers:

| Tier | Signal | Behaviour |
|---|---|---|
| `exact` | National ID matches | **409, non-overridable** — never a different person |
| `strong` | Phone, or family name + date of birth | 409 with candidates; `acknowledgeDuplicates: true` proceeds |
| `possible` | Trigram-similar name on the same date of birth | Same |

Merging two charts after the fact is expensive and error-prone — half a
medication list, a missed allergy, split billing — so the friction belongs here.

### `GET /patients/:patientId`

Returns the decrypted record plus a clinical summary, and reports **why** access
was permitted:

```jsonc
{
  "data": { "mrn": "MRN-MGH-000001", "nationalId": "472-11-8830", "phone": "+1555…", … },
  "meta": {
    "clinical": {
      "allergies": [{ "allergen": "Amoxicillin", "severity": "severe", "reaction": "Urticaria and facial swelling" }],
      "conditions": [...], "latestVitals": {...},
      "openPrescriptions": 0, "outstandingBalanceCents": 14500
    },
    "accessBasis": "care_team"
  }
}
```

`accessBasis` ∈ `self | care_team | treating_provider | appointment |
administrative | break_glass`, and is written to the audit trail.

A clinician with no relationship gets 403 with a message pointing at the
legitimate route, not a dead end.

### `POST /patients/break-glass`

```jsonc
{ "patientId": "…", "justification": "Patient presented to ED unconscious; treating team requires medication history urgently.", "durationHours": 4 }
```

Granted immediately, logged loudly, queued for mandatory privacy review.
Justification minimum 20 characters, enforced by schema **and** database CHECK.

---

## Appointments

| Method | Path | Permission |
|---|---|---|
| `GET` | `/appointments/types` | `appointment:read` / `portal:self_read` |
| `GET` | `/appointments/availability` | `appointment:write` / `portal:self_booking` |
| `GET` | `/appointments` | `appointment:read` / `portal:self_read` |
| `POST` | `/appointments` | `appointment:write` / `portal:self_booking` |
| `POST` | `/appointments/:id/reschedule` | same |
| `POST` | `/appointments/:id/cancel` | same |
| `POST` | `/appointments/:id/check-in` | `appointment:checkin` |

### `GET /appointments/availability`

Query: `providerId` **or** `departmentId`, `appointmentTypeId` (required),
`from`, `to` (≤ 60 days), `facilityId`, `modality`.

```jsonc
{
  "data": {
    "2026-10-06": [
      { "providerId": "…", "providerName": "Dr. Ada Okafor",
        "startsAt": "2026-10-06T13:30:00.000Z",
        "localDate": "2026-10-06", "localTime": "09:30",
        "timezone": "America/New_York", "remainingCapacity": 1 }
    ]
  },
  "meta": { "totalSlots": 28, "days": 4 }
}
```

Grouped by local date, because that is how a calendar renders it. Slot expansion
happens in one SQL query: expanding 60 days of rules for a department of twenty
clinicians is tens of thousands of candidate slots, and filtering them in Node
would be both slower and a second place for the overlap logic to drift out of
step with the constraint.

Subtracts leave, existing bookings (including the room-turnover buffer), and the
appointment type's notice window.

### `POST /appointments`

Runs `SERIALIZABLE`. The returned slot list is a **hint**; the database holds
the decision. A lost race returns:

```jsonc
{ "error": { "code": "SLOT_UNAVAILABLE", "message": "That time slot has just been taken. Please pick another." } }
```

On success, reminder rows are planned in the same transaction — an appointment
nobody will be reminded about is a no-show waiting to happen, and a reminder for
a booking that failed to save is worse.

### `POST /appointments/:id/reschedule`

The original row is kept and marked `rescheduled`, pointing at its replacement.
Mutating the timestamps in place would erase the fact that the patient was first
offered an earlier date — which matters for access-target reporting and for any
later complaint.

### `POST /appointments/:id/cancel`

Cancelling drops the row out of the exclusion constraint, so the slot is
immediately rebookable, and offers it to the waitlist in priority order.

---

## Clinical

| Method | Path | Permission |
|---|---|---|
| `GET` | `/encounters` | `encounter:read` |
| `GET` | `/encounters/:id` | `encounter:read` |
| `POST` | `/encounters` | `encounter:write` |
| `PATCH` | `/encounters/:id` | `encounter:write` |
| `POST` | `/encounters/:id/sign` | `encounter:sign` |
| `POST` | `/encounters/:id/amendments` | `encounter:write` |
| `POST` | `/encounters/vitals` | `vitals:write` |
| `GET` | `/encounters/patient/:patientId` | `encounter:read` |

`PATCH` accepts `subjective`, `objective`, `assessment`, `plan` (each sealed
individually), plus `diagnosisCodes` and `procedureCodes`, which stay queryable
because claims and reporting depend on them.

`POST /:id/sign` requires the signer to be the authoring clinician, refuses a
note with no assessment, computes the signature hash, and closes the linked
appointment. After this the database refuses narrative edits — `PATCH` returns
`RECORD_LOCKED` with *"File an amendment instead."*

`GET /encounters` is a worklist, not a chart. It returns no narrative, so it
needs no decryption and makes no per-patient access decision — a board left
open on a ward screen names who is being seen, not what was said. It defaults
to `status=unsigned` and orders by the worst NEWS2 recorded during the
encounter, because a deteriorating patient and a routine medication review are
both "unsigned notes" and the clock is the wrong tiebreak. `mine=true` is
resolved from the session's own staff profile, never from a supplied id.

`GET /inventory/locations` lists the stores stock can move through, with
`allows_controlled` — dispensing names the store it picks from, and the ledger
refuses a controlled movement out of a store that is not authorised for one.

`POST /encounters/vitals` computes BMI (a generated column, so every surface
shows the same number) and NEWS2 server-side. A score ≥ 5 queues an in-app
escalation in the same transaction — a deteriorating patient needs a person
told, not a row written.

---

## Prescriptions

| Method | Path | Permission |
|---|---|---|
| `POST` | `/prescriptions/screen` | `prescription:write` |
| `POST` | `/prescriptions` | `prescription:write` |
| `GET` | `/prescriptions/queue` | `prescription:read` / `:dispense` |
| `GET` | `/prescriptions/patient/:id` | `prescription:read` |

### Safety screening

`/screen` is a dry run so the UI can warn before the prescriber commits:

```jsonc
{
  "data": { "warnings": [
    { "severity": "contraindicated", "code": "ALLERGY_AMOXICILLIN", "blocking": true,
      "message": "Amoxicillin 500mg Capsule matches a recorded severe allergy to Amoxicillin (Urticaria and facial swelling)." }
  ]},
  "meta": { "blocking": 1, "total": 1 }
}
```

Checks implemented: recorded allergies (by catalogue id and by generic-name
match), duplicate active therapy, controlled-substance authority (no DEA
registration on file blocks a Schedule II), refill legality by schedule, and
high-alert medication flags.

A **blocking** warning cannot be passed without a matching override carrying a
reason — and both the warning and the reason are persisted on the prescription:

```jsonc
{ "overrides": [{ "code": "ALLERGY_AMOXICILLIN", "reason": "Previously tolerated under supervision; …" }] }
```

Drug–drug interaction checking is an explicit integration point (First Databank
/ RxNav), deliberately **not** stubbed: a stub that silently returns "no
interactions" is more dangerous than its absence.

---

## Inventory & pharmacy

| Method | Path | Permission |
|---|---|---|
| `GET` | `/inventory/stock` | `inventory:read` |
| `POST` | `/inventory/stock/receive` | `inventory:write` |
| `POST` | `/inventory/stock/adjust` | `inventory:write` |
| `GET` | `/inventory/locations` | `inventory:read` |
| `GET` | `/inventory/items` | `inventory:read` / `prescription:write` |
| `GET` | `/inventory/alerts` | `inventory:read` |
| `PATCH` | `/inventory/alerts/:alertId` | `inventory:write` |
| `POST` | `/inventory/dispense` | `prescription:dispense` |

`GET /inventory/stock` returns `stockState` (`ok | low | critical |
out_of_stock | overstocked`) and `daysOfCover` from `v_stock_status` — the
single definition of "low", read by both this endpoint and the alerting job, so
the badge on screen and the alert in someone's inbox can never disagree.

`POST /stock/receive` refuses a controlled drug into a non-controlled location,
a cold-chain item into an unrefrigerated one, and an already-expired batch.

`POST /stock/adjust` requires a **second signature** for controlled substances,
and the witness must be a different member of staff. Writing off a controlled
drug without one is how diversion goes unnoticed.

`POST /inventory/dispense` runs `SERIALIZABLE` and picks batches
**first-expiry-first-out**, spanning several batches when one cannot cover the
quantity. Plain FIFO leaves short-dated stock on the shelf to expire.

---

## Billing

| Method | Path | Permission |
|---|---|---|
| `POST` | `/billing/invoices` | `invoice:write` |
| `GET` | `/billing/service-items` | `invoice:read` / `invoice:write` |
| `GET` | `/billing/invoices` | `invoice:read` |
| `GET` | `/billing/invoices/:id` | `invoice:read` |
| `POST` | `/billing/payments` | `payment:write` |
| `POST` | `/billing/claims` | `claim:write` |

Invoice line prices are **snapshotted** from the catalogue at billing time.
Reading the price through a join at render time would mean an issued invoice
silently changes when someone edits the price list next month.

Pricing precedence: an explicitly quoted price → the payer's negotiated rate →
catalogue list price.

`GET /billing/invoices` returns AR ageing buckets in `meta.ageing`, because
"what is old and who owes it" is the question finance opens with.

`POST /billing/claims` refuses to submit against unverified coverage (the main
cause of avoidable denials) or lines missing CPT codes (which the payer would
reject anyway).

---

## Reports

| Method | Path | Permission |
|---|---|---|
| `GET` | `/reports/dashboard` | any `report:*` |
| `GET` | `/reports/utilisation` | `report:operational` |
| `GET` | `/reports/revenue` | `report:financial` |
| `GET` | `/reports/patient-access-log/:patientId` | `audit:read` |
| `GET` | `/reports/break-glass-review` | `audit:read` |

Every report runs in a `READ ONLY` transaction, so it cannot mutate a chart
however it is written. The dashboard returns `null` for the financial fields
when the caller lacks `report:financial` — the projection is permission-aware,
not filtered client-side.

`patient-access-log` is the HIPAA §164.528 accounting of disclosures: who opened
this record, when, and on what basis. Running it is itself an audited PHI read.

---

## Staff & tenant

| Method | Path | Permission |
|---|---|---|
| `POST` | `/staff` | `staff:write` |
| `GET` | `/staff` | `staff:read` |
| `PUT` | `/staff/:id/availability` | `schedule:manage` |
| `POST` | `/staff/:id/time-off` | `schedule:manage` |
| `GET` | `/tenant` | authenticated |
| `PATCH` | `/tenant` | `tenant:settings` |
| `GET` | `/tenant/facilities` | authenticated |
| `POST` | `/tenant/facilities` | `tenant:settings` |
| `PATCH` | `/tenant/facilities/:id` | `tenant:settings` |
| `GET` | `/tenant/departments` | authenticated |
| `POST` | `/tenant/departments` | `tenant:settings` |
| `PATCH` | `/tenant/departments/:id` | `tenant:settings` |

**There is no DELETE for a facility or a department.** A facility is the
foreign-key target of eleven tables — appointments, encounters, invoices and
stock locations among them — and a department of five more. Removing one would
either cascade clinical history away or null out the site a consultation
happened in. The lifecycle is `is_active`: `PATCH … {"isActive": false}` closes
it, `true` reopens it, and the history keeps resolving either way. The last
open facility cannot be closed, because registration, booking and stock each
need one to point at.

`GET /tenant/facilities` and `GET /tenant/departments` take
`?includeInactive=true` and return every column, for the settings screen. They
are deliberately separate from the `facilities` and `departments` arrays on
`GET /tenant`, which are active-only and feed the pickers on the booking,
registration and stock screens.

`timezone`, on both the tenant and a facility, is validated as a named IANA
zone and stored canonicalised — `us/eastern` is saved as `America/New_York`. A
fixed offset such as `+03:00` is refused: it looks like a timezone but never
observes a daylight-saving transition, so an appointment booked across one
lands an hour out. A facility's `timezone` may be `null`, meaning it follows
the hospital's.

`code` is upper-cased before the uniqueness check on both, so `main` and `MAIN`
cannot both exist. A collision with a closed row says so, and says to reactivate
it rather than invent a second code for the same place.

`POST /staff` sets **no password**: the account is created `invited` with a
single-use token and the invitee chooses their own credential. An administrator
who never knows a colleague's password cannot act as them, which keeps the audit
trail attributable.

Role assignment is guarded: nobody can grant a role outranking their own, and
`platform_admin` cannot be granted from inside a hospital.

`PUT /:id/availability` closes off the previous rules rather than deleting them,
so appointments already booked under the old pattern remain explicable.

---

## Health

| Path | Returns |
|---|---|
| `GET /health` | Liveness |
| `GET /health/ready` | Readiness — 503 when the database is unreachable, so the orchestrator stops sending traffic instead of serving 500s |
