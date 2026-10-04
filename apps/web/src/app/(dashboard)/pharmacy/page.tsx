'use client';

/**
 * Dispensing queue.
 *
 * Controlled drugs sort to the top — that is the server's ordering, not a
 * client-side preference — because they carry a register obligation and a
 * cabinet that someone has to unlock, and burying them under routine
 * paracetamol is how a controlled-drug queue quietly grows.
 *
 * Dispensing happens from a named store, so the store is chosen before the
 * button is live. A location that is not authorised for controlled drugs is
 * refused by the stock ledger; refusing it here, at the point of selection,
 * saves a pharmacist discovering that after picking the stock.
 *
 * Batch selection is NOT offered. The server picks first-expiry-first-out,
 * which is the only correct answer and not a decision worth re-litigating at
 * the counter — a pharmacist choosing a batch by hand is how short-dated stock
 * reaches its expiry date on the shelf.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import { api, ApiError, type DispenseQueueItem } from '@/lib/api';
import { formatDateTime, formatRelative, humanise, pluralise } from '@/lib/format';
import { IconPill, IconShield } from '@/components/layout/icons';

interface Location {
  id: string;
  name: string;
  code: string;
  kind: string;
  allows_controlled: boolean;
  temperature_controlled: boolean;
  facility_name: string | null;
  batches_available: string;
}

export default function PharmacyPage() {
  const { can } = useSession();
  const [queue, setQueue] = useState<DispenseQueueItem[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);
  const [dispensing, setDispensing] = useState<string | null>(null);

  const canDispense = can('prescription:dispense');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);

    try {
      const [queueResult, locationResult] = await Promise.all([
        api.get<DispenseQueueItem[]>('/prescriptions/queue', undefined, signal),
        api.get<Location[]>('/inventory/locations', undefined, signal).catch(() => ({ data: [] })),
      ]);

      setQueue(queueResult.data);
      setLocations(locationResult.data);
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Default to a store that can hold anything in the queue, so the common case
  // needs no choice at all.
  useEffect(() => {
    if (locationId || locations.length === 0) return;
    const pharmacy = locations.find((l) => l.kind === 'pharmacy') ?? locations[0];
    if (pharmacy) setLocationId(pharmacy.id);
  }, [locations, locationId]);

  const location = useMemo(
    () => locations.find((l) => l.id === locationId) ?? null,
    [locations, locationId],
  );

  const controlled = queue.filter((item) => item.has_controlled);
  const coldChain = queue.filter((item) => item.needs_cold_chain);
  const outstandingLines = queue.reduce((sum, item) => sum + Number(item.lines_outstanding), 0);

  /**
   * Dispense every outstanding line on a prescription.
   *
   * Quantity is omitted deliberately: the schema reads that as "the full
   * outstanding amount", so a partial dispense is an explicit act rather than
   * something that can happen by miscounting on this screen.
   */
  async function dispense(item: DispenseQueueItem): Promise<void> {
    if (!location) return;

    setDispensing(item.id);
    setNotice(null);

    try {
      // The queue already returned the outstanding lines, so there is no
      // second fetch to go stale between reading the row and acting on it.
      if (item.outstanding_items.length === 0) {
        setNotice({ tone: 'good', text: `${item.reference} had nothing left to dispense.` });
        await load();
        return;
      }

      await api.post('/inventory/dispense', {
        prescriptionId: item.id,
        locationId: location.id,
        items: item.outstanding_items.map((line) => ({ prescriptionItemId: line.id })),
      });

      setNotice({
        tone: 'good',
        text: `${item.reference} dispensed to ${item.patient_name} from ${location.name}.`,
      });
      await load();
    } catch (caught) {
      setNotice({
        tone: 'critical',
        text: caught instanceof ApiError ? caught.message : 'The dispense could not be completed.',
      });
    } finally {
      setDispensing(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Dispensing"
        subtitle="Prescriptions awaiting the pharmacy, controlled drugs first"
      />

      {notice ? (
        <div className="mb-5">
          <Alert tone={notice.tone} title={notice.tone === 'good' ? 'Dispensed' : 'Not dispensed'}>
            {notice.text}
          </Alert>
        </div>
      ) : null}

      <section aria-label="Queue summary" className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Prescriptions waiting" value={queue.length} emphasis />
        <StatTile
          label="Lines outstanding"
          value={outstandingLines}
          hint="Individual medicines to pick"
        />
        <StatTile
          label="Controlled"
          value={controlled.length}
          tone={controlled.length > 0 ? 'serious' : 'neutral'}
          hint="Register entry and a locked cabinet"
        />
        <StatTile
          label="Cold chain"
          value={coldChain.length}
          tone={coldChain.length > 0 ? 'info' : 'neutral'}
          hint="Must not sit on the counter"
        />
      </section>

      {canDispense ? (
        <div className="mb-5">
          <Card>
            <CardHeader
              title="Dispensing from"
              subtitle="Stock is held per store, and batches are picked first-expiry-first-out within it"
            />
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label
                  htmlFor="location"
                  className="mb-1.5 block text-[0.8125rem] font-medium"
                  style={{ color: 'var(--ink-secondary)' }}
                >
                  Store
                </label>
                <select
                  id="location"
                  value={locationId}
                  onChange={(event) => setLocationId(event.target.value)}
                  className="h-9.5 rounded-[var(--radius-md)] px-3 text-[0.875rem]"
                  style={{
                    background: 'var(--surface)',
                    color: 'var(--ink)',
                    border: '1px solid var(--line-strong)',
                  }}
                >
                  {locations.length === 0 ? <option value="">No stores available</option> : null}
                  {locations.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} ({humanise(option.kind)})
                    </option>
                  ))}
                </select>
              </div>

              {location ? (
                <div className="flex flex-wrap items-center gap-2 pb-1.5">
                  <Badge tone={location.allows_controlled ? 'serious' : 'neutral'} dot>
                    {location.allows_controlled ? 'Controlled drugs allowed' : 'No controlled drugs'}
                  </Badge>
                  {location.temperature_controlled ? (
                    <Badge tone="info" dot>
                      Temperature controlled
                    </Badge>
                  ) : null}
                  <span className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                    {pluralise(Number(location.batches_available), 'batch', 'batches')} on hand
                  </span>
                </div>
              ) : null}
            </div>

            {location && !location.allows_controlled && controlled.length > 0 ? (
              <div className="mt-3">
                <Alert tone="warning" title="This store cannot hold controlled drugs">
                  {pluralise(controlled.length, 'prescription')} in the queue{' '}
                  {controlled.length === 1 ? 'includes' : 'include'} a controlled medicine. Dispense
                  those from the controlled cabinet — the stock ledger will refuse the movement from
                  here.
                </Alert>
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      <Card padded={false}>
        {error ? (
          <div className="p-4">
            <p className="text-[0.875rem]" style={{ color: 'var(--critical-ink)' }}>
              {error}
            </p>
          </div>
        ) : loading && queue.length === 0 ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={48} />
            ))}
          </div>
        ) : queue.length === 0 ? (
          <EmptyState
            icon={<IconPill />}
            title="The queue is clear"
            description="Nothing is waiting to be dispensed. Prescriptions appear here as soon as they are signed."
          />
        ) : (
          <div className="px-5 pb-1">
            <Table>
              <thead>
                <tr>
                  <Th>Patient</Th>
                  <Th width="9.5rem">Prescription</Th>
                  <Th>To dispense</Th>
                  <Th>Prescriber</Th>
                  <Th align="right">Waiting</Th>
                  <Th align="right" width="11rem">
                    Handling
                  </Th>
                  {canDispense ? (
                    <Th align="right" width="9rem">
                      <span className="sr-only">Dispense</span>
                    </Th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => {
                  const blocked = item.has_controlled && location !== null && !location.allows_controlled;

                  return (
                    <Tr key={item.id}>
                      <Td>
                        <span className="block font-medium" style={{ color: 'var(--ink)' }}>
                          {item.patient_name}
                        </span>
                        <span className="tabular text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                          {item.mrn}
                        </span>
                      </Td>
                      <Td>
                        <span
                          className="tabular block whitespace-nowrap"
                          style={{ color: 'var(--ink-secondary)' }}
                        >
                          {item.reference}
                        </span>
                        <Badge tone={item.status === 'partially_dispensed' ? 'warning' : 'info'} dot>
                          {humanise(item.status)}
                        </Badge>
                      </Td>
                      <Td>
                        <ul className="flex flex-col gap-1">
                          {item.outstanding_items.map((line) => (
                            <li key={line.id} className="text-[0.8125rem]">
                              <span style={{ color: 'var(--ink)' }}>
                                {line.medicationName}
                              </span>
                              <span className="tabular ml-1.5" style={{ color: 'var(--ink-muted)' }}>
                                ×{Number(line.quantityPrescribed) - Number(line.quantityDispensed)}
                              </span>
                              {line.controlledSchedule ? (
                                <Badge tone="serious" className="ml-1.5">
                                  Sch {line.controlledSchedule}
                                </Badge>
                              ) : null}
                              <span className="block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                                {line.instructions}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </Td>
                      <Td style={{ color: 'var(--ink-muted)' }}>{item.prescriber_name}</Td>
                      <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                        <span title={formatDateTime(item.prescribed_at)}>
                          {formatRelative(item.prescribed_at)}
                        </span>
                      </Td>
                      <Td align="right">
                        <span className="flex flex-wrap items-center justify-end gap-1.5">
                          {item.has_controlled ? (
                            <Badge tone="serious">Controlled</Badge>
                          ) : null}
                          {item.needs_cold_chain ? <Badge tone="info">Cold chain</Badge> : null}
                          {!item.has_controlled && !item.needs_cold_chain ? (
                            <span className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                              Routine
                            </span>
                          ) : null}
                        </span>
                      </Td>
                      {canDispense ? (
                        <Td align="right">
                          <Button
                            className="whitespace-nowrap"
                            size="sm"
                            variant={blocked ? 'secondary' : 'primary'}
                            disabled={blocked || !location || dispensing !== null}
                            loading={dispensing === item.id}
                            icon={item.has_controlled ? <IconShield className="h-3.5 w-3.5" /> : undefined}
                            onClick={() => void dispense(item)}
                            title={
                              blocked
                                ? 'This store is not authorised for controlled drugs'
                                : `Dispense every outstanding line from ${location?.name ?? 'the selected store'}`
                            }
                          >
                            Dispense all
                          </Button>
                        </Td>
                      ) : null}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
