'use client';

/**
 * Patient chart.
 *
 * The header is the clinically important part. Three things have to be legible
 * from arm's length, before any scrolling:
 *
 *   1. ALLERGIES. An anaphylaxis risk gets a full-width red banner, not a chip
 *      in a sidebar. This is the single highest-consequence piece of
 *      information on the screen, and it is the one most often buried.
 *   2. Identity: name, MRN, date of birth — the three fields used to confirm
 *      you are looking at the right person before you act.
 *   3. The basis on which this chart was opened, shown back to the user,
 *      because they should know their access was recorded and on what grounds.
 */
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/shell';
import {
  Field as FormField,
  FieldSet,
  FormDialog,
  Select,
  TextArea,
  useFormErrors,
} from '@/components/ui/forms';
import { PrescribeDialog } from '@/components/clinical/prescribe-dialog';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
  type Tone,
} from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import {
  api,
  ApiError,
  type ClinicalSummary,
  type EncounterTimelineEntry,
  type PatientDetail,
  type PatientPrescription,
} from '@/lib/api';
import { formatAge, formatDate, formatMoney, formatRelative, humanise } from '@/lib/format';
import { IconShield, IconStethoscope } from '@/components/layout/icons';

const SEVERITY_TONE: Record<string, Tone> = {
  anaphylaxis: 'critical',
  severe: 'critical',
  moderate: 'warning',
  mild: 'info',
};

export default function PatientChartPage() {
  const params = useParams<{ patientId: string }>();
  const patientId = params.patientId;
  const { can } = useSession();
  const router = useRouter();

  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [clinical, setClinical] = useState<ClinicalSummary | null>(null);
  const [accessBasis, setAccessBasis] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);

  const [encounters, setEncounters] = useState<EncounterTimelineEntry[]>([]);
  const [medications, setMedications] = useState<PatientPrescription[]>([]);

  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [addingAllergy, setAddingAllergy] = useState(false);
  const [allergy, setAllergy] = useState({
    allergen: '',
    allergenKind: 'medication',
    severity: 'moderate',
    reaction: '',
    onsetOn: '',
  });
  const [breakingGlass, setBreakingGlass] = useState(false);
  const [justification, setJustification] = useState('');
  const [prescribing, setPrescribing] = useState(false);
  const [startingEncounter, setStartingEncounter] = useState(false);

  /**
   * Starting from the chart goes straight into documentation: the clinician is
   * already looking at this patient, so the only thing the dialog on the
   * worklist asks for that matters here is the setting, which defaults.
   */
  async function startEncounter(): Promise<void> {
    setStartingEncounter(true);

    try {
      const { data } = await api.post<{ id: string }>('/encounters', {
        patientId,
        encounterClass: 'ambulatory',
      });
      router.push(`/clinical/${data.id}`);
    } catch (caught) {
      setNotice({
        tone: 'critical',
        text: caught instanceof ApiError ? caught.message : 'The encounter could not be opened.',
      });
      setStartingEncounter(false);
    }
  }

  const editForm = useFormErrors();
  const allergyForm = useFormErrors();
  const glassForm = useFormErrors();

  const reload = () => setReloadToken((n) => n + 1);

  /**
   * Emergency access, requested from the refusal itself.
   *
   * The grant is immediate — a clinician with the patient in front of them
   * cannot wait for an approval — and that is only defensible because it is
   * recorded against their name with their stated reason, expires in hours,
   * and lands in a review queue a privacy officer works through.
   */
  async function requestEmergencyAccess(): Promise<void> {
    glassForm.reset();

    try {
      await api.post('/patients/break-glass', {
        patientId,
        justification,
        durationHours: 8,
      });
      setBreakingGlass(false);
      setJustification('');
      setNotice({
        tone: 'good',
        text: 'Emergency access granted for eight hours, logged against your name and queued for review.',
      });
      reload();
    } catch (caught) {
      glassForm.capture(caught);
    }
  }

  async function saveEdits(): Promise<void> {
    editForm.reset();

    try {
      // Only what changed is sent: a PATCH that resends an unchanged phone
      // number still writes an audit entry saying the phone number was edited.
      const changed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(edit)) {
        const current = (patient as unknown as Record<string, unknown>)?.[key];
        if (value !== (current ?? '')) changed[key] = value === '' ? undefined : value;
      }

      if (Object.keys(changed).length === 0) {
        setEditing(false);
        return;
      }

      await api.patch(`/patients/${patientId}`, changed);
      setEditing(false);
      setNotice({ tone: 'good', text: 'Record updated.' });
      reload();
    } catch (caught) {
      editForm.capture(caught);
    }
  }

  async function addAllergy(): Promise<void> {
    allergyForm.reset();

    try {
      await api.post(`/patients/${patientId}/allergies`, {
        allergen: allergy.allergen,
        allergenKind: allergy.allergenKind,
        severity: allergy.severity,
        reaction: allergy.reaction || undefined,
        onsetOn: allergy.onsetOn || undefined,
      });
      setAddingAllergy(false);
      setAllergy({ allergen: '', allergenKind: 'medication', severity: 'moderate', reaction: '', onsetOn: '' });
      setNotice({
        tone: 'good',
        text: 'Allergy recorded — prescribing will screen against it from now on.',
      });
      reload();
    } catch (caught) {
      allergyForm.capture(caught);
    }
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        const { data, meta } = await api.get<PatientDetail>(`/patients/${patientId}`);
        if (cancelled) return;

        setPatient(data);
        setClinical((meta?.clinical as ClinicalSummary) ?? null);
        setAccessBasis((meta?.accessBasis as string) ?? null);
      } catch (caught) {
        if (!cancelled && caught instanceof ApiError) setError(caught);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [patientId, reloadToken]);

  // The chart's clinical history. Fetched separately because each carries its
  // own access decision and its own audit entry server-side — a failure to
  // read the medication list must not blank the demographics above it.
  useEffect(() => {
    const controller = new AbortController();

    void Promise.all([
      api
        .get<EncounterTimelineEntry[]>(`/encounters/patient/${patientId}`, undefined, controller.signal)
        .catch(() => ({ data: [] as EncounterTimelineEntry[] })),
      api
        .get<PatientPrescription[]>(`/prescriptions/patient/${patientId}`, undefined, controller.signal)
        .catch(() => ({ data: [] as PatientPrescription[] })),
    ]).then(([encounterResult, prescriptionResult]) => {
      setEncounters(encounterResult.data);
      setMedications(prescriptionResult.data);
    });

    return () => controller.abort();
  }, [patientId, reloadToken]);

  if (loading) {
    return (
      <>
        <Skeleton className="w-64" height={28} />
        <div className="mt-6 grid gap-5 lg:grid-cols-[2fr_1fr]">
          <Skeleton height={240} />
          <Skeleton height={240} />
        </div>
      </>
    );
  }

  // A refusal is a teaching moment, not a dead end: it says why, and offers
  // the legitimate route (emergency access) rather than leaving staff stuck.
  if (error?.code === 'FORBIDDEN') {
    return (
      <>
        <PageHeader title="Chart not available" breadcrumbs={[{ label: 'Patients', href: '/patients' }]} />
        <Card>
          <Alert tone="warning" title="You are not part of this patient's care team">
            {error.message}
          </Alert>
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-[0.875rem]" style={{ color: 'var(--ink-secondary)' }}>
              If this patient is in front of you and you need their record now, you can request
              emergency access. It is granted immediately, logged against your name with the reason
              you give, and reviewed afterwards by the privacy officer.
            </p>
            <div>
              <Button
                variant="secondary"
                icon={<IconShield />}
                onClick={() => {
                  glassForm.reset();
                  setBreakingGlass(true);
                }}
              >
                Request emergency access
              </Button>
            </div>
          </div>
        </Card>

      <FormDialog
        open={breakingGlass}
        onClose={() => setBreakingGlass(false)}
        title="Request emergency access"
        description="Granted immediately, for eight hours, and reviewed afterwards"
        submitLabel="Break the glass"
        submitTone="danger"
        message={glassForm.message}
        disabled={justification.trim().length < 20}
        onSubmit={requestEmergencyAccess}
      >
        <Alert tone="serious" title="This is recorded against your name">
          Emergency access exists because a clinician with a patient in front of them cannot wait
          for an approval. It is defensible only because of what follows: your reason, your name,
          an expiry in hours, and a review queue a privacy officer works through — including a count
          of what you actually did with the access.
        </Alert>
        <TextArea
          name="justification"
          label="Why do you need this record now?"
          required
          rows={4}
          hint="At least twenty characters. This is the sentence the privacy officer reads."
          value={justification}
          error={glassForm.errors.justification}
          onChange={(event) => setJustification(event.target.value)}
        />
      </FormDialog>
      </>
    );
  }

  if (error || !patient) {
    return (
      <>
        <PageHeader title="Chart not available" breadcrumbs={[{ label: 'Patients', href: '/patients' }]} />
        <Card>
          <Alert tone="critical" title="Could not load this record">
            {error?.message ?? 'The record could not be found.'}
          </Alert>
        </Card>
      </>
    );
  }

  const criticalAllergies =
    clinical?.allergies.filter((a) => a.severity === 'anaphylaxis' || a.severity === 'severe') ?? [];

  return (
    <>
      <PageHeader
        title={patient.fullName}
        breadcrumbs={[{ label: 'Patients', href: '/patients' }, { label: patient.mrn }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="tabular">{patient.mrn}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular">
              {formatDate(patient.dateOfBirth)} ({formatAge(patient.dateOfBirth, patient.age)})
            </span>
            <span aria-hidden="true">·</span>
            <span className="capitalize">{patient.sexAtBirth}</span>
            {patient.pronouns ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{patient.pronouns}</span>
              </>
            ) : null}
            {patient.bloodType && patient.bloodType !== 'unknown' ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-medium">{patient.bloodType}</span>
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            {can('patient:write') ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setEdit({
                    phone: patient.phone ?? '',
                    altPhone: patient.altPhone ?? '',
                    email: patient.email ?? '',
                    preferredName: patient.preferredName ?? '',
                    maritalStatus: patient.maritalStatus ?? '',
                    bloodType: patient.bloodType ?? '',
                    preferredLanguage: patient.preferredLanguage ?? '',
                  });
                  editForm.reset();
                  setEditing(true);
                }}
              >
                Edit details
              </Button>
            ) : null}
            {can('appointment:write') ? (
              <Link href={`/appointments/new?patientId=${patient.id}`}>
                <Button variant="secondary">Book</Button>
              </Link>
            ) : null}
            {can('encounter:write') ? (
              <Button
                variant="primary"
                icon={<IconStethoscope />}
                loading={startingEncounter}
                onClick={() => void startEncounter()}
              >
                Start encounter
              </Button>
            ) : null}
          </>
        }
      />

      {/* ---- 1. Allergy banner ------------------------------------------- */}
      {criticalAllergies.length > 0 ? (
        <div className="mb-4">
          <Alert tone="critical" title="Allergy alert">
            <ul className="flex flex-col gap-0.5">
              {criticalAllergies.map((allergy) => (
                <li key={allergy.allergen}>
                  <strong>{allergy.allergen}</strong> — {allergy.severity}
                  {allergy.reaction ? `: ${allergy.reaction}` : ''}
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      {notice ? (
        <div className="mb-4">
          <Alert tone={notice.tone} title={notice.tone === 'good' ? 'Done' : 'Not done'}>
            {notice.text}
          </Alert>
        </div>
      ) : null}

      {patient.requiresInterpreter ? (
        <div className="mb-4">
          <Alert tone="info" title="Interpreter required">
            Preferred language: {patient.preferredLanguage.toUpperCase()}. Arrange interpretation
            before the consultation.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="flex flex-col gap-5">
          {/* ---- Problem list ----------------------------------------- */}
          <Card>
            <CardHeader
              title="Problem list"
              subtitle={`${clinical?.conditions.length ?? 0} active`}
            />
            {!clinical || clinical.conditions.length === 0 ? (
              <EmptyState title="No active problems recorded" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Condition</Th>
                    <Th width="6rem">Code</Th>
                    <Th width="8rem">Onset</Th>
                    <Th align="right" width="7rem">
                      Status
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {clinical.conditions.map((condition) => (
                    <Tr key={`${condition.code}-${condition.onsetOn}`}>
                      <Td className="font-medium">{condition.display}</Td>
                      <Td numeric style={{ color: 'var(--ink-muted)' }}>
                        {condition.code}
                      </Td>
                      <Td numeric style={{ color: 'var(--ink-muted)' }}>
                        {condition.onsetOn ? formatDate(condition.onsetOn) : '—'}
                      </Td>
                      <Td align="right">
                        <Badge tone="info" dot>
                          {humanise(condition.status)}
                        </Badge>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {/* ---- Visit history ----------------------------------------- */}
          <Card>
            <CardHeader
              title="Visits"
              subtitle={
                encounters.length === 0
                  ? 'No encounters recorded'
                  : `${encounters.length} encounter(s); narrative decrypted for the care team`
              }
            />
            {encounters.length === 0 ? (
              <EmptyState title="No visits yet" />
            ) : (
              <ol className="flex flex-col gap-4">
                {encounters.slice(0, 10).map((encounter) => (
                  <li
                    key={encounter.id}
                    className="rounded-[var(--radius-md)] p-3"
                    style={{ background: 'var(--surface-sunken)' }}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <Link
                          href={`/clinical/${encounter.id}`}
                          className="tabular text-[0.8125rem] font-semibold"
                          style={{ color: 'var(--accent)' }}
                        >
                          {encounter.reference}
                        </Link>
                        <Badge tone={encounter.status === 'signed' ? 'good' : 'warning'} dot>
                          {humanise(encounter.status)}
                        </Badge>
                        {encounter.amendmentCount > 0 ? (
                          <Badge tone="info" dot>
                            {encounter.amendmentCount} amendment(s)
                          </Badge>
                        ) : null}
                      </span>
                      <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                        {formatDate(encounter.startedAt)} · {encounter.providerName}
                      </span>
                    </div>

                    {encounter.chiefComplaint ? (
                      <p className="mt-1 text-[0.875rem] font-medium" style={{ color: 'var(--ink)' }}>
                        {encounter.chiefComplaint}
                      </p>
                    ) : null}

                    {encounter.assessment ? (
                      <p className="mt-1 text-[0.8125rem] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
                        {encounter.assessment}
                      </p>
                    ) : null}

                    {encounter.diagnosisCodes.length > 0 ? (
                      <p className="mt-1.5 flex flex-wrap gap-1.5">
                        {encounter.diagnosisCodes.map((code) => (
                          <Badge key={code.code} tone="neutral" dot>
                            {code.code} {code.display}
                          </Badge>
                        ))}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {/* ---- Medication history ------------------------------------ */}
          <Card>
            <CardHeader
              title="Medication"
              subtitle={`${medications.length} prescription(s) on record`}
              action={
                can('prescription:write') ? (
                  <Button size="sm" variant="secondary" onClick={() => setPrescribing(true)}>
                    Prescribe
                  </Button>
                ) : null
              }
            />
            {medications.length === 0 ? (
              <EmptyState title="Nothing prescribed" />
            ) : (
              <ul className="flex flex-col gap-3">
                {medications.slice(0, 10).map((prescription) => (
                  <li key={prescription.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="tabular text-[0.8125rem] font-semibold" style={{ color: 'var(--ink)' }}>
                        {prescription.reference}
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge
                          tone={
                            prescription.status === 'dispensed' || prescription.status === 'completed'
                              ? 'good'
                              : prescription.status === 'cancelled' || prescription.status === 'expired'
                                ? 'neutral'
                                : 'info'
                          }
                          dot
                        >
                          {humanise(prescription.status)}
                        </Badge>
                        <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                          {formatDate(prescription.prescribed_at)} · {prescription.prescriber_name}
                        </span>
                      </span>
                    </div>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {prescription.items.map((item, index) => (
                        <li key={`${prescription.id}-${index}`} className="text-[0.8125rem]">
                          <span style={{ color: 'var(--ink)' }}>
                            {item.medicationName}
                            {item.strength ? ` ${item.strength}` : ''}
                          </span>
                          <span className="ml-1.5" style={{ color: 'var(--ink-muted)' }}>
                            {item.instructions}
                          </span>
                          {Number(item.quantityDispensed) < Number(item.quantityPrescribed) ? (
                            <span className="tabular ml-1.5 text-[0.75rem]" style={{ color: 'var(--warning-ink)' }}>
                              {Number(item.quantityPrescribed) - Number(item.quantityDispensed)} outstanding
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ---- Allergies, full list --------------------------------- */}
          <Card>
            <CardHeader
              title="Allergies and intolerances"
              action={
                can('patient:write') ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      allergyForm.reset();
                      setAddingAllergy(true);
                    }}
                  >
                    Record one
                  </Button>
                ) : null
              }
            />
            {!clinical || clinical.allergies.length === 0 ? (
              <EmptyState
                title="No known allergies recorded"
                description="An empty allergy list is not the same as no allergies. Confirm with the patient."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {clinical.allergies.map((allergy) => (
                  <li
                    key={allergy.allergen}
                    className="flex items-start justify-between gap-3 rounded-[var(--radius-md)] p-3"
                    style={{ background: 'var(--surface-sunken)' }}
                  >
                    <div className="min-w-0">
                      <p className="text-[0.875rem] font-medium" style={{ color: 'var(--ink)' }}>
                        {allergy.allergen}
                      </p>
                      <p className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                        {humanise(allergy.kind)}
                        {allergy.reaction ? ` · ${allergy.reaction}` : ''}
                      </p>
                    </div>
                    <Badge tone={SEVERITY_TONE[allergy.severity] ?? 'warning'}>
                      {humanise(allergy.severity)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ---- Latest observations ---------------------------------- */}
          {clinical?.latestVitals ? (
            <Card>
              <CardHeader
                title="Latest observations"
                subtitle={
                  clinical.latestVitals.recorded_at
                    ? `Recorded ${formatRelative(String(clinical.latestVitals.recorded_at))}`
                    : undefined
                }
              />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3.5 sm:grid-cols-4">
                <Vital label="Temp" value={clinical.latestVitals.temperature_c} unit="°C" />
                <Vital label="Pulse" value={clinical.latestVitals.heart_rate_bpm} unit="bpm" />
                <Vital
                  label="Blood pressure"
                  value={
                    clinical.latestVitals.systolic_mmhg && clinical.latestVitals.diastolic_mmhg
                      ? `${clinical.latestVitals.systolic_mmhg}/${clinical.latestVitals.diastolic_mmhg}`
                      : null
                  }
                  unit="mmHg"
                />
                <Vital label="SpO₂" value={clinical.latestVitals.oxygen_saturation} unit="%" />
                <Vital label="Resp rate" value={clinical.latestVitals.respiratory_rate} unit="/min" />
                <Vital label="Weight" value={clinical.latestVitals.weight_kg} unit="kg" />
                <Vital label="BMI" value={clinical.latestVitals.bmi} />
                <Vital
                  label="NEWS2"
                  value={clinical.latestVitals.news2_score}
                  tone={Number(clinical.latestVitals.news2_score ?? 0) >= 5 ? 'critical' : 'neutral'}
                />
              </dl>
            </Card>
          ) : null}
        </div>

        {/* ---- Sidebar -------------------------------------------------- */}
        <div className="flex flex-col gap-5">
          <Card>
            <div className="mb-4 flex items-center gap-3">
              <Avatar name={patient.fullName} size={44} />
              <div className="min-w-0">
                <p className="truncate text-[0.9375rem] font-semibold" style={{ color: 'var(--ink)' }}>
                  {patient.fullName}
                </p>
                <p className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                  Registered {formatDate(patient.createdAt)}
                </p>
              </div>
            </div>

            <dl className="flex flex-col gap-2.5 text-[0.875rem]">
              <Field label="Phone" value={patient.phone} sensitive />
              <Field label="Email" value={patient.email} sensitive />
              <Field
                label="Address"
                value={
                  patient.address
                    ? [patient.address.line1, patient.address.city, patient.address.postalCode]
                        .filter(Boolean)
                        .join(', ')
                    : null
                }
                sensitive
              />
              <Field label="National ID" value={patient.nationalId} sensitive />
              <Field
                label="Emergency contact"
                value={
                  patient.emergencyContact
                    ? `${patient.emergencyContact.name} (${patient.emergencyContact.relationship ?? 'contact'}) · ${patient.emergencyContact.phone}`
                    : null
                }
                sensitive
              />
              <Field label="Primary clinician" value={patient.primaryProviderName} />
              <Field label="Language" value={patient.preferredLanguage.toUpperCase()} />
            </dl>
          </Card>

          {can('invoice:read') && clinical ? (
            <Card>
              <CardHeader title="Account" />
              <div className="flex items-baseline justify-between">
                <span className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                  Outstanding balance
                </span>
                <span
                  className="tabular text-[1.25rem] font-semibold"
                  style={{
                    color:
                      clinical.outstandingBalanceCents > 0 ? 'var(--warning-ink)' : 'var(--good-ink)',
                  }}
                >
                  {formatMoney(clinical.outstandingBalanceCents)}
                </span>
              </div>
              {clinical.openPrescriptions > 0 ? (
                <p className="mt-3 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                  {clinical.openPrescriptions} prescription(s) awaiting dispensing.
                </p>
              ) : null}
            </Card>
          ) : null}

          {/* The access basis, shown back to the user. */}
          {accessBasis ? (
            <div
              className="flex items-start gap-2.5 rounded-[var(--radius-md)] p-3"
              style={{
                background: accessBasis === 'break_glass' ? 'var(--warning-soft)' : 'var(--surface-sunken)',
                color: accessBasis === 'break_glass' ? 'var(--warning-ink)' : 'var(--ink-muted)',
              }}
            >
              <IconShield className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-[0.75rem] leading-relaxed">
                {accessBasis === 'break_glass' ? (
                  <>
                    <strong>Emergency access.</strong> This view was permitted under a break-glass
                    grant and will be reviewed by the privacy officer.
                  </>
                ) : (
                  <>
                    Access recorded as <strong>{humanise(accessBasis)}</strong>. This view is logged
                    against your name.
                  </>
                )}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <FormDialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit details"
        description="Only what you change is sent — and every change is audited"
        submitLabel="Save"
        message={editForm.message}
        width="40rem"
        onSubmit={saveEdits}
      >
        <FieldSet legend="Contact" columns={2}>
          <FormField
            name="phone"
            label="Phone"
            type="tel"
            value={edit.phone ?? ''}
            error={editForm.errors.phone}
            onChange={(e) => setEdit((c) => ({ ...c, phone: e.target.value }))}
          />
          <FormField
            name="altPhone"
            label="Alternative phone"
            type="tel"
            value={edit.altPhone ?? ''}
            error={editForm.errors.altPhone}
            onChange={(e) => setEdit((c) => ({ ...c, altPhone: e.target.value }))}
          />
          <FormField
            name="email"
            label="Email"
            type="email"
            value={edit.email ?? ''}
            error={editForm.errors.email}
            onChange={(e) => setEdit((c) => ({ ...c, email: e.target.value }))}
          />
          <FormField
            name="preferredName"
            label="Preferred name"
            value={edit.preferredName ?? ''}
            error={editForm.errors.preferredName}
            onChange={(e) => setEdit((c) => ({ ...c, preferredName: e.target.value }))}
          />
        </FieldSet>

        <FieldSet legend="Clinical" columns={3}>
          <Select
            name="bloodType"
            label="Blood type"
            placeholder="Not known"
            options={['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((v) => ({ value: v, label: v }))}
            value={edit.bloodType ?? ''}
            error={editForm.errors.bloodType}
            onChange={(e) => setEdit((c) => ({ ...c, bloodType: e.target.value }))}
          />
          <Select
            name="maritalStatus"
            label="Marital status"
            placeholder="Not recorded"
            options={['single', 'married', 'partnered', 'divorced', 'widowed'].map((v) => ({
              value: v,
              label: humanise(v),
            }))}
            value={edit.maritalStatus ?? ''}
            error={editForm.errors.maritalStatus}
            onChange={(e) => setEdit((c) => ({ ...c, maritalStatus: e.target.value }))}
          />
          <Select
            name="preferredLanguage"
            label="Language"
            options={[
              { value: 'sw', label: 'Kiswahili' },
              { value: 'en', label: 'English' },
              { value: 'fr', label: 'French' },
            ]}
            value={edit.preferredLanguage ?? ''}
            error={editForm.errors.preferredLanguage}
            onChange={(e) => setEdit((c) => ({ ...c, preferredLanguage: e.target.value }))}
          />
        </FieldSet>
      </FormDialog>

      <FormDialog
        open={addingAllergy}
        onClose={() => setAddingAllergy(false)}
        title="Record an allergy"
        description="Prescribing screens against this from the moment it is saved"
        submitLabel="Record it"
        message={allergyForm.message}
        disabled={allergy.allergen.trim().length === 0}
        onSubmit={addAllergy}
      >
        <FormField
          name="allergen"
          label="What are they allergic to"
          required
          placeholder="Penicillin"
          value={allergy.allergen}
          error={allergyForm.errors.allergen}
          onChange={(e) => setAllergy((a) => ({ ...a, allergen: e.target.value }))}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="allergenKind"
            label="Kind"
            options={['medication', 'food', 'environmental', 'latex', 'contrast', 'other'].map((v) => ({
              value: v,
              label: humanise(v),
            }))}
            value={allergy.allergenKind}
            error={allergyForm.errors.allergenKind}
            onChange={(e) => setAllergy((a) => ({ ...a, allergenKind: e.target.value }))}
          />
          <Select
            name="severity"
            label="Severity"
            hint="Severe and anaphylaxis block prescribing rather than warning"
            options={[
              { value: 'mild', label: 'Mild' },
              { value: 'moderate', label: 'Moderate' },
              { value: 'severe', label: 'Severe' },
              { value: 'anaphylaxis', label: 'Anaphylaxis' },
            ]}
            value={allergy.severity}
            error={allergyForm.errors.severity}
            onChange={(e) => setAllergy((a) => ({ ...a, severity: e.target.value }))}
          />
        </div>
        <TextArea
          name="reaction"
          label="What happened"
          rows={2}
          hint="Quoted back to the prescriber at the point of writing, so it is worth being specific."
          value={allergy.reaction}
          error={allergyForm.errors.reaction}
          onChange={(e) => setAllergy((a) => ({ ...a, reaction: e.target.value }))}
        />
        <FormField
          name="onsetOn"
          label="First noticed"
          type="date"
          max={new Date().toISOString().slice(0, 10)}
          value={allergy.onsetOn}
          error={allergyForm.errors.onsetOn}
          onChange={(e) => setAllergy((a) => ({ ...a, onsetOn: e.target.value }))}
        />
      </FormDialog>

      <PrescribeDialog
        open={prescribing}
        onClose={() => setPrescribing(false)}
        patient={{ id: patient.id, fullName: patient.fullName, mrn: patient.mrn }}
        onPrescribed={(reference) => {
          setNotice({ tone: 'good', text: `Prescription ${reference} issued.` });
          reload();
        }}
      />
    </>
  );
}

function Vital({
  label,
  value,
  unit,
  tone = 'neutral',
}: {
  label: string;
  value: string | number | null | undefined;
  unit?: string;
  tone?: Tone;
}) {
  return (
    <div>
      <dt className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </dt>
      <dd
        className="tabular mt-0.5 text-[1.0625rem] font-semibold"
        style={{ color: tone === 'critical' ? 'var(--critical-ink)' : 'var(--ink)' }}
      >
        {value ?? '—'}
        {value && unit ? (
          <span className="ml-0.5 text-[0.75rem] font-normal" style={{ color: 'var(--ink-muted)' }}>
            {unit}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function Field({
  label,
  value,
  sensitive = false,
}: {
  label: string;
  value: string | null | undefined;
  sensitive?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </dt>
      <dd
        className={`min-w-0 text-right ${sensitive ? 'tabular' : ''}`}
        style={{ color: value ? 'var(--ink)' : 'var(--ink-muted)' }}
      >
        {value ?? 'Not recorded'}
      </dd>
    </div>
  );
}
