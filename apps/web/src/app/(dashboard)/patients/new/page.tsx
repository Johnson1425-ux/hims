'use client';

/**
 * Patient registration.
 *
 * Two things here are not form-filling conveniences.
 *
 * DUPLICATES. The API refuses with 409 and a list of candidates when the
 * details look like someone already on the roster, and refuses outright — not
 * acknowledgeable — on an exact national-ID match. A duplicate record is how a
 * patient ends up with half their history in one chart and half in another, so
 * the refusal is rendered as the list of people it matched and a deliberate
 * confirmation, rather than a validation error to click past.
 *
 * ONE REACHABLE CONTACT. Appointment reminders and results have to reach
 * someone. The server enforces a phone number or an email address; the form
 * says so up front rather than after a round trip.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/shell';
import { Alert, Button, Card, CardHeader } from '@/components/ui/primitives';
import { Checkbox, Field, FieldSet, Select, useFormErrors } from '@/components/ui/forms';
import { useSession } from '@/lib/session';
import { useTenant } from '@/lib/tenant';
import { ApiError, api, type PatientDetail, type StaffMember } from '@/lib/api';

const SEX_AT_BIRTH = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'intersex', label: 'Intersex' },
  { value: 'unknown', label: 'Not recorded' },
];

const MARITAL = ['single', 'married', 'partnered', 'divorced', 'widowed', 'unknown'].map((v) => ({
  value: v,
  label: v.charAt(0).toUpperCase() + v.slice(1),
}));

const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'].map((v) => ({
  value: v,
  label: v === 'unknown' ? 'Not known' : v,
}));

const SOURCES = [
  { value: 'front_desk', label: 'Front desk' },
  { value: 'referral', label: 'Referral' },
  { value: 'emergency', label: 'Emergency' },
  { value: 'portal', label: 'Patient portal' },
  { value: 'import', label: 'Record import' },
];

const LANGUAGES = [
  { value: 'sw', label: 'Kiswahili' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
];

interface FormValues {
  givenName: string;
  middleName: string;
  familyName: string;
  preferredName: string;
  dateOfBirth: string;
  sexAtBirth: string;
  genderIdentity: string;
  pronouns: string;
  maritalStatus: string;
  bloodType: string;
  preferredLanguage: string;
  requiresInterpreter: boolean;
  nationalId: string;
  phone: string;
  altPhone: string;
  email: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  contactName: string;
  contactRelationship: string;
  contactPhone: string;
  primaryProviderId: string;
  registeredFacilityId: string;
  registrationSource: string;
}

const EMPTY: FormValues = {
  givenName: '',
  middleName: '',
  familyName: '',
  preferredName: '',
  dateOfBirth: '',
  sexAtBirth: 'unknown',
  genderIdentity: '',
  pronouns: '',
  maritalStatus: '',
  bloodType: '',
  preferredLanguage: 'sw',
  requiresInterpreter: false,
  nationalId: '',
  phone: '',
  altPhone: '',
  email: '',
  line1: '',
  city: '',
  region: '',
  postalCode: '',
  contactName: '',
  contactRelationship: '',
  contactPhone: '',
  primaryProviderId: '',
  registeredFacilityId: '',
  registrationSource: 'front_desk',
};

export default function RegisterPatientPage() {
  const router = useRouter();
  const { can } = useSession();
  const { tenant } = useTenant();
  const { errors, message, setMessage, reset, capture } = useFormErrors();

  const [values, setValues] = useState<FormValues>(EMPTY);
  const [providers, setProviders] = useState<StaffMember[]>([]);
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const set = useCallback(
    <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
      setValues((current) => ({ ...current, [key]: value })),
    [],
  );

  // Providers are only offered as a convenience; failing to load them must not
  // stop a registration at the front desk, so the failure is swallowed.
  useEffect(() => {
    const controller = new AbortController();

    void api
      .get<StaffMember[]>('/staff', { providersOnly: 'true', pageSize: 100 }, controller.signal)
      .then(({ data }) => setProviders(data))
      .catch(() => undefined);

    return () => controller.abort();
  }, []);

  const facilities = tenant?.facilities ?? [];

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    reset();

    const address =
      values.line1 || values.city || values.region || values.postalCode
        ? {
            line1: values.line1 || undefined,
            city: values.city || undefined,
            region: values.region || undefined,
            postalCode: values.postalCode || undefined,
            country: 'TZ',
          }
        : undefined;

    const emergencyContact =
      values.contactName && values.contactPhone
        ? {
            name: values.contactName,
            relationship: values.contactRelationship || undefined,
            phone: values.contactPhone,
          }
        : undefined;

    try {
      const { data } = await api.post<PatientDetail>('/patients', {
        givenName: values.givenName,
        middleName: values.middleName || undefined,
        familyName: values.familyName,
        preferredName: values.preferredName || undefined,
        dateOfBirth: values.dateOfBirth,
        sexAtBirth: values.sexAtBirth,
        genderIdentity: values.genderIdentity || undefined,
        pronouns: values.pronouns || undefined,
        maritalStatus: values.maritalStatus || undefined,
        bloodType: values.bloodType || undefined,
        preferredLanguage: values.preferredLanguage,
        requiresInterpreter: values.requiresInterpreter,
        nationalId: values.nationalId || undefined,
        phone: values.phone || undefined,
        altPhone: values.altPhone || undefined,
        email: values.email || undefined,
        address,
        emergencyContact,
        primaryProviderId: values.primaryProviderId || undefined,
        registeredFacilityId: values.registeredFacilityId || undefined,
        registrationSource: values.registrationSource,
        acknowledgeDuplicates: acknowledged,
      });

      router.push(`/patients/${data.id}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'DUPLICATE_PATIENT') {
        const candidates = caught.issues
          .filter((issue) => issue.field === 'duplicateCandidate')
          .map((issue) => issue.message);

        setDuplicates(candidates);
        setAcknowledged(false);
        setMessage(caught.message);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        capture(caught);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!can('patient:write')) {
    return (
      <>
        <PageHeader title="Register a patient" breadcrumbs={[{ label: 'Patients', href: '/patients' }]} />
        <Card>
          <Alert tone="info" title="Not available to your role">
            Registering a patient needs the <code>patient:write</code> permission.
          </Alert>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Register a patient"
        subtitle="A record number is allocated on save and cannot be changed afterwards"
        breadcrumbs={[{ label: 'Patients', href: '/patients' }, { label: 'Register' }]}
      />

      {message ? (
        <div className="mb-5">
          <Alert tone={duplicates.length > 0 ? 'warning' : 'critical'} title={duplicates.length > 0 ? 'This may already be a patient here' : 'Not registered'}>
            {message}
          </Alert>
        </div>
      ) : null}

      {duplicates.length > 0 ? (
        <div className="mb-5">
          <Card>
            <CardHeader
              title="Possible matches already on the roster"
              subtitle="Open one of these instead if it is the same person — two records for one patient split their history"
            />
            <ul className="flex flex-col gap-2">
              {duplicates.map((candidate) => (
                <li
                  key={candidate}
                  className="rounded-[var(--radius-md)] p-3 text-[0.875rem]"
                  style={{ background: 'var(--surface-sunken)', color: 'var(--ink)' }}
                >
                  {candidate}
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Checkbox
                name="acknowledgeDuplicates"
                label="I have checked these and this is a different person"
                hint="Recorded against your name in the audit trail."
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
            </div>
            <div className="mt-3 flex gap-2">
              <Link href="/patients">
                <Button type="button" variant="secondary">
                  Search the roster instead
                </Button>
              </Link>
            </div>
          </Card>
        </div>
      ) : null}

      <form onSubmit={submit}>
        <div className="flex flex-col gap-5">
          <Card>
            <FieldSet legend="Identity" description="As written on the document presented.">
              <Field
                name="givenName"
                label="First name"
                required
                autoComplete="off"
                value={values.givenName}
                error={errors.givenName}
                onChange={(e) => set('givenName', e.target.value)}
              />
              <Field
                name="familyName"
                label="Family name"
                required
                autoComplete="off"
                value={values.familyName}
                error={errors.familyName}
                onChange={(e) => set('familyName', e.target.value)}
              />
              <Field
                name="middleName"
                label="Middle name"
                value={values.middleName}
                error={errors.middleName}
                onChange={(e) => set('middleName', e.target.value)}
              />
              <Field
                name="preferredName"
                label="Preferred name"
                hint="What the patient is actually called"
                value={values.preferredName}
                error={errors.preferredName}
                onChange={(e) => set('preferredName', e.target.value)}
              />
              <Field
                name="dateOfBirth"
                label="Date of birth"
                type="date"
                required
                max={new Date().toISOString().slice(0, 10)}
                value={values.dateOfBirth}
                error={errors.dateOfBirth}
                onChange={(e) => set('dateOfBirth', e.target.value)}
              />
              <Select
                name="sexAtBirth"
                label="Sex at birth"
                required
                hint="Clinical reference ranges key off this; gender identity is separate"
                options={SEX_AT_BIRTH}
                value={values.sexAtBirth}
                error={errors.sexAtBirth}
                onChange={(e) => set('sexAtBirth', e.target.value)}
              />
              <Field
                name="genderIdentity"
                label="Gender identity"
                value={values.genderIdentity}
                error={errors.genderIdentity}
                onChange={(e) => set('genderIdentity', e.target.value)}
              />
              <Field
                name="pronouns"
                label="Pronouns"
                placeholder="she/her"
                value={values.pronouns}
                error={errors.pronouns}
                onChange={(e) => set('pronouns', e.target.value)}
              />
              <Field
                name="nationalId"
                label="National ID"
                hint="Encrypted at rest; an exact match blocks a duplicate record"
                value={values.nationalId}
                error={errors.nationalId}
                onChange={(e) => set('nationalId', e.target.value)}
              />
              <Select
                name="maritalStatus"
                label="Marital status"
                placeholder="Not recorded"
                options={MARITAL}
                value={values.maritalStatus}
                error={errors.maritalStatus}
                onChange={(e) => set('maritalStatus', e.target.value)}
              />
            </FieldSet>
          </Card>

          <Card>
            <FieldSet
              legend="Contact"
              description="At least a phone number or an email address — reminders and results have to reach someone."
            >
              <Field
                name="phone"
                label="Phone"
                type="tel"
                placeholder="+255 7xx xxx xxx"
                value={values.phone}
                error={errors.phone}
                onChange={(e) => set('phone', e.target.value)}
              />
              <Field
                name="altPhone"
                label="Alternative phone"
                type="tel"
                value={values.altPhone}
                error={errors.altPhone}
                onChange={(e) => set('altPhone', e.target.value)}
              />
              <Field
                name="email"
                label="Email"
                type="email"
                value={values.email}
                error={errors.email}
                onChange={(e) => set('email', e.target.value)}
              />
              <Select
                name="preferredLanguage"
                label="Preferred language"
                options={LANGUAGES}
                value={values.preferredLanguage}
                error={errors.preferredLanguage}
                onChange={(e) => set('preferredLanguage', e.target.value)}
              />
              <div className="sm:col-span-2">
                <Checkbox
                  name="requiresInterpreter"
                  label="Needs an interpreter"
                  hint="Shown on the appointment board so one can be arranged before the visit."
                  checked={values.requiresInterpreter}
                  onChange={(e) => set('requiresInterpreter', e.target.checked)}
                />
              </div>
            </FieldSet>
          </Card>

          <Card>
            <FieldSet legend="Address">
              <div className="sm:col-span-2">
                <Field
                  name="line1"
                  label="Street"
                  value={values.line1}
                  error={errors.line1}
                  onChange={(e) => set('line1', e.target.value)}
                />
              </div>
              <Field
                name="city"
                label="City"
                value={values.city}
                error={errors.city}
                onChange={(e) => set('city', e.target.value)}
              />
              <Field
                name="region"
                label="Region"
                value={values.region}
                error={errors.region}
                onChange={(e) => set('region', e.target.value)}
              />
              <Field
                name="postalCode"
                label="Postal code"
                value={values.postalCode}
                error={errors.postalCode}
                onChange={(e) => set('postalCode', e.target.value)}
              />
            </FieldSet>
          </Card>

          <Card>
            <FieldSet
              legend="Next of kin"
              description="Who to call. Needed before any procedure, and the field an emergency admission is judged on."
              columns={3}
            >
              <Field
                name="contactName"
                label="Name"
                value={values.contactName}
                error={errors.contactName}
                onChange={(e) => set('contactName', e.target.value)}
              />
              <Field
                name="contactRelationship"
                label="Relationship"
                placeholder="Spouse, parent…"
                value={values.contactRelationship}
                error={errors.contactRelationship}
                onChange={(e) => set('contactRelationship', e.target.value)}
              />
              <Field
                name="contactPhone"
                label="Phone"
                type="tel"
                value={values.contactPhone}
                error={errors.contactPhone}
                onChange={(e) => set('contactPhone', e.target.value)}
              />
            </FieldSet>
          </Card>

          <Card>
            <FieldSet legend="Registration" columns={3}>
              <Select
                name="registeredFacilityId"
                label="Facility"
                placeholder="Not set"
                options={facilities.map((f) => ({ value: f.id, label: f.name }))}
                value={values.registeredFacilityId}
                error={errors.registeredFacilityId}
                onChange={(e) => set('registeredFacilityId', e.target.value)}
              />
              <Select
                name="primaryProviderId"
                label="Primary clinician"
                placeholder="Unassigned"
                options={providers.map((p) => ({ value: p.id, label: p.display_name }))}
                value={values.primaryProviderId}
                error={errors.primaryProviderId}
                onChange={(e) => set('primaryProviderId', e.target.value)}
              />
              <Select
                name="registrationSource"
                label="How they arrived"
                options={SOURCES}
                value={values.registrationSource}
                error={errors.registrationSource}
                onChange={(e) => set('registrationSource', e.target.value)}
              />
            </FieldSet>

            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <Link href="/patients">
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </Link>
              <Button type="submit" variant="primary" loading={submitting} disabled={submitting}>
                {duplicates.length > 0 && acknowledged ? 'Register as a new person' : 'Register patient'}
              </Button>
            </div>
          </Card>
        </div>
      </form>
    </>
  );
}
