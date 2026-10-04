'use client';

/**
 * Prescribing, with the safety screen in front of it.
 *
 * The screen runs BEFORE the prescription is written, not as a validation
 * failure afterwards: the prescriber sees what the system knows — recorded
 * allergies, duplicate therapy, controlled-substance authority — and decides.
 * A blocking warning cannot be clicked past; it needs a typed reason, which is
 * stored on the prescription alongside the warning it answers. That pairing is
 * the point. "The doctor overrode an allergy alert" is not a usable record;
 * "overrode ALLERGY_PENICILLIN because the reaction was a childhood rash, not
 * anaphylaxis, and no alternative covers this organism" is.
 *
 * Quantity is NOT computed from dose × frequency × duration. It looks like it
 * should be, and for a tablet it usually is — but inhalers, creams, insulin
 * pens and liquids all break the arithmetic, and a quantity that is quietly
 * wrong is dispensed quietly wrong. The prescriber states it.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Card } from '@/components/ui/primitives';
import { Checkbox, Field, FormDialog, Select, TextArea, useFormErrors } from '@/components/ui/forms';
import {
  api,
  ApiError,
  type FormularyItem,
  type PatientSummary,
  type PrescriptionLineInput,
  type SafetyWarning,
} from '@/lib/api';
import { formatNumber, humanise } from '@/lib/format';
import { IconSearch } from '@/components/layout/icons';

/** Frequencies as they are actually written on a chart. */
const FREQUENCIES = [
  { value: 'OD', label: 'OD — once a day', perDay: 1 },
  { value: 'BD', label: 'BD — twice a day', perDay: 2 },
  { value: 'TDS', label: 'TDS — three times a day', perDay: 3 },
  { value: 'QDS', label: 'QDS — four times a day', perDay: 4 },
  { value: 'Q4H', label: 'Q4H — every four hours', perDay: 6 },
  { value: 'Q6H', label: 'Q6H — every six hours', perDay: 4 },
  { value: 'Q8H', label: 'Q8H — every eight hours', perDay: 3 },
  { value: 'NOCTE', label: 'Nocte — at night', perDay: 1 },
  { value: 'PRN', label: 'PRN — as required', perDay: 0 },
  { value: 'STAT', label: 'STAT — immediately, once', perDay: 0 },
];

const ROUTES = ['oral', 'intravenous', 'intramuscular', 'subcutaneous', 'topical', 'inhaled', 'rectal', 'ophthalmic'];

const WARNING_TONE = {
  contraindicated: 'critical',
  severe: 'critical',
  moderate: 'warning',
  info: 'info',
} as const;

type Line = PrescriptionLineInput & { key: string };

function blankLine(): Line {
  return {
    key: Math.random().toString(36).slice(2),
    medicationName: '',
    route: 'oral',
    doseQuantity: 1,
    doseUnit: 'tablet',
    frequencyCode: 'TDS',
    frequencyPerDay: 3,
    durationDays: 5,
    asNeeded: false,
    instructions: '',
    quantityPrescribed: 15,
    refillsAuthorised: 0,
    substitutionAllowed: true,
  };
}

export function PrescribeDialog({
  open,
  onClose,
  patient,
  encounterId,
  onPrescribed,
}: {
  open: boolean;
  onClose: () => void;
  patient: { id: string; fullName: string; mrn: string } | PatientSummary;
  encounterId?: string;
  onPrescribed: (reference: string) => void;
}): ReactNode {
  const form = useFormErrors();
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [notes, setNotes] = useState('');
  const [fulfilment, setFulfilment] = useState('in_house');
  const [warnings, setWarnings] = useState<SafetyWarning[] | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [screening, setScreening] = useState(false);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<FormularyItem[]>([]);
  const [activeLine, setActiveLine] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLines([blankLine()]);
    setNotes('');
    setWarnings(null);
    setOverrides({});
    setSearch('');
    form.reset();
    // form is stable enough for this purpose; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setResults([]);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api
        .get<FormularyItem[]>(
          '/inventory/items',
          { q: search.trim(), medicationsOnly: 'true', limit: 8 },
          controller.signal,
        )
        .then(({ data }) => setResults(data))
        .catch(() => undefined);
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [search]);

  const update = useCallback((key: string, patch: Partial<Line>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    // Any change invalidates a screen that was run against the old lines.
    setWarnings(null);
  }, []);

  function choose(item: FormularyItem, key: string): void {
    update(key, {
      itemId: item.id,
      medicationName: item.name,
      strength: item.strength ?? undefined,
      form: item.form ?? undefined,
      route: item.route ?? 'oral',
      doseUnit: item.base_unit,
    });
    setSearch('');
    setResults([]);
    setActiveLine(null);
  }

  function payload() {
    return {
      patientId: patient.id,
      encounterId,
      fulfilment,
      notes: notes || undefined,
      items: lines.map(({ key: _key, ...line }) => ({
        ...line,
        frequencyPerDay: line.frequencyPerDay || undefined,
        durationDays: line.durationDays || undefined,
      })),
      overrides: Object.entries(overrides)
        .filter(([, reason]) => reason.trim().length >= 10)
        .map(([code, reason]) => ({ code, reason })),
    };
  }

  async function screen(): Promise<void> {
    setScreening(true);
    form.reset();

    try {
      const { data } = await api.post<{ warnings: SafetyWarning[] }>('/prescriptions/screen', payload());
      setWarnings(data.warnings);
    } catch (caught) {
      form.capture(caught);
    } finally {
      setScreening(false);
    }
  }

  async function issue(): Promise<void> {
    form.reset();

    try {
      const { data } = await api.post<{ reference: string }>('/prescriptions', payload());
      onPrescribed(data.reference);
      onClose();
    } catch (caught) {
      form.capture(caught);
      // The server re-screens on write, so a warning that appears here was not
      // on screen when the prescriber decided — show it rather than a message.
      if (caught instanceof ApiError && caught.issues.length > 0) {
        setWarnings(
          caught.issues.map((issue) => ({
            severity: 'contraindicated' as const,
            code: issue.field,
            message: issue.message,
            blocking: true,
          })),
        );
      }
    }
  }

  const blocking = (warnings ?? []).filter((w) => w.blocking);
  const unresolved = blocking.filter((w) => (overrides[w.code] ?? '').trim().length < 10);
  const incomplete = lines.some((l) => !l.medicationName.trim() || !l.instructions.trim());

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Prescribe"
      description={`${patient.fullName} · ${patient.mrn}`}
      submitLabel={warnings === null ? 'Run the safety screen' : 'Sign and issue'}
      message={form.message}
      width="52rem"
      disabled={incomplete || (warnings !== null && unresolved.length > 0)}
      onSubmit={warnings === null ? screen : issue}
    >
      {warnings !== null ? (
        warnings.length === 0 ? (
          <Alert tone="good" title="No warnings">
            Nothing in the recorded allergies, current medication or controlled-substance authority
            objects to this prescription. Drug–drug interaction checking needs a licensed database
            and is deliberately not claimed here.
          </Alert>
        ) : (
          <div className="flex flex-col gap-3">
            {warnings.map((warning) => (
              <Alert
                key={warning.code}
                tone={WARNING_TONE[warning.severity]}
                title={`${humanise(warning.severity)}${warning.blocking ? ' — blocking' : ''}`}
              >
                <p>{warning.message}</p>
                {warning.blocking ? (
                  <div className="mt-2.5">
                    <Field
                      name={`override-${warning.code}`}
                      label="Why are you proceeding?"
                      required
                      hint="At least ten characters. Stored on the prescription, beside the warning it answers."
                      value={overrides[warning.code] ?? ''}
                      onChange={(event) =>
                        setOverrides((current) => ({ ...current, [warning.code]: event.target.value }))
                      }
                    />
                  </div>
                ) : null}
              </Alert>
            ))}
          </div>
        )
      ) : null}

      <div className="flex flex-col gap-4">
        {lines.map((line, index) => (
          <Card key={line.key}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-[0.875rem] font-semibold" style={{ color: 'var(--ink)' }}>
                Medicine {index + 1}
              </span>
              {lines.length > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}
                >
                  Remove
                </Button>
              ) : null}
            </div>

            <div className="flex flex-col gap-4">
              <div className="relative">
                <Field
                  name={`medication-${line.key}`}
                  label="Medicine"
                  required
                  autoComplete="off"
                  placeholder="Search the formulary, or type a name"
                  value={activeLine === line.key ? search : line.medicationName}
                  onFocus={() => {
                    setActiveLine(line.key);
                    setSearch(line.medicationName);
                  }}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    update(line.key, { medicationName: event.target.value, itemId: undefined });
                  }}
                />
                {activeLine === line.key && results.length > 0 ? (
                  <ul
                    className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-[var(--radius-md)]"
                    style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
                  >
                    {results.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => choose(item, line.key)}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                          style={{ borderBottom: '1px solid var(--line)' }}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[0.875rem]" style={{ color: 'var(--ink)' }}>
                              {item.name}
                            </span>
                            <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                              {item.generic_name ?? item.sku} · {formatNumber(Number(item.quantity_on_hand))}{' '}
                              {item.base_unit} in stock
                            </span>
                          </span>
                          {item.controlled_schedule ? (
                            <Badge tone="serious">Sch {item.controlled_schedule}</Badge>
                          ) : Number(item.quantity_on_hand) === 0 ? (
                            <Badge tone="warning">No stock</Badge>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-4">
                <Field
                  name={`dose-${line.key}`}
                  label="Dose"
                  type="number"
                  step="0.001"
                  value={line.doseQuantity}
                  onChange={(e) => update(line.key, { doseQuantity: Number(e.target.value) })}
                />
                <Field
                  name={`unit-${line.key}`}
                  label="Unit"
                  value={line.doseUnit}
                  onChange={(e) => update(line.key, { doseUnit: e.target.value })}
                />
                <Select
                  name={`route-${line.key}`}
                  label="Route"
                  options={ROUTES.map((r) => ({ value: r, label: humanise(r) }))}
                  value={line.route}
                  onChange={(e) => update(line.key, { route: e.target.value })}
                />
                <Select
                  name={`frequency-${line.key}`}
                  label="Frequency"
                  options={FREQUENCIES.map((f) => ({ value: f.value, label: f.label }))}
                  value={line.frequencyCode}
                  onChange={(e) => {
                    const frequency = FREQUENCIES.find((f) => f.value === e.target.value);
                    update(line.key, {
                      frequencyCode: e.target.value,
                      frequencyPerDay: frequency?.perDay || undefined,
                      asNeeded: e.target.value === 'PRN',
                    });
                  }}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Field
                  name={`duration-${line.key}`}
                  label="Duration (days)"
                  type="number"
                  min={1}
                  value={line.durationDays ?? ''}
                  onChange={(e) => update(line.key, { durationDays: Number(e.target.value) || undefined })}
                />
                <Field
                  name={`quantity-${line.key}`}
                  label="Quantity to dispense"
                  type="number"
                  step="0.001"
                  required
                  hint="Stated, not computed"
                  value={line.quantityPrescribed}
                  onChange={(e) => update(line.key, { quantityPrescribed: Number(e.target.value) })}
                />
                <Field
                  name={`refills-${line.key}`}
                  label="Refills"
                  type="number"
                  min={0}
                  max={12}
                  value={line.refillsAuthorised}
                  onChange={(e) => update(line.key, { refillsAuthorised: Number(e.target.value) })}
                />
              </div>

              <TextArea
                name={`instructions-${line.key}`}
                label="Instructions for the label"
                required
                rows={2}
                hint="Printed and handed to the patient — write it as they should read it."
                value={line.instructions}
                onChange={(e) => update(line.key, { instructions: e.target.value })}
              />

              <Checkbox
                name={`substitution-${line.key}`}
                label="Generic substitution allowed"
                checked={line.substitutionAllowed}
                onChange={(e) => update(line.key, { substitutionAllowed: e.target.checked })}
              />
            </div>
          </Card>
        ))}

        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setLines((current) => [...current, blankLine()])}
          >
            Add another medicine
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="fulfilment"
            label="Dispensed by"
            options={[
              { value: 'in_house', label: 'This hospital’s pharmacy' },
              { value: 'external_pharmacy', label: 'An outside pharmacy' },
              { value: 'patient_supplied', label: 'Patient’s own supply' },
            ]}
            value={fulfilment}
            onChange={(e) => setFulfilment(e.target.value)}
          />
          <Field
            name="notes"
            label="Note to the pharmacist"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {warnings !== null ? (
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" loading={screening} onClick={() => void screen()}>
              Re-run the safety screen
            </Button>
            <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
              The server screens again on issue, so a change made after this will still be caught.
            </span>
          </div>
        ) : null}
      </div>
    </FormDialog>
  );
}
