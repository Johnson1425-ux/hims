# Data model

65 tables across 13 migrations. This document gives the relational map, the
reasoning behind the non-obvious choices, and the invariants the schema
enforces. The authoritative definition is `apps/api/migrations/`.

## Entity-relationship overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TENANCY                                                                      │
│                                                                              │
│   tenants ─┬─< facilities ─┬─< departments                                   │
│            │               └─< inventory_locations                           │
│            ├─< tenant_sequences        (per-tenant MRN / invoice counters)   │
│            └─< everything else, via tenant_id + RLS                          │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ IDENTITY & ACCESS                                                            │
│                                                                              │
│   users ─┬─< user_roles >─ roles ─< role_permissions >─ permissions          │
│          ├─< auth_sessions   (refresh-token families, rotation lineage)      │
│          ├─< auth_tokens     (single-use reset / invitation)                 │
│          └──1 staff_profiles ─┬─< staff_facility_assignments                 │
│                               ├─< staff_credentials                          │
│                               └─< provider_availability                      │
│                                 └─< availability_exceptions                  │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ PATIENT                                                                      │
│                                                                              │
│   patients ─┬─< patient_allergies ──────> inventory_items  (drug-level match)│
│             ├─< patient_conditions ──────> encounters                        │
│             ├─< patient_insurance_policies >─ insurance_payers               │
│             ├─< patient_consents                                             │
│             ├─< form_submissions >─ form_templates                           │
│             ├─< documents                 (object-storage pointers)          │
│             ├─< care_team_members >─ staff_profiles   ← the relationship      │
│             └─< break_glass_grants                     check reads these     │
│             └──0..1 users                 (patient-portal account)           │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ SCHEDULING                                                                   │
│                                                                              │
│   appointment_types ─< appointments >─┬─ patients                            │
│                                       ├─ staff_profiles  (provider)          │
│                                       ├─ facilities / departments            │
│                                       └─< appointment_reminders              │
│   appointment_waitlist >─ appointment_types                                  │
│                                                                              │
│   CONSTRAINT excl_provider_double_booking                                    │
│     EXCLUDE USING gist (provider_id WITH =, slot WITH &&)                    │
│     WHERE status IN ('scheduled','confirmed','checked_in','in_progress')     │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ CLINICAL                                                                     │
│                                                                              │
│   encounters ─┬─< encounter_amendments     (append-only corrections)         │
│               ├─< vital_signs              (BMI generated; NEWS2 computed)   │
│               ├─< diagnostic_orders >─ diagnostic_catalog                    │
│               │     └─< diagnostic_results (critical flag → escalation)      │
│               ├─< prescriptions ─< prescription_items                        │
│               ├─< referrals                                                  │
│               └─< immunisations                                              │
│                                                                              │
│   TRIGGER guard_signed_encounter  → a signed note's narrative is immutable   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ BILLING                                                                      │
│                                                                              │
│   service_items ─< invoice_lines >─ invoices ─┬─< payment_allocations        │
│        └─< payer_price_overrides              │        >─ payments           │
│                                               └─< insurance_claims           │
│                                                     └─< claim_lines          │
│                                                                              │
│   TRIGGER sync_invoice_from_lines   → header totals derived from lines       │
│   TRIGGER guard_allocation_total    → a payment cannot exceed the balance    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ INVENTORY & PHARMACY                                                         │
│                                                                              │
│   suppliers ─< purchase_orders ─< purchase_order_lines >─ inventory_items    │
│                                                               │              │
│   inventory_items ─┬─< stock_batches ──────┐                  │              │
│                    ├─< stock_levels        │  (balances, trigger-maintained) │
│                    ├─< stock_movements ────┘  (THE LEDGER, append-only)      │
│                    └─< stock_alerts                                          │
│                                                                              │
│   prescriptions ─< prescription_items ─< dispense_items >─ dispenses         │
│   medication_administrations     (the MAR: what was actually given)          │
│                                                                              │
│   VIEW v_stock_status (security_invoker)  → the single definition of "low"   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ AUDIT & MESSAGING                                                            │
│                                                                              │
│   audit_events          append-only, hash-chained, records reads AND denials │
│   break_glass_grants    emergency access, mandatory retrospective review     │
│   notifications         transactional outbox  >─ notification_templates      │
│   notification_preferences                      (TCPA / HIPAA channel consent)│
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core tables

### `patients`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Generated **before** insert — it is bound into the AAD of every encrypted column on the row |
| `tenant_id` | uuid FK | RLS discriminator |
| `mrn` | text | `MRN-MGH-000042`, from a per-tenant counter so concurrent registrations cannot collide |
| `given_name` / `family_name` | text | **Tier 2**: plaintext, searchable (see the encryption policy below) |
| `full_name` | text GENERATED | Trigram-indexed for typeahead |
| `date_of_birth` | date | Tier 2 — age drives weight-based dosing |
| `national_id_encrypted` | bytea | **Tier 1**: AES-256-GCM |
| `national_id_blind_index` | bytea | HMAC-SHA256, for exact-match duplicate detection |
| `phone_encrypted` / `_blind_index` | bytea | Same pattern |
| `email_encrypted` / `_blind_index` | bytea | Same pattern |
| `address_encrypted` | bytea | JSON blob |
| `address_region` | text | Kept in the clear for catchment reporting — too coarse to re-identify |
| `merged_into_id` | uuid FK self | Set when this record loses a merge |

Constraints worth noting:

```sql
CHECK ((status = 'deceased') = (deceased_on IS NOT NULL))
CHECK ((status = 'merged')   = (merged_into_id IS NOT NULL))
CHECK (date_of_birth > DATE '1875-01-01' AND date_of_birth <= CURRENT_DATE)
```

Each makes an inconsistent state unrepresentable rather than merely discouraged.

### `appointments`

The exclusion constraint is the point of this table:

```sql
slot tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,

CONSTRAINT excl_provider_double_booking
  EXCLUDE USING gist (provider_id WITH =, slot WITH &&)
  WHERE (status IN ('scheduled','confirmed','checked_in','in_progress'))
```

Two concurrent booking requests that both pass an availability check will both
commit. This constraint is what actually prevents that, and the partial `WHERE`
means cancelling frees the slot for immediate rebooking. *Verified: five
simultaneous requests for one slot produce exactly one booking and four 409s.*

Availability rules are stored as local wall-clock `time` values with a facility
timezone, not fixed offsets — so a clinic that starts at 09:00 still starts at
09:00 the day after a DST change.

### `encounters`

A signed note is a legal document, so:

```sql
status  'draft' → 'in_progress' → 'pending_signature' → 'signed' → 'amended'
```

`guard_signed_encounter()` raises on any UPDATE that would change the narrative,
the diagnosis codes, or the signature once `status` is `signed`. Corrections are
`encounter_amendments` rows referencing the original. `signature_hash` is a
SHA-256 over the serialised clinical content, so a later silent edit — by a bug
or by someone with direct database access — no longer reconciles.

### `stock_movements` — the ledger

Append-only, signed quantities, with a trigger that:

1. Locks the `stock_levels` row (creating it on first movement), serialising
   concurrent dispenses of the same item at the same location.
2. Refuses to let the balance go negative.
3. Updates the batch balance and marks it `depleted` at zero.
4. Stamps `balance_after` onto the row being inserted.

Writing balances directly is the usual source of phantom stock: a failed
dispense that already decremented a counter leaves the shelf and the system
permanently out of step. Here every balance is reconstructible by replaying the
ledger, which is also what the controlled-drug register requires.

### `audit_events`

```sql
prev_hash   bytea        -- digest of the preceding row
event_hash  bytea NOT NULL
```

`chain_audit_event()` computes each row's digest over the previous row's digest
plus this row's identifying fields, under a transaction-scoped advisory lock so
concurrent inserts cannot fork the chain. `verify_audit_chain()` walks it and
reports the first row that does not reconcile.

The trigger blocks UPDATE and DELETE. The **chain** is what catches a privileged
actor who disables the trigger — *verified: a trigger-bypassing edit is detected
at the exact row.*

The `patient_id` column exists so the §164.528 accounting-of-disclosures report
is one indexed query rather than a union across twenty tables.

## Encryption policy

| Tier | Fields | Protection | Why |
|---|---|---|---|
| **1** | national ID, phone, email, address, insurance member number, emergency contact, clinical narrative, intake answers | App-layer AES-256-GCM, per-tenant key, AAD-bound to the row | Direct identifiers and free text; a database dump is useless without the KMS |
| **2** | names, date of birth, sex, clinical codes, observations | RLS + volume encryption + mandatory access audit | Must stay searchable and sortable: a clinician has to find "Okafor, b. 1974-03" under time pressure, and age drives dosing |

This is a deliberate trade, not an oversight. Encrypting names at column level
would push search into the application tier and make duplicate detection
unreliable — which costs patient safety to buy marginal confidentiality against
an attacker who, by assumption, already has the database.

Blind indexes restore exact-match lookup on Tier 1. The limits are explicit:
equality works, ordering does not; equal plaintexts produce equal digests, so an
attacker with the database can see that two patients share a phone number
(not what it is); and low-cardinality fields must never be indexed this way.

## Money

Integer **minor units** throughout, never a float — a rounding drift of one
unit per line across a year of claims is a reconciliation nightmare, and payers
reject remittances that do not balance.

How many minor units make a unit is a property of the **currency**, not the
constant 100, and the `*_cents` suffix means "minor units" rather than
"hundredths". The deployment currency is the Tanzanian shilling (migration
`0014`), which is quoted in whole shillings: the senti is long obsolete, and
ICU's cash-rounding data gives TZS zero fraction digits even though ISO 4217
still nominally lists two. So for TZS the minor unit **is** the shilling, and
nothing is divided on the way to a screen.

That rule lives in exactly one place on each side — `apps/web/src/lib/format.ts`
on the client, the tenant's own `currency` and `locale` columns in the database
— because getting it wrong is not cosmetic. Dividing by a hundred would state
every price in the system at a hundredth of its value, on invoices and claims
alike, and a hospital in Dar es Salaam and one in Nairobi run from the same
deployment with different answers.

Invoice line arithmetic is in generated columns, so it exists in exactly one
place:

```sql
gross_cents  GENERATED ALWAYS AS (round(quantity * unit_price_cents)::integer) STORED
net_cents    GENERATED ALWAYS AS (round(quantity * unit_price_cents)::integer - discount_cents) STORED
tax_cents    GENERATED ALWAYS AS (round((... - discount_cents) * tax_rate)::integer) STORED
```

Headers are maintained by trigger from the lines, so the two can never disagree
regardless of which code path writes them. *Verified: 8445 − 100 + 375 = 8720,
part payment leaves 3720 and `partially_paid`, over-allocation is refused.*

## Indexing

203 indexes before migration 0011, 266 after. The additions are derived rather
than hand-listed: any single-column foreign key with `CASCADE` or `RESTRICT`
semantics that has no index with that column leading gets one.

Two reasons this matters here specifically:

1. Every RLS policy filters on `tenant_id`. Without a leading index, each policy
   check degrades to a sequential scan — on `audit_events` and `stock_movements`
   that is tens of millions of rows per query.
2. `ON DELETE CASCADE` makes the database verify children on every parent
   delete. Archiving one tenant would sequentially scan ~60 tables.

Composite indexes for the hot read paths (the desk queue, the AR ageing
worklist, the controlled-drug register, the disclosure report) are declared
explicitly, because those are access patterns rather than constraint mechanics.

## Partitioning note

`audit_events` and `stock_movements` grow by millions of rows a month at
hospital volume. In production, declare them `PARTITION BY RANGE (occurred_at)`
monthly and detach partitions to cold storage after the retention window. They
are left unpartitioned here so the schema stays readable.
