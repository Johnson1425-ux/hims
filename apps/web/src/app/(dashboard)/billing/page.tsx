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
import { api, ApiError, type InvoiceListItem } from '@/lib/api';
import { formatDate, formatMoney, humanise } from '@/lib/format';
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
  const [loading, setLoading] = useState(true);
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
            <Button variant="primary" icon={<IconReceipt />}>
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
                        {invoice.invoice_number}
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
    </>
  );
}
