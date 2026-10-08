'use client';

/**
 * The vendor's books: what each hospital owes for the software.
 *
 * Not to be confused with /billing, which is a hospital's own revenue from
 * its patients. Different money, different company, deliberately a different
 * screen behind a different sign-in.
 *
 * Two things this screen refuses to do, both for the same reason — a number
 * that looks authoritative and is not is worse than no number:
 *
 *   - It never sums across currencies. TZS and USD figures sit in separate
 *     cards, because one combined "total revenue" would be meaningless and
 *     would still get quoted in a board pack.
 *   - It shows what a billing run WOULD issue before issuing anything. The
 *     run is the one action here that creates a financial obligation, so it
 *     is not a button you can press without first seeing the consequence.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ApiError,
  platformApi,
  type BillingRunResult,
  type DueRow,
  type PlanRow,
  type RevenueRow,
  type SubscriptionInvoiceRow,
} from '@/lib/platform-api';
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
import { ConsoleShell, PageHeader, StatusBadge } from '@/components/platform/console-shell';
import { RecordPaymentDialog } from '@/components/platform/record-payment-dialog';
import { PlanEditor } from '@/components/platform/plan-editor';
import { formatMoney } from '@/lib/format';

export default function BillingPage() {
  return (
    <ConsoleShell>
      <Billing />
    </ConsoleShell>
  );
}

function Billing() {
  const [revenue, setRevenue] = useState<RevenueRow[]>([]);
  const [invoices, setInvoices] = useState<SubscriptionInvoiceRow[]>([]);
  const [due, setDue] = useState<DueRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  const [overdueOnly, setOverdueOnly] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<BillingRunResult | null>(null);
  const [paying, setPaying] = useState<SubscriptionInvoiceRow | null>(null);
  const [showPlans, setShowPlans] = useState(false);

  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const [r, i, d, p] = await Promise.all([
          platformApi.get<RevenueRow[]>('/billing/summary', undefined, controller.signal),
          platformApi.get<SubscriptionInvoiceRow[]>(
            '/billing/invoices',
            { overdueOnly, pageSize: 100 },
            controller.signal,
          ),
          platformApi.get<DueRow[]>('/billing/due', undefined, controller.signal),
          platformApi.get<PlanRow[]>('/billing/plans', undefined, controller.signal),
        ]);

        setRevenue(r.data);
        setInvoices(i.data);
        setDue(d.data);
        setPlans(p.data);
        setStatus('ready');
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught instanceof ApiError ? caught.message : 'Billing could not be loaded.');
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [token, overdueOnly]);

  const runBilling = async () => {
    setRunning(true);
    setError(null);

    try {
      const { data } = await platformApi.post<BillingRunResult>('/billing/run');
      setRunResult(data);
      reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The billing run failed.');
    } finally {
      setRunning(false);
    }
  };

  if (status === 'loading') {
    return (
      <>
        <PageHeader title="Billing" subtitle="What each hospital owes for the software" />
        <div className="mb-5 grid gap-3 lg:grid-cols-2">
          {[0, 1].map((n) => (
            <Card key={n}>
              <Skeleton className="w-32" height={14} />
              <Skeleton className="mt-4 w-full" height={48} />
            </Card>
          ))}
        </div>
        <Card>
          <Skeleton className="w-full" height={200} />
        </Card>
      </>
    );
  }

  if (status === 'error') {
    return (
      <>
        <PageHeader title="Billing" />
        <Alert tone="critical" title="Billing could not be loaded">
          {error}
        </Alert>
      </>
    );
  }

  const dueTotal = due.reduce((sum, row) => sum + Number(row.amount_cents) * row.periods_due, 0);
  const periodsDue = due.reduce((n, r) => n + r.periods_due, 0);
  const oneCurrency = new Set(due.map((d) => d.currency)).size === 1;

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="The vendor's own books — not a hospital's revenue from its patients"
      />

      {error ? (
        <div className="mb-5">
          <Alert tone="critical">{error}</Alert>
        </div>
      ) : null}

      {/* ---- Revenue, one card per currency ----------------------------- */}
      {revenue.length === 0 ? (
        <div className="mb-5">
          <Card>
            <EmptyState
              title="No hospital has subscription terms yet"
              description="A hospital is invisible to the billing run until its subscription is set up on its own page."
            />
          </Card>
        </div>
      ) : (
        <div
          className={`mb-5 grid gap-3 ${revenue.length > 1 ? 'lg:grid-cols-2' : ''}`}
        >
          {revenue.map((row) => (
            <Card key={row.currency}>
              <CardHeader
                title={`Revenue · ${row.currency}`}
                subtitle={`${row.active_subscriptions} active, ${row.trialing} on trial`}
              />
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile label="MRR" value={formatMoney(Number(row.mrr_cents), row.currency)} />
                <StatTile
                  label="Outstanding"
                  value={formatMoney(Number(row.outstanding_cents), row.currency)}
                />
                <StatTile
                  label="Overdue"
                  value={formatMoney(Number(row.overdue_cents), row.currency)}
                  tone={Number(row.overdue_cents) > 0 ? 'warning' : 'neutral'}
                  hint={
                    Number(row.overdue_invoice_count) > 0
                      ? `${row.overdue_invoice_count} invoice${Number(row.overdue_invoice_count) === 1 ? '' : 's'}`
                      : 'nothing late'
                  }
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ---- The billing run ------------------------------------------- */}
      <div className="mb-5">
        <Card>
          <CardHeader
            title="Billing run"
            subtitle={
              due.length === 0
                ? 'One invoice per hospital per unbilled period'
                : `${due.length} hospital${due.length === 1 ? '' : 's'} due, ${periodsDue} invoice${periodsDue === 1 ? '' : 's'} to issue`
            }
            action={
              due.length > 0 ? (
                <Button variant="primary" loading={running} onClick={() => void runBilling()}>
                  {running ? 'Issuing…' : `Issue ${periodsDue} invoice${periodsDue === 1 ? '' : 's'}`}
                </Button>
              ) : null
            }
          />

          {runResult ? (
            <div className="mb-4">
              <Alert
                tone={runResult.skipped.length > 0 ? 'warning' : 'good'}
                title={`Issued ${runResult.issued.length} invoice${runResult.issued.length === 1 ? '' : 's'}`}
                action={
                  <Button size="sm" variant="ghost" onClick={() => setRunResult(null)}>
                    Dismiss
                  </Button>
                }
              >
                <ul className="mt-1 flex flex-col gap-0.5">
                  {runResult.issued.map((i) => (
                    <li key={i.invoiceNumber} className="tabular">
                      {i.invoiceNumber} · {i.tenantName} · {formatMoney(i.totalCents, i.currency)}
                    </li>
                  ))}
                </ul>
                {runResult.skipped.length > 0 ? (
                  <div className="mt-2">
                    <p className="font-semibold">Needs attention:</p>
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {runResult.skipped.map((s) => (
                        <li key={s.tenantName}>
                          {s.tenantName} — {s.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Alert>
            </div>
          ) : null}

          {due.length === 0 ? (
            <p className="text-[0.875rem]" style={{ color: 'var(--ink-muted)' }}>
              Nothing is due — every hospital is invoiced up to date, so running it again would
              do nothing.
            </p>
          ) : (
            <>
              <p className="-mt-2 mb-3 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                This is what pressing the button would create — look before you issue. A hospital
                more than one period behind gets one invoice per missed period, so the run leaves
                nothing outstanding and pressing it twice is a no-op.
              </p>
              <Table>
                <thead>
                  <tr>
                    <Th>Hospital</Th>
                    <Th>Paid up to</Th>
                    <Th align="right">Periods</Th>
                    <Th align="right">Will be invoiced</Th>
                  </tr>
                </thead>
                <tbody>
                  {due.map((row) => (
                    <Tr key={row.tenant_id}>
                      <Td>{row.display_name}</Td>
                      <Td numeric style={{ color: 'var(--ink-secondary)' }}>
                        {row.current_period_end.slice(0, 10)}
                      </Td>
                      <Td align="right" numeric>
                        {row.periods_due > 1 ? (
                          <span style={{ color: 'var(--warning-ink)' }}>
                            {row.periods_due} (in arrears)
                          </span>
                        ) : (
                          row.periods_due
                        )}
                      </Td>
                      <Td align="right" numeric>
                        {formatMoney(Number(row.amount_cents) * row.periods_due, row.currency)}
                      </Td>
                    </Tr>
                  ))}
                  {due.length > 1 ? (
                    <tr>
                      <Td colSpan={2} />
                      <Td align="right" style={{ color: 'var(--ink-muted)' }}>
                        Total
                      </Td>
                      <Td align="right" numeric className="font-semibold">
                        {/* Safe to sum only when every due row shares one
                            currency. Mixed currencies are listed per row
                            above and the total is suppressed. */}
                        {oneCurrency ? formatMoney(dueTotal, due[0]!.currency) : 'mixed currencies'}
                      </Td>
                    </tr>
                  ) : null}
                </tbody>
              </Table>
            </>
          )}
        </Card>
      </div>

      {/* ---- The ledger -------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Invoices"
          subtitle="Overdue first, then newest"
          action={
            <Button size="sm" variant="secondary" onClick={() => setOverdueOnly((v) => !v)}>
              {overdueOnly ? 'Show all' : 'Overdue only'}
            </Button>
          }
        />

        <Table className="min-w-[56rem]">
          <thead>
            <tr>
              <Th>Invoice</Th>
              <Th>Hospital</Th>
              <Th>Period</Th>
              <Th align="right">Total</Th>
              <Th align="right">Balance</Th>
              <Th>Status</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 ? (
              <tr>
                <Td colSpan={7}>
                  {overdueOnly ? (
                    <EmptyState
                      title="Nothing overdue"
                      description="Every issued invoice is either paid or still within its payment terms."
                      action={
                        <Button variant="secondary" onClick={() => setOverdueOnly(false)}>
                          Show all invoices
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      title="No invoices issued yet"
                      description="The billing run above creates them, one per hospital per period."
                    />
                  )}
                </Td>
              </tr>
            ) : (
              invoices.map((invoice) => (
                <Tr key={invoice.id}>
                  <Td>
                    <span className="tabular font-medium">{invoice.invoice_number}</span>
                    <div className="mt-0.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                      due {invoice.due_on.slice(0, 10)}
                    </div>
                  </Td>
                  <Td>
                    <Link
                      href={`/platform/tenants/${invoice.tenant_id}`}
                      className="hover:underline"
                      style={{ color: 'var(--ink)' }}
                    >
                      {invoice.tenant_name}
                    </Link>
                  </Td>
                  <Td numeric style={{ color: 'var(--ink-secondary)' }}>
                    <span className="text-[0.8125rem]">
                      {invoice.period_start.slice(0, 10)} → {invoice.period_end.slice(0, 10)}
                    </span>
                  </Td>
                  <Td align="right" numeric>
                    {formatMoney(Number(invoice.total_cents), invoice.currency)}
                  </Td>
                  <Td
                    align="right"
                    numeric
                    style={{
                      color: invoice.is_overdue ? 'var(--warning-ink)' : undefined,
                      fontWeight: invoice.is_overdue ? 600 : undefined,
                    }}
                  >
                    {/*
                      A void invoice still carries total-minus-paid in the
                      column, but nobody owes it. Printing that figure beside
                      a "Void" badge invites someone to chase it.
                    */}
                    {invoice.status === 'void' ? (
                      <span style={{ color: 'var(--ink-muted)' }}>—</span>
                    ) : (
                      formatMoney(Number(invoice.balance_cents), invoice.currency)
                    )}
                  </Td>
                  <Td>
                    {/*
                      Both badges, not one: "partially paid" and "overdue" are
                      independently true, and collapsing them would hide that
                      money has already come in against a late invoice.
                    */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge value={invoice.status} />
                      {invoice.is_overdue ? (
                        <Badge tone="warning">{invoice.days_overdue}d late</Badge>
                      ) : null}
                    </div>
                  </Td>
                  <Td align="right">
                    {invoice.status === 'paid' || invoice.status === 'void' ? (
                      <span className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                        —
                      </span>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => setPaying(invoice)}>
                        Record payment
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))
            )}
          </tbody>
        </Table>
      </Card>

      {/* ---- The price book ---------------------------------------------- */}
      <div className="mt-5">
        <Card>
          <CardHeader
            title="Price book"
            subtitle="What each tier costs. Changing a price never restates an invoice already issued."
            action={
              <Button size="sm" variant="secondary" onClick={() => setShowPlans((v) => !v)}>
                {showPlans ? 'Hide' : 'Show'}
              </Button>
            }
          />
          {showPlans ? <PlanEditor plans={plans} onSaved={reload} /> : null}
        </Card>
      </div>

      <RecordPaymentDialog invoice={paying} onClose={() => setPaying(null)} onRecorded={reload} />
    </>
  );
}
