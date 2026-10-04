'use client';

/**
 * Encounter workspace — where the note is actually written.
 *
 * SIGNING IS A ONE-WAY DOOR. Once signed, a database trigger refuses any edit
 * to the narrative: the note becomes part of the legal record and corrections
 * have to be filed as amendments, which are appended and attributed, never
 * substituted. The interface says so before the button, not after it, and the
 * editor disappears entirely once it has happened — a disabled textarea
 * suggests the text is still the live document, and it is not.
 *
 * DRAFTS SAVE EXPLICITLY. There is no autosave. A half-typed differential
 * silently persisted to a legal record, then signed by someone who did not
 * read what autosave had captured, is a worse failure than losing a paragraph.
 *
 * NEWS2 is computed by the server from the observations, so the number on this
 * screen, on the ward board and on a printout come from one implementation.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
  StatTile,
  type Tone,
} from '@/components/ui/primitives';
import { Field, FieldSet, FormDialog, Select, TextArea, useFormErrors } from '@/components/ui/forms';
import { useSession } from '@/lib/session';
import { api, ApiError, type EncounterDetail } from '@/lib/api';
import { formatAge, formatDate, formatDateTime, formatRelative, humanise, pluralise } from '@/lib/format';
import { IconStethoscope, IconShield } from '@/components/layout/icons';

const STATUS_TONE: Record<EncounterDetail['status'], Tone> = {
  draft: 'warning',
  in_progress: 'info',
  pending_signature: 'serious',
  signed: 'good',
  amended: 'neutral',
  voided: 'neutral',
};

/** The detail endpoint returns a date of birth, not an age; ages drift. */
function ageFrom(dateOfBirth: string): number {
  const born = new Date(dateOfBirth);
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const month = now.getMonth() - born.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < born.getDate())) age -= 1;
  return Math.max(0, age);
}

function news2Tone(score: number | null): Tone {
  if (score === null) return 'neutral';
  if (score >= 7) return 'critical';
  if (score >= 5) return 'serious';
  if (score >= 1) return 'warning';
  return 'good';
}

const SECTIONS = [
  {
    key: 'subjective' as const,
    label: 'Subjective',
    hint: 'What the patient reports, in their terms',
  },
  { key: 'objective' as const, label: 'Objective', hint: 'Examination findings and observations' },
  { key: 'assessment' as const, label: 'Assessment', hint: 'Clinical impression and differential' },
  { key: 'plan' as const, label: 'Plan', hint: 'Treatment, investigations, follow-up' },
];

export default function EncounterPage() {
  const params = useParams<{ encounterId: string }>();
  const encounterId = params.encounterId;
  const router = useRouter();
  const { can } = useSession();

  const [encounter, setEncounter] = useState<EncounterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState({ chiefComplaint: '', subjective: '', objective: '', assessment: '', plan: '' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);

  const [signing, setSigning] = useState(false);
  const [amending, setAmending] = useState(false);
  const [amendReason, setAmendReason] = useState('');
  const [amendNarrative, setAmendNarrative] = useState('');
  const [recordingVitals, setRecordingVitals] = useState(false);
  const [vitals, setVitals] = useState<Record<string, string>>({});

  const saveForm = useFormErrors();
  const amendForm = useFormErrors();
  const vitalsForm = useFormErrors();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);

      try {
        const { data } = await api.get<EncounterDetail>(`/encounters/${encounterId}`, undefined, signal);
        setEncounter(data);
        setDraft({
          chiefComplaint: data.chiefComplaint ?? '',
          subjective: data.subjective ?? '',
          objective: data.objective ?? '',
          assessment: data.assessment ?? '',
          plan: data.plan ?? '',
        });
        setDirty(false);
      } catch (caught) {
        if (caught instanceof ApiError) setLoadError(caught.message);
      } finally {
        setLoading(false);
      }
    },
    [encounterId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // An unsaved note is lost on navigation, and the browser is the only thing
  // that can warn in time.
  useEffect(() => {
    if (!dirty) return;

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function save(): Promise<void> {
    if (!encounter || saving) return;

    setSaving(true);
    saveForm.reset();
    setNotice(null);

    try {
      await api.patch(`/encounters/${encounterId}`, {
        chiefComplaint: draft.chiefComplaint || undefined,
        subjective: draft.subjective || undefined,
        objective: draft.objective || undefined,
        assessment: draft.assessment || undefined,
        plan: draft.plan || undefined,
      });
      setNotice({ tone: 'good', text: 'Draft saved.' });
      setDirty(false);
      await load();
    } catch (caught) {
      saveForm.capture(caught);
      setNotice({
        tone: 'critical',
        text: caught instanceof ApiError ? caught.message : 'The note could not be saved.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function sign(): Promise<void> {
    try {
      await api.post(`/encounters/${encounterId}/sign`, {});
      setSigning(false);
      setNotice({ tone: 'good', text: 'Signed. This note is now part of the legal record.' });
      await load();
    } catch (caught) {
      setNotice({
        tone: 'critical',
        text: caught instanceof ApiError ? caught.message : 'The note could not be signed.',
      });
      setSigning(false);
    }
  }

  async function amend(): Promise<void> {
    amendForm.reset();

    try {
      await api.post(`/encounters/${encounterId}/amendments`, {
        reason: amendReason,
        narrative: amendNarrative,
      });
      setAmending(false);
      setAmendReason('');
      setAmendNarrative('');
      setNotice({ tone: 'good', text: 'Amendment filed and attributed.' });
      await load();
    } catch (caught) {
      amendForm.capture(caught);
    }
  }

  async function recordVitals(): Promise<void> {
    if (!encounter) return;

    vitalsForm.reset();

    const numeric = (key: string): number | undefined => {
      const raw = vitals[key];
      if (raw === undefined || raw.trim() === '') return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };

    try {
      await api.post('/encounters/vitals', {
        patientId: encounter.patientId,
        encounterId: encounter.id,
        temperatureC: numeric('temperatureC'),
        heartRateBpm: numeric('heartRateBpm'),
        respiratoryRate: numeric('respiratoryRate'),
        systolicMmhg: numeric('systolicMmhg'),
        diastolicMmhg: numeric('diastolicMmhg'),
        oxygenSaturation: numeric('oxygenSaturation'),
        bloodGlucoseMmol: numeric('bloodGlucoseMmol'),
        weightKg: numeric('weightKg'),
        heightCm: numeric('heightCm'),
        painScore: numeric('painScore'),
        notes: vitals.notes || undefined,
      });
      setRecordingVitals(false);
      setVitals({});
      setNotice({ tone: 'good', text: 'Observations recorded.' });
      await load();
    } catch (caught) {
      vitalsForm.capture(caught);
    }
  }

  if (loading && !encounter) {
    return (
      <>
        <PageHeader title="Encounter" breadcrumbs={[{ label: 'Encounters', href: '/clinical' }]} />
        <div className="flex flex-col gap-3">
          <Skeleton height={120} />
          <Skeleton height={320} />
        </div>
      </>
    );
  }

  if (loadError || !encounter) {
    return (
      <>
        <PageHeader title="Encounter" breadcrumbs={[{ label: 'Encounters', href: '/clinical' }]} />
        <Card>
          <Alert tone="critical" title="This encounter could not be opened">
            {loadError ?? 'It may have been voided, or you may not have access to this patient.'}
          </Alert>
        </Card>
      </>
    );
  }

  const locked = encounter.status === 'signed' || encounter.status === 'amended';
  const editable = can('encounter:write') && !locked;
  const latest = encounter.vitals[0] ?? null;

  return (
    <>
      <PageHeader
        title={encounter.patientName}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tabular">{encounter.mrn}</span>
            <span aria-hidden="true">·</span>
            <span>{formatAge(encounter.dateOfBirth, ageFrom(encounter.dateOfBirth))}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular">{encounter.reference}</span>
            <Badge tone={STATUS_TONE[encounter.status]}>{humanise(encounter.status)}</Badge>
            {encounter.accessBasis !== 'care_team' ? (
              <Badge tone="serious">Access: {humanise(encounter.accessBasis)}</Badge>
            ) : null}
          </span>
        }
        breadcrumbs={[
          { label: 'Encounters', href: '/clinical' },
          { label: encounter.reference },
        ]}
        actions={
          <>
            <Link href={`/patients/${encounter.patientId}`}>
              <Button variant="secondary">Open chart</Button>
            </Link>
            {can('vitals:write') ? (
              <Button variant="secondary" onClick={() => setRecordingVitals(true)}>
                Record observations
              </Button>
            ) : null}
            {editable ? (
              <Button variant="primary" loading={saving} disabled={saving || !dirty} onClick={() => void save()}>
                Save draft
              </Button>
            ) : null}
            {can('encounter:sign') && !locked ? (
              <Button variant="primary" onClick={() => setSigning(true)} disabled={dirty}>
                Sign
              </Button>
            ) : null}
            {can('encounter:write') && locked ? (
              <Button variant="secondary" onClick={() => setAmending(true)}>
                File an amendment
              </Button>
            ) : null}
          </>
        }
      />

      {notice ? (
        <div className="mb-5">
          <Alert tone={notice.tone} title={notice.tone === 'good' ? 'Saved' : 'Not saved'}>
            {notice.text}
          </Alert>
        </div>
      ) : null}

      {locked ? (
        <div className="mb-5">
          <Alert tone="good" title="Signed — this note is part of the legal record">
            Signed by {encounter.signedByName ?? 'a clinician'} {formatRelative(encounter.signedAt)}. The
            database refuses any edit to the narrative from here; corrections are filed as amendments,
            which are appended and attributed rather than replacing what was written.
          </Alert>
        </div>
      ) : dirty ? (
        <div className="mb-5">
          <Alert tone="warning" title="Unsaved changes">
            Nothing is saved automatically. A half-written note persisted without the author's
            knowledge, and then signed, is worse than a lost paragraph — so saving is deliberate.
          </Alert>
        </div>
      ) : null}

      <section aria-label="Latest observations" className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Early warning"
          value={latest?.news2_score ?? '—'}
          unit={latest?.news2_score !== null && latest !== null ? 'NEWS2' : undefined}
          tone={news2Tone(latest?.news2_score ?? null)}
          hint={
            latest
              ? (latest.news2_score ?? 0) >= 5
                ? 'Urgent clinical review'
                : `Recorded ${formatRelative(latest.recorded_at)}`
              : 'No observations yet'
          }
          emphasis
        />
        <StatTile
          label="Blood pressure"
          value={latest?.systolic_mmhg ? `${latest.systolic_mmhg}/${latest.diastolic_mmhg ?? '—'}` : '—'}
          unit="mmHg"
        />
        <StatTile label="Pulse" value={latest?.heart_rate_bpm ?? '—'} unit="bpm" />
        <StatTile
          label="Saturations"
          value={latest?.oxygen_saturation ? Number(latest.oxygen_saturation) : '—'}
          unit="%"
          tone={latest?.oxygen_saturation && Number(latest.oxygen_saturation) < 94 ? 'warning' : 'neutral'}
        />
      </section>

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader
              title="Note"
              subtitle={
                locked
                  ? 'Read only. Corrections go below, as amendments.'
                  : 'Each section is encrypted separately at rest'
              }
            />

            {saveForm.message ? (
              <div className="mb-4">
                <Alert tone="critical">{saveForm.message}</Alert>
              </div>
            ) : null}

            {editable ? (
              <div className="flex flex-col gap-4">
                <Field
                  name="chiefComplaint"
                  label="Presenting complaint"
                  placeholder="Chest pain on exertion"
                  value={draft.chiefComplaint}
                  error={saveForm.errors.chiefComplaint}
                  onChange={(event) => {
                    setDraft((d) => ({ ...d, chiefComplaint: event.target.value }));
                    setDirty(true);
                  }}
                />
                {SECTIONS.map((section) => (
                  <TextArea
                    key={section.key}
                    name={section.key}
                    label={section.label}
                    hint={section.hint}
                    rows={section.key === 'subjective' || section.key === 'plan' ? 5 : 4}
                    value={draft[section.key]}
                    error={saveForm.errors[section.key]}
                    onChange={(event) => {
                      setDraft((d) => ({ ...d, [section.key]: event.target.value }));
                      setDirty(true);
                    }}
                  />
                ))}
              </div>
            ) : (
              <dl className="flex flex-col gap-4">
                <div>
                  <dt className="text-[0.75rem] tracking-[0.02em] uppercase" style={{ color: 'var(--ink-muted)' }}>
                    Presenting complaint
                  </dt>
                  <dd className="mt-0.5 text-[0.9375rem]" style={{ color: 'var(--ink)' }}>
                    {encounter.chiefComplaint ?? '—'}
                  </dd>
                </div>
                {SECTIONS.map((section) => (
                  <div key={section.key}>
                    <dt className="text-[0.75rem] tracking-[0.02em] uppercase" style={{ color: 'var(--ink-muted)' }}>
                      {section.label}
                    </dt>
                    <dd
                      className="mt-0.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap"
                      style={{ color: 'var(--ink)' }}
                    >
                      {encounter[section.key] ?? '—'}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          {encounter.amendments.length > 0 ? (
            <Card>
              <CardHeader
                title={pluralise(encounter.amendments.length, 'amendment')}
                subtitle="Appended after signature — the original text above is unchanged"
              />
              <ol className="flex flex-col gap-4">
                {encounter.amendments.map((amendment) => (
                  <li
                    key={amendment.id}
                    className="rounded-[var(--radius-md)] p-3"
                    style={{ background: 'var(--surface-sunken)' }}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-[0.8125rem] font-semibold" style={{ color: 'var(--ink)' }}>
                        #{amendment.sequenceNo} · {amendment.reason}
                      </span>
                      <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                        {amendment.amendedByName ?? 'Unknown'} · {formatDateTime(amendment.createdAt)}
                      </span>
                    </div>
                    <p
                      className="mt-1.5 text-[0.875rem] leading-relaxed whitespace-pre-wrap"
                      style={{ color: 'var(--ink-secondary)' }}
                    >
                      {amendment.narrative ?? '—'}
                    </p>
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Encounter" />
            <dl className="flex flex-col gap-3 text-[0.875rem]">
              {[
                ['Clinician', encounter.providerName],
                ['Department', encounter.departmentName ?? '—'],
                ['Class', humanise(encounter.encounterClass)],
                ['Started', formatDateTime(encounter.startedAt)],
                ['Ended', encounter.endedAt ? formatDateTime(encounter.endedAt) : 'Still open'],
                ['Follow-up', encounter.followUpInDays ? `${encounter.followUpInDays} days` : '—'],
                ['Disposition', encounter.disposition ? humanise(encounter.disposition) : '—'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt style={{ color: 'var(--ink-muted)' }}>{label}</dt>
                  <dd className="text-right" style={{ color: 'var(--ink)' }}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title="Observations"
                subtitle={`${pluralise(encounter.vitals.length, 'reading')} this encounter`}
              />
            </div>

            {encounter.vitals.length === 0 ? (
              <EmptyState icon={<IconStethoscope />} title="None recorded yet" />
            ) : (
              <ul className="flex flex-col">
                {encounter.vitals.map((reading) => (
                  <li
                    key={reading.id}
                    className="px-5 py-3"
                    style={{ borderTop: '1px solid var(--line)' }}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <Badge tone={news2Tone(reading.news2_score)}>
                        NEWS2 {reading.news2_score ?? '—'}
                      </Badge>
                      <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                        {formatRelative(reading.recorded_at)}
                      </span>
                    </div>
                    <p className="tabular mt-1.5 text-[0.8125rem]" style={{ color: 'var(--ink-secondary)' }}>
                      {[
                        reading.temperature_c ? `${Number(reading.temperature_c).toFixed(1)}°C` : null,
                        reading.heart_rate_bpm ? `${reading.heart_rate_bpm} bpm` : null,
                        reading.respiratory_rate ? `${reading.respiratory_rate}/min` : null,
                        reading.systolic_mmhg ? `${reading.systolic_mmhg}/${reading.diastolic_mmhg ?? '—'}` : null,
                        reading.oxygen_saturation ? `${Number(reading.oxygen_saturation)}%` : null,
                        reading.bmi ? `BMI ${Number(reading.bmi).toFixed(1)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {reading.recorded_by_name ? (
                      <p className="mt-0.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                        {reading.recorded_by_name}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <FormDialog
        open={signing}
        onClose={() => setSigning(false)}
        title="Sign this note"
        description={`${encounter.patientName} · ${encounter.reference}`}
        submitLabel="Sign — this cannot be undone"
        onSubmit={sign}
      >
        <Alert tone="warning" title="Signing is final">
          A signed note is part of the legal record. The database refuses further edits to the
          narrative, and anything you want to change afterwards has to be filed as an amendment —
          appended and attributed to you, alongside the original rather than instead of it.
        </Alert>
        <p className="text-[0.875rem]" style={{ color: 'var(--ink-secondary)' }}>
          Signing also closes the appointment this encounter came from, and hashes the clinical
          content so a later tamper is detectable.
        </p>
      </FormDialog>

      <FormDialog
        open={amending}
        onClose={() => setAmending(false)}
        title="File an amendment"
        description="Appended to the signed note, never replacing it"
        submitLabel="File the amendment"
        message={amendForm.message}
        disabled={amendReason.trim().length < 10 || amendNarrative.trim().length === 0}
        onSubmit={amend}
      >
        <Field
          name="reason"
          label="What is being corrected, and why"
          required
          hint="At least ten characters — this is the line an auditor reads first."
          value={amendReason}
          error={amendForm.errors.reason}
          onChange={(event) => setAmendReason(event.target.value)}
        />
        <TextArea
          name="narrative"
          label="Amendment"
          required
          rows={6}
          value={amendNarrative}
          error={amendForm.errors.narrative}
          onChange={(event) => setAmendNarrative(event.target.value)}
        />
      </FormDialog>

      <FormDialog
        open={recordingVitals}
        onClose={() => setRecordingVitals(false)}
        title="Record observations"
        description="BMI and the NEWS2 score are computed by the server from what you enter"
        submitLabel="Record"
        message={vitalsForm.message}
        width="40rem"
        onSubmit={recordVitals}
      >
        <FieldSet legend="Vital signs" columns={3}>
          {[
            ['temperatureC', 'Temperature', '°C', '0.1'],
            ['heartRateBpm', 'Pulse', 'bpm', '1'],
            ['respiratoryRate', 'Respiratory rate', '/min', '1'],
            ['systolicMmhg', 'Systolic', 'mmHg', '1'],
            ['diastolicMmhg', 'Diastolic', 'mmHg', '1'],
            ['oxygenSaturation', 'SpO₂', '%', '1'],
            ['bloodGlucoseMmol', 'Glucose', 'mmol/L', '0.1'],
            ['weightKg', 'Weight', 'kg', '0.1'],
            ['heightCm', 'Height', 'cm', '1'],
          ].map(([key, label, unit, step]) => (
            <Field
              key={key}
              name={key!}
              label={`${label} (${unit})`}
              type="number"
              step={step}
              inputMode="decimal"
              value={vitals[key!] ?? ''}
              error={vitalsForm.errors[key!]}
              onChange={(event) => setVitals((v) => ({ ...v, [key!]: event.target.value }))}
            />
          ))}
          <Select
            name="painScore"
            label="Pain score"
            placeholder="Not asked"
            options={Array.from({ length: 11 }, (_, i) => ({ value: String(i), label: String(i) }))}
            value={vitals.painScore ?? ''}
            error={vitalsForm.errors.painScore}
            onChange={(event) => setVitals((v) => ({ ...v, painScore: event.target.value }))}
          />
        </FieldSet>
        <TextArea
          name="notes"
          label="Notes"
          rows={2}
          value={vitals.notes ?? ''}
          error={vitalsForm.errors.notes}
          onChange={(event) => setVitals((v) => ({ ...v, notes: event.target.value }))}
        />
      </FormDialog>
    </>
  );
}
