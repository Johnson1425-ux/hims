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
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/shell';
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
import { api, ApiError, type ClinicalSummary, type PatientDetail } from '@/lib/api';
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

  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [clinical, setClinical] = useState<ClinicalSummary | null>(null);
  const [accessBasis, setAccessBasis] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

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
  }, [patientId]);

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
              <Button variant="secondary" icon={<IconShield />}>
                Request emergency access
              </Button>
            </div>
          </div>
        </Card>
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
            {can('vitals:write') ? <Button variant="secondary">Record vitals</Button> : null}
            {can('encounter:write') ? (
              <Button variant="primary" icon={<IconStethoscope />}>
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

          {/* ---- Allergies, full list --------------------------------- */}
          <Card>
            <CardHeader title="Allergies and intolerances" />
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
