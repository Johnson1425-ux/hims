# Security and HIPAA alignment

> **Scope.** This is a *simulated* compliance posture, as the brief asked for.
> It implements the technical safeguards faithfully; it does **not** make a
> deployment HIPAA-compliant. Compliance is an organisational programme — a
> signed BAA with every vendor, a named privacy officer, workforce training, a
> risk analysis, an incident-response plan, and the administrative and physical
> safeguards that no code can supply. Section 8 lists what is deliberately out
> of scope here.

## 1. Technical safeguards, mapped

| § | Requirement | Implementation |
|---|---|---|
| 164.312(a)(1) | Access control | RLS at the database; two-layer RBAC at the API |
| 164.312(a)(2)(i) | Unique user identification | One account per person; no shared logins; staff invitation never sets a password |
| 164.312(a)(2)(ii) | Emergency access | Break-glass grants: instant, logged, time-boxed, reviewed |
| 164.312(a)(2)(iii) | Automatic logoff | 15-minute idle timeout, enforced server-side **and** in the UI |
| 164.312(a)(2)(iv) | Encryption at rest | AES-256-GCM per-tenant envelope encryption on PHI columns |
| 164.312(b) | Audit controls | Append-only, hash-chained trail recording reads, writes and denials |
| 164.312(c)(1) | Integrity | GCM auth tags, signature hashes, append-only triggers, the audit chain |
| 164.312(d) | Person authentication | Argon2id, lockout, MFA-ready, rotation with reuse detection |
| 164.312(e)(1) | Transmission security | TLS required in production (config refuses to boot otherwise) |
| 164.502(b) | Minimum necessary | The relationship layer: permission alone does not open a chart |
| 164.508 | Authorisation | `patient_consents`, append-only; a withdrawal is a new row |
| 164.522 | Restriction requests | `patients.restrictions` jsonb |
| 164.528 | Accounting of disclosures | `GET /reports/patient-access-log/:patientId` |

## 2. Access control

### Layer 1 — permission

37 permissions as `resource:action`, granted to 9 system roles. The matrix is
deliberately explicit rather than hierarchical: least privilege beats
convenience, and "doctor inherits everything nurse has" is how a role quietly
accumulates authority nobody reviewed.

Two grants are withheld from `hospital_admin` on purpose: `encounter:sign` and
`prescription:write`. An administrator is not a clinician, and a system that
lets them sign a note has broken the attribution the record depends on.

### Layer 2 — relationship

`resolvePatientAccess()` answers *why*, not just *whether*:

| Basis | Granted when |
|---|---|
| `self` | A portal account reading its own chart |
| `care_team` | Named on `care_team_members` |
| `treating_provider` | The patient's primary provider |
| `appointment` | Has an appointment with them in the surrounding window |
| `administrative` | Front desk / billing — demographics and money only; they hold no clinical permissions |
| `break_glass` | An active emergency grant |
| `denied` | Everything else |

*Verified: a clinician with no relationship to a newly registered patient is
refused; the same clinician is permitted once a break-glass grant exists, and
the basis is recorded.*

### Privilege escalation

`assertCanGrantRole()` refuses a role outranking the granter's own, and refuses
`platform_admin` from inside a tenant. Without it, `staff:write` is quietly
"become anyone".

## 3. Tenant isolation

The threat is a single forgotten `WHERE tenant_id = ?`. Four defences:

1. **RLS, FORCE'd on all 65 tenant tables.** The API connects as `hims_app`,
   which has no `BYPASSRLS`. With no context, queries return nothing.
2. **Transaction-scoped context.** `set_config(..., is_local => true)` means the
   setting cannot outlive the transaction and leak through a pooled connection.
3. **Per-tenant encryption keys.** Even a failure of (1) yields ciphertext the
   reader's key cannot open — this actually caught a misconfiguration during
   development, when the API was briefly connected as a superuser.
4. **Migration-time assertions.** RLS coverage, `security_invoker` on views, and
   FK index coverage all fail the migration if violated.

Defence (4) earned its place: `v_stock_status` shipped without
`security_invoker`, and because a view runs with its *owner's* permissions by
default, it returned every tenant's stock to every caller. The only visible
symptom was duplicated rows.

### The owner exemption on three tables

`users`, `tenants` and `auth_sessions` are `ENABLE`d but not `FORCE`d (migration
0013). This is deliberate and narrow.

Authentication is a bootstrap problem: a login request knows only an email
address, a refresh request only a cookie. Neither knows the tenant yet, so
neither can set the context every policy keys on. That is what the two
`SECURITY DEFINER` functions exist for — but `FORCE` subjects the table *owner*
to its policies too, so those functions were filtered to nothing and **nobody
could log in**. The failure is invisible when migrations run as a superuser,
which is one more reason development should not do that.

What changes, precisely:

- `hims_app` — the role the API runs as — is **not** the owner. RLS applies to
  it in full, unchanged, on these tables as on every other. *Verified: with a
  tenant context it sees 1 of 2 tenants, 7 of 14 users, 5 of 10 patients; with
  no context it sees nothing; cross-tenant writes still match zero rows.*
- Only the schema owner gains unfiltered access, and only on these three tables.
  The owner is a deploy-time role, not the runtime identity.

The security given up is smaller than it looks: `FORCE` was never a boundary
against the owner, who can issue `ALTER TABLE … NO FORCE` at will. It guards
against *accidental* owner-context queries, and a parameterised function
granted solely to `hims_app` is not that. The alternative — reassigning the
functions to the `BYPASSRLS` role — would require a superuser in the deploy
path, which is a worse trade.

## 4. Encryption

```
  MASTER KEY (KMS in production)
      │ wraps
  TENANT DATA KEY  — per hospital, stored wrapped
      │ encrypts
  FIELD CIPHERTEXT — version ‖ keyVersion ‖ IV(12) ‖ tag(16) ‖ ciphertext
```

- **AES-256-GCM**: confidentiality *and* integrity. A tampered ciphertext fails
  to decrypt rather than yielding garbage.
- **AAD binding**: `tenant | table | column | recordId`. A ciphertext moved
  between rows fails. `recordId` is a required field on the context type, so
  this cannot be omitted by accident — which is why several repositories
  generate the row id before the insert rather than using the column default.
- **Key rotation**: the wire format is self-describing, so a re-encryption job
  can run incrementally.
- **Crypto-shredding**: destroying a tenant's wrapped key renders their data
  unrecoverable, including in backups — a cleaner offboarding than `DELETE`.

### Blind indexes

HMAC-SHA256 of the normalised value, under a key **separate** from the
encryption key (reusing one key for both lets anyone who can compute an index
confirm a guessed plaintext against the ciphertext — the config refuses to boot
if they match). Namespaced per tenant and field, so the same phone number at two
hospitals yields different digests.

Limits, stated rather than glossed:

- Equality works; ordering, ranges and prefix search do not.
- Equal plaintexts produce equal digests, so an attacker with the database can
  see that two patients share a phone number — not what it is.
- **Low-cardinality fields must never be indexed this way.** A blind index over
  a field with few possible values is trivially brute-forced. Reserved for
  national IDs, phones, emails and insurance member numbers.

## 5. Audit trail

Three properties make it worth having:

1. **Reads are recorded.** "Who opened this chart" is the question an
   investigation asks. Writes alone answer the wrong one.
2. **Denials are recorded.** A nurse repeatedly bouncing off a chart they have
   no relationship with is the signal a privacy officer reviews.
3. **It is tamper-evident.** Each row commits to the previous row's digest. The
   trigger blocks UPDATE/DELETE; the **chain** catches a privileged actor who
   disables the trigger.

*Verified: UPDATE and DELETE both rejected; a trigger-bypassing edit is detected
at the exact row by `verify_audit_chain()`, which the scheduler runs nightly and
escalates at `fatal` level.*

**The audit log is not a second copy of the record.** `changes` holds field
names and, for non-sensitive scalars, before/after values. Names on a
`NEVER_RECORD_VALUES` list reduce to `{ "changed": true }`. The audit table
outlives the log retention window, so this matters more here than in the logger.

## 6. Authentication

| Control | Implementation |
|---|---|
| Hashing | Argon2id, OWASP 2024 parameters (19 MiB, t=2, p=1); transparent rehash on login when parameters move |
| Policy | Length-weighted per NIST SP 800-63B, breached-password list, no name or email substrings |
| Lockout | 5 failures → 15 minutes; the counter persists outside the failing transaction |
| Enumeration | Uniform message and comparable timing across every failure mode; a dummy hash is computed for unknown accounts |
| Access token | 15 min, in memory only, permissions re-resolved from the database past a 120s cache TTL |
| Refresh token | 7 days, httpOnly + SameSite=Strict + path-scoped, stored as SHA-256, rotated on use |
| Reuse detection | Replaying a rotated token revokes the whole family |
| Idle timeout | Server-side revocation plus a client-side warning and clear |

Password reset and login both avoid becoming oracles: reset always returns 202,
and the token is consumed before the change so a replayed request cannot reset
twice.

## 7. Transport, headers and logging

- `Cache-Control: no-store` on every API response and every page — a shared
  workstation must not serve the previous user's chart from the bfcache.
- CSP is built per request in `apps/web/src/middleware.ts`, not as a static
  header, because the production policy carries a per-response nonce:
  `script-src 'self' 'nonce-…' 'strict-dynamic'`, with no `'unsafe-inline'`.
  Allowing inline script is close to making the policy decorative, since an
  injected inline `<script>` is the thing it exists to stop. Development is
  looser by design — React Refresh evaluates module code with `eval()`, so hot
  reloading cannot work without `'unsafe-eval'` — and the asymmetry is asserted
  in both directions by `apps/web/scripts/check-csp.mjs`, because a dev
  convenience left in the production policy is invisible: the page works
  either way.
- `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`,
  `Referrer-Policy: no-referrer` (a referrer header can leak a patient id to a
  third party), HSTS in production.
- CORS is an explicit allowlist; the config refuses to boot in production with a
  wildcard or a plaintext origin.
- The logger redacts credentials, direct identifiers and clinical narrative by
  path. Query parameters are never logged — they hold PHI. Route patterns are
  logged, not populated paths, because a URL can embed an MRN.
- **No PHI in SMS.** Templates must be marked `phi_safe` to render on an
  unencrypted channel; the worker refuses rather than sending an unmarked one.
- Card data never enters the system: gateway reference and last four digits only.

## 8. Deliberately out of scope

Named rather than silently absent:

| Gap | Why, and what production needs |
|---|---|
| **MFA verification** | The schema, the login challenge and the encrypted secret column exist; TOTP verification is not wired. Marked in `auth/service.ts` rather than silently passing. |
| **KMS** | Development wraps keys with a local master key from the environment. Production must call AWS/GCP KMS or Vault so the master key never enters application memory. |
| **Drug interaction database** | Allergy, duplicate-therapy and controlled-substance checks are implemented. Drug–drug interaction and renal dosing need a licensed source (First Databank, RxNav). A stub returning "no interactions" would be worse than none. |
| **X12 837/835** | Claims are built, validated and persisted with the exact payload sent. Clearinghouse transmission is an integration point. |
| **Backup encryption and retention** | Policy, not code: 6-year retention under §164.316(b)(2), encrypted backups, tested restores. |
| **BAAs, training, risk analysis, incident response** | Organisational. No amount of code substitutes. |
| **Penetration testing** | This code has not been pen-tested. |

## 9. Verifying the posture

```bash
pnpm db:verify                               # checksums, RLS coverage, audit chain
psql -d hims_check -f apps/api/seeds/verify_invariants.sql   # 34 invariants

# the browser policy, against a running server (web/)
node scripts/check-csp.mjs http://localhost:3000 development
node scripts/check-csp.mjs http://localhost:3000 production
```

The suite asserts, among others: cross-tenant SELECT/INSERT/UPDATE/DELETE are
all blocked; context does not leak across transactions; an unset context returns
zero rows; signed notes reject edits; the ledger and audit trail reject UPDATE
and DELETE; a trigger-bypassing audit edit is still detected; and no view
bypasses RLS.
