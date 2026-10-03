/**
 * Patient persistence.
 *
 * This is the layer where the encryption policy is actually applied, so it is
 * worth being explicit about what happens to each field:
 *
 *   - Tier 1 (national id, phone, email, address, emergency contact) is sealed
 *     with the tenant's data key before it reaches SQL, and a blind index is
 *     written alongside the high-entropy ones so exact lookup still works.
 *   - Tier 2 (names, date of birth, sex) is stored in the clear, because
 *     clinicians must be able to search and sort on it, and relies on RLS,
 *     volume encryption and the access audit instead.
 *
 * Every function takes the tenant-scoped `Queryable`, so RLS is already in
 * force: there is no `WHERE tenant_id = ?` below, and that is deliberate — the
 * database applies it, not the developer's memory.
 */
import type { Queryable } from '../../db/pool.js';
import { blindIndex, type FieldCipher } from '../../security/crypto.js';
import type { CreatePatientInput, SearchPatientsInput, UpdatePatientInput } from './schemas.js';

export interface PatientRow {
  id: string;
  mrn: string;
  given_name: string;
  middle_name: string | null;
  family_name: string;
  preferred_name: string | null;
  full_name: string;
  date_of_birth: Date;
  sex_at_birth: string;
  gender_identity: string | null;
  pronouns: string | null;
  marital_status: string | null;
  blood_type: string | null;
  preferred_language: string;
  requires_interpreter: boolean;
  nationality: string | null;
  national_id_encrypted: Buffer | null;
  phone_encrypted: Buffer | null;
  alt_phone_encrypted: Buffer | null;
  email_encrypted: Buffer | null;
  address_encrypted: Buffer | null;
  address_region: string | null;
  emergency_contact_encrypted: Buffer | null;
  primary_provider_id: string | null;
  primary_provider_name: string | null;
  registered_facility_id: string | null;
  status: string;
  deceased_on: Date | null;
  vip_flag: boolean;
  photo_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PatientSummary {
  id: string;
  mrn: string;
  fullName: string;
  preferredName: string | null;
  dateOfBirth: string;
  age: number;
  sexAtBirth: string;
  status: string;
  primaryProviderName: string | null;
  /** Masked for list views; the full value needs an explicit detail read. */
  phoneMasked: string | null;
  lastSeenAt: string | null;
  vipFlag: boolean;
}

export interface PatientDetail extends Omit<PatientSummary, 'phoneMasked'> {
  middleName: string | null;
  givenName: string;
  familyName: string;
  genderIdentity: string | null;
  pronouns: string | null;
  maritalStatus: string | null;
  bloodType: string | null;
  preferredLanguage: string;
  requiresInterpreter: boolean;
  nationality: string | null;
  nationalId: string | null;
  phone: string | null;
  altPhone: string | null;
  email: string | null;
  address: Record<string, unknown> | null;
  emergencyContact: Record<string, unknown> | null;
  primaryProviderId: string | null;
  registeredFacilityId: string | null;
  photoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

const CRYPTO_TABLE = 'patients';

function ageFrom(dateOfBirth: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  return Math.max(0, age);
}

function isoDay(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * Mask a phone number for list views: enough to confirm the right record over
 * the phone, not enough to be a usable contact list if the screen is
 * photographed or the response is logged.
 */
function maskPhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '••••';
}

export function toSummary(row: PatientRow, cipher: FieldCipher, lastSeenAt: Date | null): PatientSummary {
  const phone = cipher.decrypt(row.phone_encrypted, {
    table: CRYPTO_TABLE,
    column: 'phone_encrypted',
    recordId: row.id,
  });

  return {
    id: row.id,
    mrn: row.mrn,
    fullName: row.full_name,
    preferredName: row.preferred_name,
    dateOfBirth: isoDay(row.date_of_birth)!,
    age: ageFrom(row.date_of_birth),
    sexAtBirth: row.sex_at_birth,
    status: row.status,
    primaryProviderName: row.primary_provider_name,
    phoneMasked: maskPhone(phone),
    lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
    vipFlag: row.vip_flag,
  };
}

export function toDetail(row: PatientRow, cipher: FieldCipher, lastSeenAt: Date | null): PatientDetail {
  const ctx = (column: string) => ({ table: CRYPTO_TABLE, column, recordId: row.id });

  return {
    id: row.id,
    mrn: row.mrn,
    givenName: row.given_name,
    middleName: row.middle_name,
    familyName: row.family_name,
    fullName: row.full_name,
    preferredName: row.preferred_name,
    dateOfBirth: isoDay(row.date_of_birth)!,
    age: ageFrom(row.date_of_birth),
    sexAtBirth: row.sex_at_birth,
    genderIdentity: row.gender_identity,
    pronouns: row.pronouns,
    maritalStatus: row.marital_status,
    bloodType: row.blood_type,
    preferredLanguage: row.preferred_language,
    requiresInterpreter: row.requires_interpreter,
    nationality: row.nationality,
    nationalId: cipher.decrypt(row.national_id_encrypted, ctx('national_id_encrypted')),
    phone: cipher.decrypt(row.phone_encrypted, ctx('phone_encrypted')),
    altPhone: cipher.decrypt(row.alt_phone_encrypted, ctx('alt_phone_encrypted')),
    email: cipher.decrypt(row.email_encrypted, ctx('email_encrypted')),
    address: cipher.decryptJson<Record<string, unknown>>(row.address_encrypted, ctx('address_encrypted')),
    emergencyContact: cipher.decryptJson<Record<string, unknown>>(
      row.emergency_contact_encrypted,
      ctx('emergency_contact_encrypted'),
    ),
    primaryProviderId: row.primary_provider_id,
    primaryProviderName: row.primary_provider_name,
    registeredFacilityId: row.registered_facility_id,
    status: row.status,
    vipFlag: row.vip_flag,
    photoUrl: row.photo_url,
    lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const SELECT_PATIENT = `
  SELECT p.*,
         sp.display_name AS primary_provider_name,
         (SELECT max(e.started_at) FROM encounters e WHERE e.patient_id = p.id) AS last_seen_at
    FROM patients p
    LEFT JOIN staff_profiles sp ON sp.id = p.primary_provider_id
`;

export async function findById(
  db: Queryable,
  patientId: string,
): Promise<(PatientRow & { last_seen_at: Date | null }) | null> {
  const { rows } = await db.query<PatientRow & { last_seen_at: Date | null }>(
    `${SELECT_PATIENT} WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [patientId],
  );
  return rows[0] ?? null;
}

/* ---------------------------------------------------------------------------
 * Duplicate detection
 * ------------------------------------------------------------------------- */

export interface DuplicateCandidate {
  id: string;
  mrn: string;
  fullName: string;
  dateOfBirth: string;
  /** Which signal matched, so the registrar can judge rather than guess. */
  matchedOn: string[];
  confidence: 'exact' | 'strong' | 'possible';
}

/**
 * Find existing charts that may be the same person.
 *
 * Duplicate records are one of the most expensive defects in a hospital
 * system: two charts means half a medication list, a missed allergy and split
 * billing. Checking before insert, and making the registrar acknowledge the
 * candidates, is far cheaper than merging later.
 *
 * Exact-match tiers run against blind indexes, so no decryption is needed.
 */
export async function findDuplicateCandidates(
  db: Queryable,
  tenantId: string,
  input: {
    givenName: string;
    familyName: string;
    dateOfBirth: string;
    nationalId?: string;
    phone?: string;
    email?: string;
  },
): Promise<DuplicateCandidate[]> {
  const nationalIdIndex = blindIndex(tenantId, 'patient.national_id', input.nationalId);
  const phoneIndex = blindIndex(tenantId, 'patient.phone', input.phone);
  const emailIndex = blindIndex(tenantId, 'patient.email', input.email);

  const { rows } = await db.query<{
    id: string;
    mrn: string;
    full_name: string;
    date_of_birth: Date;
    matched_national_id: boolean;
    matched_phone: boolean;
    matched_email: boolean;
    matched_name_dob: boolean;
    name_similarity: number;
  }>(
    `
    SELECT p.id, p.mrn, p.full_name, p.date_of_birth,
           ($1::bytea IS NOT NULL AND p.national_id_blind_index = $1) AS matched_national_id,
           ($2::bytea IS NOT NULL AND p.phone_blind_index = $2)       AS matched_phone,
           ($3::bytea IS NOT NULL AND p.email_blind_index = $3)       AS matched_email,
           (lower(p.family_name) = lower($4) AND p.date_of_birth = $5::date) AS matched_name_dob,
           similarity(p.full_name, $6) AS name_similarity
      FROM patients p
     WHERE p.deleted_at IS NULL
       AND p.status <> 'merged'
       AND (
         ($1::bytea IS NOT NULL AND p.national_id_blind_index = $1)
         OR ($2::bytea IS NOT NULL AND p.phone_blind_index = $2)
         OR ($3::bytea IS NOT NULL AND p.email_blind_index = $3)
         OR (p.date_of_birth = $5::date AND lower(p.family_name) = lower($4))
         -- Fuzzy fallback catches transposed and misspelled names on the same
         -- birth date, which is how most duplicates are actually created.
         OR (p.date_of_birth = $5::date AND similarity(p.full_name, $6) > 0.4)
       )
     ORDER BY matched_national_id DESC, matched_phone DESC, name_similarity DESC
     LIMIT 10
    `,
    [
      nationalIdIndex,
      phoneIndex,
      emailIndex,
      input.familyName,
      input.dateOfBirth,
      `${input.givenName} ${input.familyName}`,
    ],
  );

  return rows.map((row) => {
    const matchedOn: string[] = [];
    if (row.matched_national_id) matchedOn.push('national ID');
    if (row.matched_phone) matchedOn.push('phone number');
    if (row.matched_email) matchedOn.push('email address');
    if (row.matched_name_dob) matchedOn.push('family name and date of birth');
    if (matchedOn.length === 0) matchedOn.push('similar name and date of birth');

    const confidence: DuplicateCandidate['confidence'] = row.matched_national_id
      ? 'exact'
      : row.matched_phone || row.matched_name_dob
        ? 'strong'
        : 'possible';

    return {
      id: row.id,
      mrn: row.mrn,
      fullName: row.full_name,
      dateOfBirth: isoDay(row.date_of_birth)!,
      matchedOn,
      confidence,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Writes
 * ------------------------------------------------------------------------- */

export async function insertPatient(
  db: Queryable,
  tenantId: string,
  input: CreatePatientInput,
  cipher: FieldCipher,
  registeredBy: string,
): Promise<PatientRow & { last_seen_at: Date | null }> {
  // The MRN comes from a per-tenant counter inside the database, so two
  // concurrent registrations cannot collide on it.
  const { rows: mrnRows } = await db.query<{ mrn: string }>(
    'SELECT hims_util.allocate_mrn($1) AS mrn',
    [tenantId],
  );
  const mrn = mrnRows[0]!.mrn;

  // The record id is generated here rather than by the database default,
  // because it is bound into the AAD of every ciphertext on the row.
  const { rows: idRows } = await db.query<{ id: string }>('SELECT gen_random_uuid() AS id');
  const id = idRows[0]!.id;

  const ctx = (column: string) => ({ table: CRYPTO_TABLE, column, recordId: id });

  const { rows } = await db.query<PatientRow & { last_seen_at: Date | null }>(
    `
    INSERT INTO patients (
      id, tenant_id, mrn,
      given_name, middle_name, family_name, preferred_name,
      date_of_birth, sex_at_birth, gender_identity, pronouns,
      marital_status, blood_type, preferred_language, requires_interpreter, nationality,
      national_id_encrypted, national_id_blind_index,
      phone_encrypted, phone_blind_index, alt_phone_encrypted,
      email_encrypted, email_blind_index,
      address_encrypted, address_region, emergency_contact_encrypted,
      primary_provider_id, registered_facility_id, registered_by, registration_source
    ) VALUES (
      $1, $2, $3,
      $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, $13, $14, $15, $16,
      $17, $18,
      $19, $20, $21,
      $22, $23,
      $24, $25, $26,
      $27, $28, $29, $30
    )
    RETURNING *, NULL::timestamptz AS last_seen_at, NULL::text AS primary_provider_name
    `,
    [
      id,
      tenantId,
      mrn,
      input.givenName,
      input.middleName ?? null,
      input.familyName,
      input.preferredName ?? null,
      input.dateOfBirth,
      input.sexAtBirth,
      input.genderIdentity ?? null,
      input.pronouns ?? null,
      input.maritalStatus ?? null,
      input.bloodType ?? null,
      input.preferredLanguage,
      input.requiresInterpreter,
      input.nationality ?? null,
      cipher.encrypt(input.nationalId, ctx('national_id_encrypted')),
      blindIndex(tenantId, 'patient.national_id', input.nationalId),
      cipher.encrypt(input.phone, ctx('phone_encrypted')),
      blindIndex(tenantId, 'patient.phone', input.phone),
      cipher.encrypt(input.altPhone, ctx('alt_phone_encrypted')),
      cipher.encrypt(input.email, ctx('email_encrypted')),
      blindIndex(tenantId, 'patient.email', input.email),
      cipher.encryptJson(input.address ?? null, ctx('address_encrypted')),
      // Region stays in the clear for catchment reporting; too coarse to
      // identify anyone on its own.
      input.address?.region ?? null,
      cipher.encryptJson(input.emergencyContact ?? null, ctx('emergency_contact_encrypted')),
      input.primaryProviderId ?? null,
      input.registeredFacilityId ?? null,
      registeredBy,
      input.registrationSource,
    ],
  );

  return rows[0]!;
}

/**
 * Patch a patient.
 *
 * Built dynamically because a PATCH must not overwrite fields the caller did
 * not mention — and for encrypted columns, "not mentioned" versus "set to
 * null" is the difference between keeping and destroying a phone number.
 */
export async function updatePatient(
  db: Queryable,
  tenantId: string,
  patientId: string,
  input: UpdatePatientInput,
  cipher: FieldCipher,
): Promise<(PatientRow & { last_seen_at: Date | null }) | null> {
  const assignments: string[] = [];
  const params: unknown[] = [patientId];
  const ctx = (column: string) => ({ table: CRYPTO_TABLE, column, recordId: patientId });

  const set = (column: string, value: unknown) => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };

  const plainFields: Array<[keyof UpdatePatientInput, string]> = [
    ['givenName', 'given_name'],
    ['middleName', 'middle_name'],
    ['familyName', 'family_name'],
    ['preferredName', 'preferred_name'],
    ['dateOfBirth', 'date_of_birth'],
    ['sexAtBirth', 'sex_at_birth'],
    ['genderIdentity', 'gender_identity'],
    ['pronouns', 'pronouns'],
    ['maritalStatus', 'marital_status'],
    ['bloodType', 'blood_type'],
    ['preferredLanguage', 'preferred_language'],
    ['requiresInterpreter', 'requires_interpreter'],
    ['nationality', 'nationality'],
    ['primaryProviderId', 'primary_provider_id'],
    ['registeredFacilityId', 'registered_facility_id'],
  ];

  for (const [key, column] of plainFields) {
    if (input[key] !== undefined) set(column, input[key]);
  }

  // Encrypted fields: the ciphertext and its blind index must move together,
  // or search silently stops matching the stored value.
  if (input.nationalId !== undefined) {
    set('national_id_encrypted', cipher.encrypt(input.nationalId, ctx('national_id_encrypted')));
    set('national_id_blind_index', blindIndex(tenantId, 'patient.national_id', input.nationalId));
  }
  if (input.phone !== undefined) {
    set('phone_encrypted', cipher.encrypt(input.phone, ctx('phone_encrypted')));
    set('phone_blind_index', blindIndex(tenantId, 'patient.phone', input.phone));
  }
  if (input.altPhone !== undefined) {
    set('alt_phone_encrypted', cipher.encrypt(input.altPhone, ctx('alt_phone_encrypted')));
  }
  if (input.email !== undefined) {
    set('email_encrypted', cipher.encrypt(input.email, ctx('email_encrypted')));
    set('email_blind_index', blindIndex(tenantId, 'patient.email', input.email));
  }
  if (input.address !== undefined) {
    set('address_encrypted', cipher.encryptJson(input.address, ctx('address_encrypted')));
    set('address_region', input.address?.region ?? null);
  }
  if (input.emergencyContact !== undefined) {
    set(
      'emergency_contact_encrypted',
      cipher.encryptJson(input.emergencyContact, ctx('emergency_contact_encrypted')),
    );
  }

  if (assignments.length === 0) {
    return findById(db, patientId);
  }

  const { rows } = await db.query<PatientRow & { last_seen_at: Date | null }>(
    `UPDATE patients SET ${assignments.join(', ')}
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *, NULL::timestamptz AS last_seen_at, NULL::text AS primary_provider_name`,
    params,
  );

  return rows[0] ?? null;
}

/* ---------------------------------------------------------------------------
 * Search
 * ------------------------------------------------------------------------- */

export interface SearchResult {
  rows: Array<PatientRow & { last_seen_at: Date | null }>;
  total: number;
}

export async function searchPatients(
  db: Queryable,
  tenantId: string,
  input: SearchPatientsInput,
): Promise<SearchResult> {
  const conditions: string[] = ['p.deleted_at IS NULL'];
  const params: unknown[] = [];

  const where = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('$?', `$${params.length}`));
  };

  // Exact-match identifier lookups go through blind indexes. These are the
  // fast paths the front desk actually uses.
  if (input.mrn) where('p.mrn = $?', input.mrn);
  if (input.phone) where('p.phone_blind_index = $?', blindIndex(tenantId, 'patient.phone', input.phone));
  if (input.nationalId) {
    where('p.national_id_blind_index = $?', blindIndex(tenantId, 'patient.national_id', input.nationalId));
  }
  if (input.email) where('p.email_blind_index = $?', blindIndex(tenantId, 'patient.email', input.email));
  if (input.dateOfBirth) where('p.date_of_birth = $?::date', input.dateOfBirth);
  if (input.status) where('p.status = $?', input.status);
  else conditions.push("p.status IN ('active','inactive')");
  if (input.primaryProviderId) where('p.primary_provider_id = $?', input.primaryProviderId);
  if (input.facilityId) where('p.registered_facility_id = $?', input.facilityId);

  // Free text covers name and MRN together, because staff type whichever they
  // have to hand. Trigram similarity tolerates the spelling of a name taken
  // down over the phone.
  if (input.q) {
    params.push(input.q);
    const idx = params.length;
    conditions.push(`(
      p.full_name ILIKE '%' || $${idx} || '%'
      OR p.preferred_name ILIKE '%' || $${idx} || '%'
      OR p.mrn ILIKE '%' || $${idx} || '%'
      OR similarity(p.full_name, $${idx}) > 0.3
    )`);
  }

  const whereClause = conditions.join(' AND ');

  const orderBy =
    input.sort === 'registered'
      ? 'p.created_at DESC'
      : input.sort === 'last_seen'
        ? 'last_seen_at DESC NULLS LAST'
        : 'p.family_name, p.given_name';

  const offset = (input.page - 1) * input.pageSize;

  const { rows: countRows } = await db.query<{ count: string }>(
    `SELECT count(*) FROM patients p WHERE ${whereClause}`,
    params,
  );

  const { rows } = await db.query<PatientRow & { last_seen_at: Date | null }>(
    `${SELECT_PATIENT} WHERE ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ${input.pageSize} OFFSET ${offset}`,
    params,
  );

  return { rows, total: Number(countRows[0]?.count ?? 0) };
}

/** Clinical summary shown on the chart header: allergies, problems, last vitals. */
export async function loadClinicalSummary(
  db: Queryable,
  patientId: string,
): Promise<{
  allergies: Array<{ allergen: string; severity: string; reaction: string | null; kind: string }>;
  conditions: Array<{ code: string; display: string; status: string; onsetOn: string | null }>;
  latestVitals: Record<string, unknown> | null;
  openPrescriptions: number;
  outstandingBalanceCents: number;
}> {
  const [allergies, conditions, vitals, counts] = await Promise.all([
    db.query<{ allergen: string; severity: string; reaction: string | null; allergen_kind: string }>(
      `SELECT allergen, severity, reaction, allergen_kind
         FROM patient_allergies
        WHERE patient_id = $1 AND is_active
        ORDER BY CASE severity
                   WHEN 'anaphylaxis' THEN 0 WHEN 'severe' THEN 1
                   WHEN 'moderate' THEN 2 ELSE 3 END`,
      [patientId],
    ),
    db.query<{ code: string; display: string; clinical_status: string; onset_on: Date | null }>(
      `SELECT code, display, clinical_status, onset_on
         FROM patient_conditions
        WHERE patient_id = $1 AND clinical_status IN ('active','recurrence')
        ORDER BY onset_on DESC NULLS LAST
        LIMIT 20`,
      [patientId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT temperature_c, heart_rate_bpm, respiratory_rate, systolic_mmhg, diastolic_mmhg,
              oxygen_saturation, weight_kg, height_cm, bmi, pain_score, news2_score, recorded_at
         FROM vital_signs
        WHERE patient_id = $1
        ORDER BY recorded_at DESC
        LIMIT 1`,
      [patientId],
    ),
    db.query<{ open_prescriptions: string; outstanding_cents: string }>(
      `SELECT
         (SELECT count(*) FROM prescriptions
           WHERE patient_id = $1 AND status IN ('active','partially_dispensed')) AS open_prescriptions,
         (SELECT COALESCE(sum(balance_cents), 0) FROM invoices
           WHERE patient_id = $1 AND status IN ('issued','partially_paid','overdue')) AS outstanding_cents`,
      [patientId],
    ),
  ]);

  return {
    allergies: allergies.rows.map((r) => ({
      allergen: r.allergen,
      severity: r.severity,
      reaction: r.reaction,
      kind: r.allergen_kind,
    })),
    conditions: conditions.rows.map((r) => ({
      code: r.code,
      display: r.display,
      status: r.clinical_status,
      onsetOn: r.onset_on ? r.onset_on.toISOString().slice(0, 10) : null,
    })),
    latestVitals: vitals.rows[0] ?? null,
    openPrescriptions: Number(counts.rows[0]?.open_prescriptions ?? 0),
    outstandingBalanceCents: Number(counts.rows[0]?.outstanding_cents ?? 0),
  };
}

/** Load the tenant's wrapped data key, needed to build a FieldCipher. */
export async function loadTenantKey(db: Queryable, tenantId: string): Promise<Buffer> {
  const { rows } = await db.query<{ dek_wrapped: Buffer }>(
    'SELECT dek_wrapped FROM tenants WHERE id = $1',
    [tenantId],
  );

  const wrapped = rows[0]?.dek_wrapped;
  if (!wrapped) {
    throw new Error(`tenant ${tenantId} has no data encryption key`);
  }

  return wrapped;
}
