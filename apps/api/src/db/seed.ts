/**
 * Development seed.
 *
 * Creates two hospitals so that tenant isolation is visible the moment you log
 * in: sign in as Mercy and St Jude's patients are simply not there. Refuses to
 * run against NODE_ENV=production, because seeding a live database with
 * fictional patients and known passwords would be a reportable incident.
 */
import { Client } from 'pg';
import { env, isProduction } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { hashPassword } from '../security/password.js';
import { blindIndex, createFieldCipher, generateTenantDataKey } from '../security/crypto.js';

if (isProduction) {
  logger.fatal('refusing to seed a production database');
  process.exit(1);
}

const DEMO_PASSWORD = 'CorrectHorseBattery7!';

interface SeedTenant {
  slug: string;
  legalName: string;
  displayName: string;
  facilityCode: string;
  timezone: string;
}

const TENANTS: SeedTenant[] = [
  {
    slug: 'mercy',
    legalName: 'Mercy Health Group',
    displayName: 'Mercy General Hospital',
    facilityCode: 'MGH',
    timezone: 'America/New_York',
  },
  {
    slug: 'stjude',
    legalName: 'St Jude Community Clinics',
    displayName: "St Jude's Clinic",
    facilityCode: 'SJC',
    timezone: 'Europe/London',
  },
];

const STAFF = [
  { email: 'admin@{slug}.test', name: 'Amara Diallo', given: 'Amara', family: 'Diallo', role: 'hospital_admin', title: 'Ms.', provider: false },
  { email: 'doctor@{slug}.test', name: 'Ada Okafor', given: 'Ada', family: 'Okafor', role: 'doctor', title: 'Dr.', provider: true },
  { email: 'doctor2@{slug}.test', name: 'Noor Haddad', given: 'Noor', family: 'Haddad', role: 'doctor', title: 'Dr.', provider: true },
  { email: 'nurse@{slug}.test', name: 'Beatrice Lin', given: 'Beatrice', family: 'Lin', role: 'nurse', title: 'RN', provider: false },
  { email: 'reception@{slug}.test', name: 'Tomas Reyes', given: 'Tomas', family: 'Reyes', role: 'receptionist', title: null, provider: false },
  { email: 'pharmacy@{slug}.test', name: 'Priya Raman', given: 'Priya', family: 'Raman', role: 'pharmacist', title: 'PharmD', provider: false },
  { email: 'billing@{slug}.test', name: 'Yusuf Kaya', given: 'Yusuf', family: 'Kaya', role: 'billing_clerk', title: null, provider: false },
];

const PATIENTS = [
  { given: 'Grace', family: 'Mensah', dob: '1974-03-11', sex: 'female', phone: '+15550100001', email: 'grace.mensah@example.test', nationalId: '472-11-8830' },
  { given: 'Hugo', family: 'Silva', dob: '1990-07-02', sex: 'male', phone: '+15550100002', email: 'hugo.silva@example.test', nationalId: '512-44-9001' },
  { given: 'Fatima', family: 'Nasser', dob: '1958-11-23', sex: 'female', phone: '+15550100003', email: 'fatima.nasser@example.test', nationalId: '338-07-2214' },
  { given: 'Daniel', family: 'Osei', dob: '2016-05-18', sex: 'male', phone: '+15550100004', email: null, nationalId: null },
  { given: 'Ingrid', family: 'Lindqvist', dob: '1982-09-30', sex: 'female', phone: '+15550100005', email: 'ingrid.l@example.test', nationalId: '690-22-4417' },
];

const MEDICATIONS = [
  { sku: 'MED-AMOX500', name: 'Amoxicillin 500mg Capsule', generic: 'Amoxicillin', form: 'capsule', strength: '500 mg', route: 'oral', unit: 'capsule', reorder: 200, critical: 50, reorderQty: 1000, cost: 12, sale: 45, controlled: null, highAlert: false },
  { sku: 'MED-PARA500', name: 'Paracetamol 500mg Tablet', generic: 'Paracetamol', form: 'tablet', strength: '500 mg', route: 'oral', unit: 'tablet', reorder: 500, critical: 100, reorderQty: 2000, cost: 3, sale: 12, controlled: null, highAlert: false },
  { sku: 'MED-METF850', name: 'Metformin 850mg Tablet', generic: 'Metformin', form: 'tablet', strength: '850 mg', route: 'oral', unit: 'tablet', reorder: 300, critical: 80, reorderQty: 1200, cost: 8, sale: 30, controlled: null, highAlert: false },
  { sku: 'MED-INSGLA', name: 'Insulin Glargine 100IU/mL', generic: 'Insulin glargine', form: 'injection', strength: '100 IU/mL', route: 'subcutaneous', unit: 'vial', reorder: 20, critical: 6, reorderQty: 60, cost: 2400, sale: 4200, controlled: null, highAlert: true },
  { sku: 'MED-MORPH10', name: 'Morphine Sulfate 10mg/mL', generic: 'Morphine', form: 'injection', strength: '10 mg/mL', route: 'intravenous', unit: 'ampoule', reorder: 30, critical: 10, reorderQty: 100, cost: 180, sale: 350, controlled: 'II', highAlert: true },
  { sku: 'MED-AMLO5', name: 'Amlodipine 5mg Tablet', generic: 'Amlodipine', form: 'tablet', strength: '5 mg', route: 'oral', unit: 'tablet', reorder: 250, critical: 60, reorderQty: 1000, cost: 5, sale: 20, controlled: null, highAlert: false },
  { sku: 'CON-GLOVEM', name: 'Nitrile Examination Gloves (M)', generic: null, form: null, strength: null, route: null, unit: 'box', reorder: 40, critical: 10, reorderQty: 200, cost: 650, sale: 0, controlled: null, highAlert: false },
  { sku: 'CON-SYR5ML', name: 'Disposable Syringe 5mL', generic: null, form: null, strength: null, route: null, unit: 'each', reorder: 500, critical: 150, reorderQty: 2000, cost: 15, sale: 25, controlled: null, highAlert: false },
];

const SERVICES = [
  { code: 'CONS-GP', name: 'General Consultation', category: 'consultation', cpt: '99213', price: 7500 },
  { code: 'CONS-SPEC', name: 'Specialist Consultation', category: 'consultation', cpt: '99244', price: 18000 },
  { code: 'CONS-FOLLOW', name: 'Follow-up Review', category: 'consultation', cpt: '99212', price: 4500 },
  { code: 'LAB-FBC', name: 'Full Blood Count', category: 'diagnostic', cpt: '85025', price: 3200 },
  { code: 'LAB-HBA1C', name: 'HbA1c', category: 'diagnostic', cpt: '83036', price: 4800 },
  { code: 'IMG-CXR', name: 'Chest X-Ray', category: 'diagnostic', cpt: '71046', price: 9500 },
  { code: 'PROC-ECG', name: 'Electrocardiogram', category: 'procedure', cpt: '93000', price: 6000 },
  { code: 'PROC-SUTURE', name: 'Wound Suturing', category: 'procedure', cpt: '12002', price: 14000 },
];

async function main(): Promise<void> {
  const client = new Client({
    connectionString: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
    application_name: 'hims-seed',
  });

  await client.connect();

  try {
    const { rows: existing } = await client.query<{ count: string }>('SELECT count(*) FROM tenants');
    if (Number(existing[0]!.count) > 0) {
      logger.warn('tenants already exist; seed is a no-op. Drop and re-migrate for a clean slate.');
      return;
    }

    const passwordHash = await hashPassword(DEMO_PASSWORD);

    for (const tenant of TENANTS) {
      logger.info({ slug: tenant.slug }, 'seeding tenant');

      // The tenant id is generated first because it is bound into the AAD of
      // the wrapped data key, so the key cannot be lifted to another tenant.
      const { rows: idRows } = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
      const tenantId = idRows[0]!.id;
      const dek = generateTenantDataKey(tenantId);

      await client.query(
        `INSERT INTO tenants (id, slug, legal_name, display_name, facility_code, timezone,
                              dek_wrapped, dek_key_version, status, branding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)`,
        [
          tenantId,
          tenant.slug,
          tenant.legalName,
          tenant.displayName,
          tenant.facilityCode,
          tenant.timezone,
          dek.wrapped,
          dek.keyVersion,
          JSON.stringify({ primaryColor: tenant.slug === 'mercy' ? '#0F6FFF' : '#0E8A6A' }),
        ],
      );

      // Everything below runs with tenant context set, so the seed exercises
      // the same RLS path the application does.
      await client.query('SELECT hims_util.set_request_context($1, NULL, false)', [tenantId]);

      const cipher = createFieldCipher(tenantId, dek.wrapped);

      const { rows: facilityRows } = await client.query<{ id: string }>(
        `INSERT INTO facilities (tenant_id, name, code, kind, city, country, timezone)
         VALUES ($1, $2, 'MAIN', 'hospital', 'Springfield', 'US', $3)
         RETURNING id`,
        [tenantId, `${tenant.displayName} - Main Campus`, tenant.timezone],
      );
      const facilityId = facilityRows[0]!.id;

      const departments: Record<string, string> = {};
      for (const [code, name] of [
        ['GEN', 'General Medicine'],
        ['CARD', 'Cardiology'],
        ['PAED', 'Paediatrics'],
        ['PHARM', 'Pharmacy'],
        ['LAB', 'Laboratory'],
      ] as const) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO departments (tenant_id, facility_id, name, code) VALUES ($1,$2,$3,$4) RETURNING id`,
          [tenantId, facilityId, name, code],
        );
        departments[code] = rows[0]!.id;
      }

      // ---- Staff -------------------------------------------------------------
      const staffIds: Record<string, { userId: string; profileId: string }> = {};

      for (const member of STAFF) {
        const email = member.email.replace('{slug}', tenant.slug);

        const { rows: ids } = await client.query<{ user_id: string; profile_id: string }>(
          'SELECT gen_random_uuid() AS user_id, gen_random_uuid() AS profile_id',
        );
        const { user_id: userId, profile_id: profileId } = ids[0]!;

        await client.query(
          `INSERT INTO users (id, tenant_id, email, password_hash, full_name, status, password_changed_at)
           VALUES ($1,$2,$3,$4,$5,'active', now())`,
          [userId, tenantId, email, passwordHash, member.name],
        );

        const { rows: profileRows } = await client.query<{ id: string }>(
          `INSERT INTO staff_profiles (id, tenant_id, user_id, staff_number, title, given_name, family_name,
                                       primary_department_id, primary_facility_id, is_provider,
                                       specialties, license_number_encrypted, license_expires_on,
                                       default_slot_minutes, consultation_fee_cents, hired_on)
           VALUES ($1,$2,$3, hims_util.allocate_reference($2,'staff','STF'), $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CURRENT_DATE - 400)
           RETURNING id`,
          [
            profileId,
            tenantId,
            userId,
            member.title,
            member.given,
            member.family,
            member.role === 'pharmacist' ? departments.PHARM : departments.GEN,
            facilityId,
            member.provider,
            member.provider ? ['Internal Medicine'] : [],
            member.provider
              ? cipher.encrypt(`LIC-${member.family.toUpperCase()}-7781`, {
                  table: 'staff_profiles',
                  column: 'license_number_encrypted',
                  recordId: profileId,
                })
              : null,
            member.provider ? '2028-12-31' : null,
            member.provider ? 30 : 20,
            member.provider ? 7500 : 0,
          ],
        );

        await client.query(
          `INSERT INTO user_roles (user_id, role_id, granted_by)
           SELECT $1, r.id, NULL FROM roles r WHERE r.key = $2 AND r.tenant_id IS NULL`,
          [userId, member.role],
        );

        // Keyed on the account's local-part, not the role: there are two
        // doctors, and keying on 'doctor' would make the second overwrite the
        // first, leaving every patient assigned to the same clinician.
        const key = member.email.replace('{slug}', tenant.slug).split('@')[0]!;
        staffIds[key] = { userId, profileId: profileRows[0]!.id };
      }

      // ---- Appointment types -------------------------------------------------
      const apptTypes: Record<string, string> = {};
      for (const [code, name, minutes, colour] of [
        ['GP30', 'General Consultation', 30, '#0F6FFF'],
        ['SPEC45', 'Specialist Consultation', 45, '#7C3AED'],
        ['FOLLOW15', 'Follow-up Review', 15, '#0E8A6A'],
        ['TELE20', 'Telehealth Consultation', 20, '#0891B2'],
      ] as const) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO appointment_types (tenant_id, department_id, code, name, duration_minutes,
                                          buffer_after_minutes, modality, colour, base_price_cents)
           VALUES ($1,$2,$3,$4,$5,5,$6,$7,$8)
           RETURNING id`,
          [
            tenantId,
            departments.GEN,
            code,
            name,
            minutes,
            code === 'TELE20' ? 'telehealth' : 'in_person',
            colour,
            minutes >= 45 ? 18000 : 7500,
          ],
        );
        apptTypes[code] = rows[0]!.id;
      }

      // ---- Provider availability: weekday clinics ----------------------------
      for (const profile of [staffIds.doctor!, staffIds.doctor2!]) {
        for (let day = 1; day <= 5; day += 1) {
          await client.query(
            `INSERT INTO provider_availability (tenant_id, staff_profile_id, facility_id, day_of_week,
                                                start_time, end_time, slot_minutes, capacity)
             VALUES ($1,$2,$3,$4,'09:00','13:00',30,1), ($1,$2,$3,$4,'14:00','17:00',30,1)`,
            [tenantId, profile.profileId, facilityId, day],
          );
        }
      }

      // ---- Catalogue ---------------------------------------------------------
      const serviceIds: Record<string, string> = {};
      for (const service of SERVICES) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO service_items (tenant_id, code, name, category, cpt_code, unit_price_cents, tax_rate)
           VALUES ($1,$2,$3,$4,$5,$6, 0)
           RETURNING id`,
          [tenantId, service.code, service.name, service.category, service.cpt, service.price],
        );
        serviceIds[service.code] = rows[0]!.id;
      }

      const { rows: payerRows } = await client.query<{ id: string }>(
        `INSERT INTO insurance_payers (tenant_id, name, code, payer_type, typical_settlement_days)
         VALUES ($1, 'Statewide Health Mutual', 'SHM', 'commercial', 28),
                ($1, 'National Care Plan', 'NCP', 'government', 45),
                ($1, 'Self Pay', 'SELF', 'self_pay', 0)
         RETURNING id`,
        [tenantId],
      );

      const { rows: locationRows } = await client.query<{ id: string }>(
        `INSERT INTO inventory_locations (tenant_id, facility_id, name, code, kind,
                                          allows_controlled, temperature_controlled)
         VALUES ($1,$2,'Main Pharmacy','PH-MAIN','pharmacy', false, true),
                ($1,$2,'Controlled Cabinet','PH-CD','controlled_cabinet', true, false),
                ($1,$2,'Ward Store','WD-STORE','ward', false, false)
         RETURNING id`,
        [tenantId, facilityId],
      );
      const [mainPharmacy, controlledCabinet] = locationRows.map((r) => r.id);

      const { rows: supplierRows } = await client.query<{ id: string }>(
        `INSERT INTO suppliers (tenant_id, name, code, lead_time_days, is_preferred)
         VALUES ($1, 'Meridian Medical Supplies', 'MERID', 5, true)
         RETURNING id`,
        [tenantId],
      );

      // ---- Stock, with a deliberate mix of healthy and low levels ------------
      for (const [index, med] of MEDICATIONS.entries()) {
        const { rows: itemRows } = await client.query<{ id: string }>(
          `INSERT INTO inventory_items (tenant_id, sku, name, is_medication, category, generic_name,
                                        form, strength, route, controlled_schedule, is_high_alert,
                                        base_unit, reorder_level, critical_level, reorder_quantity,
                                        cost_price_cents, sale_price_cents, requires_prescription,
                                        requires_cold_chain, preferred_supplier_id, avg_daily_usage)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           RETURNING id`,
          [
            tenantId,
            med.sku,
            med.name,
            med.generic !== null,
            med.generic !== null ? 'medication' : 'consumable',
            med.generic,
            med.form,
            med.strength,
            med.route,
            med.controlled,
            med.highAlert,
            med.unit,
            med.reorder,
            med.critical,
            med.reorderQty,
            med.cost,
            med.sale,
            med.generic !== null,
            med.sku === 'MED-INSGLA',
            supplierRows[0]!.id,
            Math.round(med.reorder / 8),
          ],
        );

        const itemId = itemRows[0]!.id;
        const location = med.controlled ? controlledCabinet! : mainPharmacy!;

        // Vary the quantities so the stock board shows ok / low / critical and
        // the alert logic has something real to act on.
        const factor = [3, 3, 0.9, 0.4, 0.2, 2.5, 1.5, 3][index] ?? 2;
        const quantity = Math.max(1, Math.round(med.reorder * factor));

        const expiresOn = new Date();
        expiresOn.setDate(expiresOn.getDate() + (index === 2 ? 25 : 400));

        const { rows: batchRows } = await client.query<{ id: string }>(
          `INSERT INTO stock_batches (tenant_id, item_id, location_id, lot_number, expires_on,
                                      supplier_id, unit_cost_cents, quantity_received)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [
            tenantId,
            itemId,
            location,
            `LOT-${2026}-${String(index + 1).padStart(3, '0')}`,
            expiresOn.toISOString().slice(0, 10),
            supplierRows[0]!.id,
            med.cost,
            quantity,
          ],
        );

        await client.query(
          `INSERT INTO stock_movements (tenant_id, item_id, location_id, batch_id, quantity,
                                        movement_type, reason, reference_kind, balance_after, performed_by)
           VALUES ($1,$2,$3,$4,$5,'receipt','Opening stock','manual',0,$6)`,
          [tenantId, itemId, location, batchRows[0]!.id, quantity, staffIds.pharmacy!.userId],
        );
      }

      // ---- Patients ----------------------------------------------------------
      const patientIds: string[] = [];

      for (const [index, patient] of PATIENTS.entries()) {
        const { rows: idRows } = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
        const patientId = idRows[0]!.id;
        const ctx = (column: string) => ({ table: 'patients', column, recordId: patientId });

        await client.query(
          `INSERT INTO patients (id, tenant_id, mrn, given_name, family_name, date_of_birth,
                                 sex_at_birth, preferred_language, blood_type,
                                 national_id_encrypted, national_id_blind_index,
                                 phone_encrypted, phone_blind_index,
                                 email_encrypted, email_blind_index,
                                 address_encrypted, address_region,
                                 emergency_contact_encrypted,
                                 primary_provider_id, registered_facility_id, registered_by)
           VALUES ($1,$2, hims_util.allocate_mrn($2), $3,$4,$5,$6,'en',$7,
                   $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            patientId,
            tenantId,
            patient.given,
            patient.family,
            patient.dob,
            patient.sex,
            ['O+', 'A+', 'B-', 'O-', 'AB+'][index] ?? 'unknown',
            cipher.encrypt(patient.nationalId, ctx('national_id_encrypted')),
            blindIndex(tenantId, 'patient.national_id', patient.nationalId),
            cipher.encrypt(patient.phone, ctx('phone_encrypted')),
            blindIndex(tenantId, 'patient.phone', patient.phone),
            cipher.encrypt(patient.email, ctx('email_encrypted')),
            blindIndex(tenantId, 'patient.email', patient.email),
            cipher.encryptJson(
              { line1: `${index + 12} Elm Street`, city: 'Springfield', region: 'IL', postalCode: '62704' },
              ctx('address_encrypted'),
            ),
            'IL',
            cipher.encryptJson(
              { name: 'Next of Kin', relationship: 'spouse', phone: '+15550199999' },
              ctx('emergency_contact_encrypted'),
            ),
            index % 2 === 0 ? staffIds.doctor!.profileId : staffIds.doctor2!.profileId,
            facilityId,
            staffIds.reception!.userId,
          ],
        );

        patientIds.push(patientId);

        // The care-team row is what later authorises the provider to open the
        // chart; without it the relationship check correctly refuses.
        await client.query(
          `INSERT INTO care_team_members (tenant_id, patient_id, staff_profile_id, relationship, added_by)
           VALUES ($1,$2,$3,'primary',$4)`,
          [
            tenantId,
            patientId,
            index % 2 === 0 ? staffIds.doctor!.profileId : staffIds.doctor2!.profileId,
            staffIds.reception!.userId,
          ],
        );

        // A recorded allergy, so the prescribing interlock has something to
        // fire on in a demo.
        if (index === 0) {
          await client.query(
            `INSERT INTO patient_allergies (tenant_id, patient_id, allergen, allergen_kind,
                                            reaction, severity, recorded_by)
             VALUES ($1,$2,'Amoxicillin','medication','Urticaria and facial swelling','severe',$3)`,
            [tenantId, patientId, staffIds.doctor!.userId],
          );
        }

        if (index === 0) {
          await client.query(
            `INSERT INTO patient_conditions (tenant_id, patient_id, code_system, code, display,
                                             category, clinical_status, onset_on, recorded_by)
             VALUES ($1,$2,'ICD10','J45.909','Unspecified asthma, uncomplicated',
                     'diagnosis','active', CURRENT_DATE - 3100, $3),
                    ($1,$2,'ICD10','E78.5','Hyperlipidaemia, unspecified',
                     'diagnosis','active', CURRENT_DATE - 700, $3)`,
            [tenantId, patientId, staffIds.doctor!.userId],
          );
        }

        if (index === 2) {
          await client.query(
            `INSERT INTO patient_conditions (tenant_id, patient_id, code_system, code, display,
                                             category, clinical_status, onset_on, recorded_by)
             VALUES ($1,$2,'ICD10','E11.9','Type 2 diabetes mellitus without complications',
                     'diagnosis','active', CURRENT_DATE - 1200, $3),
                    ($1,$2,'ICD10','I10','Essential hypertension',
                     'diagnosis','active', CURRENT_DATE - 900, $3)`,
            [tenantId, patientId, staffIds.doctor!.userId],
          );
        }

        const { rows: policyIdRows } = await client.query<{ id: string }>(
          'SELECT gen_random_uuid() AS id',
        );
        const policyId = policyIdRows[0]!.id;

        await client.query(
          `INSERT INTO patient_insurance_policies
             (id, tenant_id, patient_id, payer_id, precedence, plan_name, member_number_encrypted,
              member_number_blind_index, member_number_last4, effective_on, copay_cents,
              coinsurance_rate, verification_status, verified_at)
           VALUES ($1,$2,$3,$4,1,'Standard PPO',$5,$6,$7, CURRENT_DATE - 200, 2500, 0.2, 'active', now())`,
          [
            policyId,
            tenantId,
            patientId,
            payerRows[index % 2]!.id,
            cipher.encrypt(`SHM${900000 + index}`, {
              table: 'patient_insurance_policies',
              column: 'member_number_encrypted',
              recordId: policyId,
            }),
            blindIndex(tenantId, 'policy.member_number', `SHM${900000 + index}`),
            String(900000 + index).slice(-4),
          ],
        );
      }

      // ---- Appointments across the coming fortnight -------------------------
      let booked = 0;
      for (let dayOffset = 0; dayOffset < 10; dayOffset += 1) {
        const day = new Date();
        day.setDate(day.getDate() + dayOffset);

        // Weekends are deliberately included but thinner: a hospital runs seven
        // days, and a demo seeded on a Saturday should not open on an empty
        // board. Outpatient availability rules stay Monday-to-Friday, which is
        // why the slot picker correctly shows nothing at the weekend.
        const isWeekend = day.getDay() === 0 || day.getDay() === 6;
        const hours = isWeekend ? [10, 11] : [9, 10, 11, 14, 15];

        for (const [slotIndex, hour] of hours.entries()) {
          const patientId = patientIds[(dayOffset + slotIndex) % patientIds.length]!;
          const provider = slotIndex % 2 === 0 ? staffIds.doctor! : staffIds.doctor2!;

          const startsAt = new Date(day);
          startsAt.setUTCHours(hour + 4, 0, 0, 0); // roughly local morning
          const endsAt = new Date(startsAt.getTime() + 30 * 60_000);

          // The exclusion constraint may legitimately refuse a generated
          // collision; skip it rather than failing the whole seed.
          try {
            await client.query(
              `INSERT INTO appointments (tenant_id, reference, patient_id, provider_id,
                                         appointment_type_id, facility_id, department_id,
                                         starts_at, ends_at, status, reason_for_visit, booked_by,
                                         checked_in_at, started_at, completed_at)
               VALUES ($1, hims_util.allocate_reference($1,'appointment','APT'), $2,$3,$4,$5,$6,$7,$8,
                       $9, $10, $11,
                       CASE WHEN $9 IN ('checked_in','in_progress','completed')
                            THEN now() - make_interval(mins => 25) END,
                       CASE WHEN $9 IN ('in_progress','completed')
                            THEN now() - make_interval(mins => 12) END,
                       CASE WHEN $9 = 'completed' THEN now() - make_interval(mins => 5) END)`,
              [
                tenantId,
                patientId,
                provider.profileId,
                apptTypes.GP30,
                facilityId,
                departments.GEN,
                startsAt.toISOString(),
                endsAt.toISOString(),
                dayOffset === 0
                  ? (['completed', 'checked_in', 'in_progress', 'checked_in', 'confirmed'][slotIndex] ??
                    'confirmed')
                  : dayOffset < 2
                    ? 'confirmed'
                    : 'scheduled',
                ['Routine review', 'Medication review', 'New symptoms', 'Follow-up'][slotIndex % 4],
                staffIds.reception!.userId,
              ],
            );
            booked += 1;
          } catch {
            // Slot already taken by the generated pattern.
          }
        }
      }

      // ---- One completed visit, so the chart is not empty -------------------
      // The chart reader decrypts these columns with the encounter id in the
      // AAD, so the id has to exist before the ciphertext is produced.
      const { rows: encIdRows } = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
      const encounterId = encIdRows[0]!.id;

      const { rows: encounterRows } = await client.query<{ id: string }>(
        `INSERT INTO encounters (id, tenant_id, reference, patient_id, provider_id, facility_id,
                                 department_id, encounter_class, started_at, ended_at,
                                 chief_complaint, assessment_encrypted, plan_encrypted,
                                 diagnosis_codes, status, signed_by, signed_at, created_by)
         VALUES ($1, $2, hims_util.allocate_reference($2,'encounter','ENC'), $3,$4,$5,$6,'ambulatory',
                 now() - interval '7 days', now() - interval '7 days' + interval '25 minutes',
                 'Persistent cough', $7, $8, $9, 'signed', $4, now() - interval '7 days', $10)
         RETURNING id`,
        [
          encounterId,
          tenantId,
          patientIds[0]!,
          staffIds.doctor!.profileId,
          facilityId,
          departments.GEN,
          cipher.encrypt('Likely post-viral cough. Chest clear, no fever.', {
            table: 'encounters',
            column: 'assessment_encrypted',
            recordId: encounterId,
          }),
          cipher.encrypt('Reassurance, fluids, review in two weeks if persisting.', {
            table: 'encounters',
            column: 'plan_encrypted',
            recordId: encounterId,
          }),
          JSON.stringify([{ system: 'ICD10', code: 'R05.3', display: 'Chronic cough' }]),
          staffIds.doctor!.userId,
        ],
      );

      await client.query(
        `INSERT INTO vital_signs (tenant_id, patient_id, encounter_id, recorded_by,
                                  temperature_c, heart_rate_bpm, respiratory_rate,
                                  systolic_mmhg, diastolic_mmhg, oxygen_saturation,
                                  weight_kg, height_cm, news2_score, recorded_at)
         VALUES ($1,$2,$3,$4, 36.8, 78, 16, 124, 78, 98, 68.5, 165, 0, now() - interval '7 days')`,
        [tenantId, patientIds[0]!, encounterId, staffIds.nurse!.profileId],
      );

      // ---- One invoice, part paid ------------------------------------------
      const { rows: invoiceRows } = await client.query<{ id: string }>(
        `INSERT INTO invoices (tenant_id, invoice_number, patient_id, encounter_id, facility_id,
                               issued_on, due_on, status, billing_stage, created_by)
         VALUES ($1, hims_util.allocate_reference($1,'invoice','INV'), $2,$3,$4,
                 CURRENT_DATE - 7, CURRENT_DATE + 23, 'issued', 'patient_responsibility', $5)
         RETURNING id`,
        [tenantId, patientIds[0]!, encounterId, facilityId, staffIds.billing!.userId],
      );

      await client.query(
        `INSERT INTO invoice_lines (tenant_id, invoice_id, line_no, service_item_id, description,
                                    cpt_code, quantity, unit_price_cents, tax_rate, diagnosis_codes)
         VALUES ($1,$2,1,$3,'General Consultation','99213',1,7500,0,ARRAY['R05.3']),
                ($1,$2,2,$4,'Chest X-Ray','71046',1,9500,0,ARRAY['R05.3'])`,
        [tenantId, invoiceRows[0]!.id, serviceIds['CONS-GP'], serviceIds['IMG-CXR']],
      );

      const { rows: paymentRows } = await client.query<{ id: string }>(
        `INSERT INTO payments (tenant_id, receipt_number, patient_id, amount_cents, method, received_by)
         VALUES ($1, hims_util.allocate_reference($1,'receipt','RCP'), $2, 2500, 'card', $3)
         RETURNING id`,
        [tenantId, patientIds[0]!, staffIds.billing!.userId],
      );

      await client.query(
        `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount_cents)
         VALUES ($1,$2,$3,2500)`,
        [tenantId, paymentRows[0]!.id, invoiceRows[0]!.id],
      );

      logger.info(
        { slug: tenant.slug, patients: patientIds.length, appointments: booked },
        'tenant seeded',
      );
    }

    // ---- Built-in notification templates (tenant_id NULL = shared) ---------
    await client.query('SELECT hims_util.clear_request_context()');

    await client.query(
      `INSERT INTO notification_templates (tenant_id, key, channel, subject, body, phi_safe)
       VALUES
         (NULL, 'appointment_reminder', 'sms', NULL,
          'Reminder: your appointment with {{providerName}} is on {{appointmentDate}} at {{appointmentTime}}, {{locationName}}. Reply STOP to opt out.',
          true),
         (NULL, 'appointment_reminder', 'email', 'Your upcoming appointment',
          'Your appointment with {{providerName}} is scheduled for {{appointmentDate}} at {{appointmentTime}} at {{locationName}}.',
          true),
         (NULL, 'password_reset', 'email', 'Reset your password',
          'Use this link to set a new password: {{resetUrl}}. It expires in one hour.',
          true),
         (NULL, 'staff_invitation', 'email', 'You have been invited',
          'Hello {{fullName}}, set up your account here: {{inviteUrl}}. The link expires in 7 days.',
          true),
         (NULL, 'waitlist_slot_offer', 'sms', NULL,
          'An earlier appointment has become available at {{slotAt}}. Call the clinic within 4 hours to take it.',
          true),
         (NULL, 'stock_alert', 'in_app', 'Stock alert', '{{message}}', true)
       ON CONFLICT DO NOTHING`,
    );

    logger.info(
      { tenants: TENANTS.length, password: DEMO_PASSWORD },
      'seed complete. Sign in with e.g. doctor@mercy.test / reception@stjude.test',
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'seed failed');
  process.exit(1);
});
