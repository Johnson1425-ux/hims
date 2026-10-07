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

## Platform console

The vendor-side surface, mounted at `/platform` **only when both
`DATABASE_PLATFORM_URL` and `JWT_PLATFORM_SECRET` are configured**. An
installation that has not deliberately turned on cross-tenant access gets a
404 here rather than an authentication prompt in front of a privileged
endpoint.

| Method | Path | Who |
|---|---|---|
| `POST` | `/platform/auth/login` | — |
| `POST` | `/platform/auth/refresh` | refresh cookie |
| `POST` | `/platform/auth/accept-invite` | invitation token |
| `POST` | `/platform/auth/logout` | operator |
| `GET` | `/platform/me` | operator |
| `GET` | `/platform/summary` | operator |
| `GET` | `/platform/tenants` | operator |
| `POST` | `/platform/tenants` | operator |
| `GET` | `/platform/tenants/:id` | operator |
| `PATCH` | `/platform/tenants/:id/status` | operator |
| `PATCH` | `/platform/tenants/:id/plan` | operator |
| `GET` | `/platform/operators` | operator |
| `POST` | `/platform/operators` | **owner** |
| `PATCH` | `/platform/operators/:id` | **owner** |
| `GET` | `/platform/audit` | operator |
| `GET` | `/platform/audit/chain` | operator |
| `GET` | `/platform/break-glass` | operator |

**A platform operator is not a user of any hospital.** They live in
`platform_users`, authenticate against `platform_sessions`, and carry a token
signed with a third secret and an `aud` of `hims:platform`. A hospital token
presented here fails signature verification before a claim is read, and a
console token presented to a tenant route does the same. `hims_app` is
explicitly REVOKEd from the platform tables, so the role serving hospital
traffic cannot read operator credentials at all.

`POST /tenants` is **one transaction**: the tenant row, its wrapped data
encryption key, its first facility, and its first `hospital_admin` in
`invited` state with a single-use link. A tenant without a key cannot decrypt
its own columns, one without a facility cannot register a patient, and one
without an administrator can only be entered by a vendor operator — so any
partial state would need a human to repair it by hand. The response carries
the invitation URL rather than claiming an email was sent; there is no
vendor-side mail template.

`PATCH /tenants/:id/status` moves `tenants.status`, which the login path has
always honoured with `TENANT_SUSPENDED`. It also **revokes every live session**
for that tenant — otherwise suspension would stop new sign-ins while everyone
already working carried on for up to a week on their refresh token. A reason
is required for anything other than `active`, and is recorded on the tenant
and in the audit trail. Archiving is terminal; the console will not reverse it.

**Every platform action is written to `audit_events`** — the same hash-chained
table the clinical path uses — with `platform_actor_id` set and the operator's
email in `actor_label`. A hospital reading its own trail therefore sees what
the vendor did to its account, and sees nothing of what the vendor did to
anyone else's.

### Subscription billing

The vendor's own books — what each hospital pays for the software. Entirely
separate from `/billing`, which is what a patient owes a hospital.

| Method | Path |
|---|---|
| `GET` | `/platform/billing/summary` |
| `GET` | `/platform/billing/plans` |
| `PATCH` | `/platform/billing/plans/:planId` |
| `GET` | `/platform/billing/due` |
| `POST` | `/platform/billing/run` |
| `GET` | `/platform/billing/invoices` |
| `GET` | `/platform/billing/invoices/:invoiceId` |
| `POST` | `/platform/billing/invoices/:invoiceId/payments` |
| `POST` | `/platform/billing/invoices/:invoiceId/void` |
| `POST` | `/platform/billing/payments/:paymentId/void` |
| `GET` | `/platform/tenants/:tenantId/subscription` |
| `PUT` | `/platform/tenants/:tenantId/subscription` |

A **flat fee per tier**, from `subscription_plans`, overridable per hospital
with `tenant_subscriptions.amount_cents`. NULL there means "follow the price
book"; a number is a negotiated contract and deliberately does not move when
the book does.

**An invoice snapshots its price.** Raising a tier next quarter must not
restate an invoice already sent, so the amount and currency are copied at
issue. The vendor's billing currency is also independent of the hospital's
clinical one — a hospital bills patients in TZS and may pay the vendor in USD.

**`POST /billing/run` catches up completely.** A hospital three periods behind
gets three invoices in one run, so the run leaves nothing due and pressing it
twice is a no-op. `GET /billing/due` shows what it would issue, including
`periods_due`, before anything is created. A unique index on
`(tenant_id, period_start, period_end)` is the backstop against two operators
pressing it at once.

**Overdue is derived, never stored** — "issued, past due, not settled", a
function of today's date. `v_subscription_invoice_status` computes it and
`days_overdue`, so nothing has to be scheduled to keep a flag honest. Nothing
is automated off the back of it: an overdue hospital is flagged in the console
and keeps working, because an automated lockout of a clinical system would put
a clinician between a patient and their chart over a billing dispute.

**Payments are recorded by hand.** There is no payment provider and no card
data in the schema; the hospital pays by transfer or mobile money and an
operator records that it arrived. A payment cannot exceed the outstanding
balance, and corrections are made by voiding — never by deletion or a negative
row. The invoice's `amount_paid_cents` and `status` are maintained by a
database trigger that recomputes from the payment rows, so a void and an
insert are the same code path and cannot drift.

#### Getting the invoice to the hospital

Issuing queues **two notifications per hospital administrator** — one
`in_app`, one `email` — in the same transaction as the invoice itself. Both or
neither: an invoice nobody is told about is not delivered, and a notification
for an invoice that rolled back is worse.

Recipients are addressed by **permission, not role**: everyone holding
`tenant:settings`, which is what already gates the hospital's own
configuration screen. A hospital that invents a custom admin role gets the
invoice without anyone updating a list of role names. A hospital with no
active administrator still gets its invoice — the debt is real — and the run
result says so, so an operator can send it on by hand.

| Method | Path | Who |
|---|---|---|
| `GET` | `/subscription-invoices/:id.pdf?token=…` | **public**, signed link |
| `GET` | `/platform/billing/invoices/:id.pdf` | operator |
| `GET` | `/platform/billing/invoices/:id/link` | operator, re-mints the link |

`GET /subscription-invoices/:id.pdf` is **the only unauthenticated route in
the system**. It has to be: the recipient is clicking from a mail client and
has neither a bearer token nor a cookie for the API origin, so an ordinary
authenticated route would simply 401 and the invoice would be undeliverable
by the one channel it most needs to arrive on.

Authority is an HMAC over the invoice id, the tenant and a 90-day expiry,
signed with a **subkey derived from `BLIND_INDEX_KEY` under a fixed label**,
so a signature minted here cannot be presented anywhere else that HMACs with
that secret. The signed tenant is checked against the row, so a token cannot
be re-pointed at another hospital's invoice. **The URL is the credential** —
acceptable for this document, which holds a company name, a period and an
amount and no patient data of any kind, and would not be for anything else.

The PDF is **generated on demand, never stored**. A subscription invoice is a
dozen fields; keeping a blob would buy nothing and cost a consistency problem,
since voiding an invoice or correcting a payment would leave a stored file
that is now a lie somebody has already downloaded. A settled invoice prints
PAID IN FULL and omits the bank details entirely — an invoice marked paid that
still says how to pay invites a second payment — and a voided one prints
VOID — DO NOT PAY above everything else.

Hospitals may **read** their own subscription rows (`tenant_id`-scoped RLS) and
write none of them: `INSERT`, `UPDATE` and `DELETE` are revoked from `hims_app`
on all three tables, so an attempt fails loudly rather than silently matching
nothing.

#### The hospital's own view

| Method | Path | Permission |
|---|---|---|
| `GET` | `/tenant/subscription` | `tenant:settings` |
| `GET` | `/tenant/subscription/invoices/:id.pdf` | `tenant:settings` |

Served over the **ordinary tenant connection**, not the privileged pool. The
SELECT-only policies do the scoping, so a hospital naming another hospital's
invoice id gets a 404 — the row is not visible to the transaction at all, which
is the same answer RLS gives everywhere else and reveals nothing.

The rate shown is **not read from the price book**: `hims_app` has no SELECT on
`subscription_plans`, because the vendor's full price list for every tier and
every customer is none of one hospital's business. It comes from their own
negotiated rate if there is one, else the amount on the last invoice they were
actually sent — which is the better answer anyway, being what they have been
charged rather than what a table says they should be.

Read-only throughout. Terms are a contract between two companies, not a setting.

The PDF here needs **no signed token** because the caller has a session. It is
fetched with the bearer token and handed to the browser as a blob rather than
linked: a plain `<a href>` carries no `Authorization` header and comes back 401,
which is the same trap the emailed signed link exists to avoid for readers with
no session at all.

**No platform endpoint returns patient data.** The break-glass queue returns
counts, the clinician's name and whether a review has happened — not the
patient, not the justification text. A support question that genuinely needs
clinical data is answered by a named person inside that hospital, under that
hospital's own break-glass review.

---

## Health

| Path | Returns |
|---|---|
| `GET /health` | Liveness |
| `GET /health/ready` | Readiness — 503 when the database is unreachable, so the orchestrator stops sending traffic instead of serving 500s |
