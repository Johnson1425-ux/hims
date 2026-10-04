'use client';

/**
 * Billing and receivables.
 *
 * Money is rendered from integer cents through Intl.NumberFormat — the value
 * never passes through a float on its way to the screen, matching how it is
 * stored and claimed.
 *
 * The ageing panel leads because that is the question finance opens with: not
 * "what did we bill" but "what is old and who owes it".
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/layout/shell';
import {
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
  type Tone,
} from '@/components/ui/primitives';
import { AgeingBar } from '@/components/charts/ageing-bar';
import { useSession } from '@/lib/session';
import {
  api,
  ApiError,
  type InvoiceListItem,
  type PatientSummary,
  type ServiceItem,
} from '@/lib/api';
import { Field, FormDialog, Select, useFormErrors } from '@/components/ui/forms';
import { PatientPicker } from '@/components/ui/patient-picker';
import { formatDate, formatMoney, formatNumber, humanise } from '@/lib/format';
import { IconReceipt } from '@/components/layout/icons';

const STATUS_TONE: Record<string, Tone> = {
  draft: 'neutral',
  issued: 'info',
  partially_paid: 'warning',
  paid: 'good',
  overdue: 'critical',
  void: 'neutral',
  written_off: 'neutral',
  refunded: 'neutral',
};

export default function BillingPage() {
  const { can } = useSession();
  const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);
  const [ageing, setAgeing] = useState<Record<string, { totalCents: number; count: number }>>({});
  const [overdueOnly, setOverdueOnly] = useState(false);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [raising, setRaising] = useState(false);
  const [invoicePatient, setInvoicePatient] = useState<PatientSummary | null>(null);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [draftLines, setDraftLines] = useState<Array<{ key: string; serviceItemId: string; quantity: string }>>([]);
  const [dueInDays, setDueInDays] = useState('30');
  const newInvoiceForm = useFormErrors();
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const { data, meta } = await api.get<InvoiceListItem[]>('/billing/invoices', {
        overdueOnly: overdueOnly || undefined,
        pageSize: 50,
      });
      setInvoices(data);
      setAgeing((meta?.ageing as Record<string, { totalCents: number; count: number }>) ?? {});
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught.message);
    } finally {
      setLoading(false);
    }
  }, [overdueOnly]);

  // The catalogue is small and changes rarely, so it is fetched once rather
  // than per keystroke: a line chosen from it carries its CPT code and the
  // price that gets snapshotted onto the invoice.
  useEffect(() => {
    const controller = new AbortController();

    void api
      .get<ServiceItem[]>('/billing/service-items', undefined, controller.signal)
      .then(({ data }) => setServices(data))
      .catch(() => undefined);

    return () => controller.abort();
  }, []);

  async function raiseInvoice(): Promise<void> {
    if (!invoicePatient) return;
    newInvoiceForm.reset();

    try {
      const { data } = await api.post<{ id: string }>('/billing/invoices', {
        patientId: invoicePatient.id,
        dueInDays: Number(dueInDays),
        lines: draftLines
          .filter((line) => line.serviceItemId)
          .map((line) => {
            const service = services.find((s) => s.id === line.serviceItemId)!;
            return {
              serviceItemId: service.id,
              description: service.name,
              cptCode: service.cpt_code ?? undefined,
              quantity: Number(line.quantity) || 1,
              sourceKind: 'manual',
            };
          }),
      });

      setRaising(false);
      router.push(`/billing/${data.id}`);
    } catch (caught) {
      newInvoiceForm.capture(caught);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  const outstanding = Object.values(ageing).reduce((sum, b) => sum + b.totalCents, 0);
  const aged =
    (ageing['61-90']?.totalCents ?? 0) + (ageing['90+']?.totalCents ?? 0);

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Invoices, payments and insurance claims"
        actions={
          can('invoice:write') ? (
            <Button
              variant="primary"
              icon={<IconReceipt />}
              onClick={() => {
                setInvoicePatient(null);
                setDraftLines([]);
                newInvoiceForm.reset();
                setRaising(true);
              }}
            >
              New invoice
            </Button>
          ) : null
        }
      />

      <section aria-label="Receivables summary" className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Outstanding"
          value={formatMoney(outstanding)}
          emphasis
          hint="Across all unpaid invoices"
        />
        <StatTile
          label="Over 60 days"
          value={formatMoney(aged)}
          tone={aged > 0 ? 'warning' : 'good'}
          hint={aged > 0 ? 'At risk of becoming uncollectable' : 'Nothing aged'}
        />
        <StatTile
          label="Invoices shown"
          value={invoices.length}
          hint={overdueOnly ? 'Overdue only' : 'Most recent 50'}
        />
      </section>

      <div className="grid gap-5 xl:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader title="Receivables ageing" subtitle="Outstanding balance by age of debt" />
          {loading ? <Skeleton height={180} /> : <AgeingBar buckets={ageing} />}
        </Card>

        <Card padded={false}>
          <div className="flex items-center justify-between gap-3 p-5 pb-4">
            <CardHeader title="Invoices" />
            <label className="flex cursor-pointer items-center gap-2 text-[0.8125rem]" style={{ color: 'var(--ink-secondary)' }}>
              <input
                type="checkbox"
                checked={overdueOnly}
                onChange={(event) => setOverdueOnly(event.target.checked)}
              />
              Overdue only
            </label>
          </div>

          {error ? (
            <div className="p-5 pt-0">
              <p className="text-[0.875rem]" style={{ color: 'var(--critical-ink)' }}>
                {error}
              </p>
            </div>
          ) : loading && invoices.length === 0 ? (
            <div className="flex flex-col gap-2 p-5 pt-0">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} height={40} />
              ))}
            </div>
          ) : invoices.length === 0 ? (
            <EmptyState
              icon={<IconReceipt />}
              title={overdueOnly ? 'Nothing is overdue' : 'No invoices yet'}
              description={overdueOnly ? 'Every invoice is within its payment terms.' : undefined}
            />
          ) : (
            <div className="px-5 pb-1">
              <Table>
                <thead>
                  <tr>
                    <Th>Invoice</Th>
                    <Th>Patient</Th>
                    <Th>Payer</Th>
                    <Th align="right">Total</Th>
                    <Th align="right">Balance</Th>
                    <Th align="right">Due</Th>
                    <Th align="right" width="8rem">
                      Status
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <Tr key={invoice.id}>
                      <Td numeric className="font-medium whitespace-nowrap">
                        <Link href={`/billing/${invoice.id}`} style={{ color: 'var(--accent)' }}>
                          {invoice.invoice_number}
                        </Link>
                      </Td>
                      <Td>
                        <span className="block truncate">{invoice.patient_name}</span>
                        <span className="tabular block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                          {invoice.mrn}
                        </span>
                      </Td>
                      <Td style={{ color: 'var(--ink-muted)' }}>{invoice.payer_name ?? 'Self-pay'}</Td>
                      <Td numeric align="right">
                        {formatMoney(invoice.total_cents)}
                      </Td>
                      <Td
                        numeric
                        align="right"
                        className="font-medium"
                        style={{ color: invoice.balance_cents > 0 ? 'var(--ink)' : 'var(--good-ink)' }}
                      >
                        {formatMoney(invoice.balance_cents)}
                      </Td>
                      <Td numeric align="right" className="whitespace-nowrap" style={{ color: 'var(--ink-muted)' }}>
                        {invoice.due_on ? formatDate(invoice.due_on) : '—'}
                        {invoice.days_overdue > 0 ? (
                          <span className="block text-[0.6875rem]" style={{ color: 'var(--critical-ink)' }}>
                            {invoice.days_overdue}d late
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right">
                        <Badge tone={STATUS_TONE[invoice.status] ?? 'neutral'}>
                          {humanise(invoice.status)}
                        </Badge>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      <FormDialog
        open={raising}
        onClose={() => setRaising(false)}
        title="New invoice"
        description="Prices are taken from the catalogue and snapshotted onto the invoice"
        submitLabel="Raise the invoice"
        message={newInvoiceForm.message}
        width="44rem"
        disabled={!invoicePatient || draftLines.filter((l) => l.serviceItemId).length === 0}
        onSubmit={raiseInvoice}
      >
        <PatientPicker
          value={invoicePatient}
          onChange={setInvoicePatient}
          error={newInvoiceForm.errors.patientId}
          autoFocus
        />

        <div className="flex flex-col gap-3">
          <span className="text-[0.8125rem] font-medium" style={{ color: 'var(--ink-secondary)' }}>
            Lines
          </span>

          {draftLines.map((line, index) => {
            const service = services.find((s) => s.id === line.serviceItemId);

            return (
              <div key={line.key} className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Select
                    name={`service-${line.key}`}
                    label={index === 0 ? 'Service' : undefined}
                    placeholder="Choose a service"
                    options={services.map((s) => ({
                      value: s.id,
                      label: `${s.name} — ${formatMoney(s.unit_price_cents)}`,
                    }))}
                    value={line.serviceItemId}
                    onChange={(event) =>
                      setDraftLines((current) =>
                        current.map((l) =>
                          l.key === line.key ? { ...l, serviceItemId: event.target.value } : l,
                        ),
                      )
                    }
                  />
                </div>
                <div className="w-20 shrink-0">
                  <Field
                    name={`qty-${line.key}`}
                    label={index === 0 ? 'Qty' : undefined}
                    type="number"
                    min={1}
                    value={line.quantity}
                    onChange={(event) =>
                      setDraftLines((current) =>
                        current.map((l) => (l.key === line.key ? { ...l, quantity: event.target.value } : l)),
                      )
                    }
                  />
                </div>
                <div className="w-24 shrink-0 pb-2 text-right">
                  <span className="tabular text-[0.875rem]" style={{ color: 'var(--ink)' }}>
                    {service ? formatMoney(service.unit_price_cents * (Number(line.quantity) || 1)) : '—'}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mb-1"
                  onClick={() => setDraftLines((current) => current.filter((l) => l.key !== line.key))}
                >
                  Remove
                </Button>
              </div>
            );
          })}

          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setDraftLines((current) => [
                  ...current,
                  { key: Math.random().toString(36).slice(2), serviceItemId: '', quantity: '1' },
                ])
              }
            >
              Add a line
            </Button>
          </div>

          {draftLines.filter((l) => l.serviceItemId).length > 0 ? (
            <div
              className="flex items-center justify-between rounded-[var(--radius-md)] p-3"
              style={{ background: 'var(--surface-sunken)' }}
            >
              <span className="text-[0.875rem]" style={{ color: 'var(--ink-secondary)' }}>
                {formatNumber(draftLines.filter((l) => l.serviceItemId).length)} line(s)
              </span>
              <span className="tabular text-[1rem] font-semibold" style={{ color: 'var(--ink)' }}>
                {formatMoney(
                  draftLines.reduce((sum, line) => {
                    const service = services.find((s) => s.id === line.serviceItemId);
                    return sum + (service ? service.unit_price_cents * (Number(line.quantity) || 1) : 0);
                  }, 0),
                )}
              </span>
            </div>
          ) : null}
        </div>

        <Field
          name="dueInDays"
          label="Payment terms (days)"
          type="number"
          min={0}
          max={365}
          hint="Drives the ageing buckets and the overdue flag."
          value={dueInDays}
          error={newInvoiceForm.errors.dueInDays}
          onChange={(event) => setDueInDays(event.target.value)}
        />
      </FormDialog>
    </>
  );
}
