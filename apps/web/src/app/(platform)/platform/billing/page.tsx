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
 *     rows, because one combined "total revenue" would be meaningless and
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
  ConsoleBadge,
  ConsoleButton,
  ConsoleCard,
  ConsoleShell,
  ConsoleTable,
  ConsoleTd,
  ConsoleTh,
} from '@/components/platform/console-shell';
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
    return <p className="text-[0.875rem]" style={{ color: '#64748b' }}>Loading…</p>;
  }

  if (status === 'error') {
    return (
      <div className="rounded-[8px] px-4 py-3 text-[0.875rem]" style={{ background: '#450a0a', color: '#fecaca' }}>
        {error}
      </div>
    );
  }

  const dueTotal = due.reduce((sum, row) => sum + Number(row.amount_cents) * row.periods_due, 0);

  return (
    <>
      {error ? (
        <div className="mb-5 rounded-[8px] px-4 py-3 text-[0.875rem]" style={{ background: '#450a0a', color: '#fecaca' }}>
          {error}
        </div>
      ) : null}

      {/* ---- Revenue, one row per currency ----------------------------- */}
      <div className="mb-5 grid gap-3 lg:grid-cols-2">
        {revenue.length === 0 ? (
          <ConsoleCard title="Revenue">
            <p className="text-[0.875rem]" style={{ color: '#64748b' }}>
              No hospital has subscription terms yet.
            </p>
          </ConsoleCard>
        ) : (
          revenue.map((row) => (
            <ConsoleCard
              key={row.currency}
              title={`Revenue · ${row.currency}`}
              subtitle={`${row.active_subscriptions} active, ${row.trialing} on trial`}
            >
              <div className="grid grid-cols-3 gap-4">
                <Figure label="MRR" value={formatMoney(Number(row.mrr_cents), row.currency)} />
                <Figure
                  label="Outstanding"
                  value={formatMoney(Number(row.outstanding_cents), row.currency)}
                />
                <Figure
                  label="Overdue"
                  value={formatMoney(Number(row.overdue_cents), row.currency)}
                  hint={
                    Number(row.overdue_invoice_count) > 0
                      ? `${row.overdue_invoice_count} invoice${Number(row.overdue_invoice_count) === 1 ? '' : 's'}`
                      : undefined
                  }
                  alarming={Number(row.overdue_cents) > 0}
                />
              </div>
            </ConsoleCard>
          ))
        )}
      </div>

      {/* ---- The billing run ------------------------------------------- */}
      <div className="mb-5">
        <ConsoleCard
          title="Billing run"
          subtitle={
            due.length === 0
              ? 'Nothing is due. Every hospital is invoiced up to date.'
              : `${due.length} hospital${due.length === 1 ? '' : 's'} due`
          }
          action={
            due.length > 0 ? (
              <ConsoleButton variant="primary" disabled={running} onClick={() => void runBilling()}>
                {running ? 'Issuing…' : `Issue ${due.reduce((n, r) => n + r.periods_due, 0)} invoices`}
              </ConsoleButton>
            ) : null
          }
        >
          {runResult ? (
            <div
              className="mb-4 rounded-[8px] px-3 py-3 text-[0.8125rem]"
              style={{ background: '#052e16', color: '#bbf7d0' }}
            >
              <p className="font-medium">
                Issued {runResult.issued.length} invoice{runResult.issued.length === 1 ? '' : 's'}.
              </p>
              <ul className="mt-1.5">
                {runResult.issued.map((i) => (
                  <li key={i.invoiceNumber}>
                    {i.invoiceNumber} · {i.tenantName} · {formatMoney(i.totalCents, i.currency)}
                  </li>
                ))}
              </ul>
              {runResult.skipped.length > 0 ? (
                <div className="mt-2" style={{ color: '#fde68a' }}>
                  <p className="font-medium">Needs attention:</p>
                  <ul className="mt-1">
                    {runResult.skipped.map((s) => (
                      <li key={s.tenantName}>
                        {s.tenantName} — {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <button
                type="button"
                className="mt-2 underline"
                onClick={() => setRunResult(null)}
                style={{ color: '#86efac' }}
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {due.length === 0 ? (
            <p className="text-[0.875rem]" style={{ color: '#64748b' }}>
              Running it again would do nothing.
            </p>
          ) : (
            <>
              <p className="mb-3 text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                This is what pressing the button would create — look before you issue. A hospital
                more than one period behind gets one invoice per missed period, so the run leaves
                nothing outstanding and pressing it twice is a no-op.
              </p>
              <ConsoleTable
                head={
                  <>
                    <ConsoleTh>Hospital</ConsoleTh>
                    <ConsoleTh>Paid up to</ConsoleTh>
                    <ConsoleTh align="right">Periods</ConsoleTh>
                    <ConsoleTh align="right">Will be invoiced</ConsoleTh>
                  </>
                }
              >
                {due.map((row) => (
                  <tr key={row.tenant_id}>
                    <ConsoleTd>{row.display_name}</ConsoleTd>
                    <ConsoleTd muted>{row.current_period_end.slice(0, 10)}</ConsoleTd>
                    <ConsoleTd align="right" muted>
                      {row.periods_due > 1 ? (
                        <span style={{ color: '#fbbf24' }}>{row.periods_due} (in arrears)</span>
                      ) : (
                        row.periods_due
                      )}
                    </ConsoleTd>
                    <ConsoleTd align="right">
                      {formatMoney(Number(row.amount_cents) * row.periods_due, row.currency)}
                    </ConsoleTd>
                  </tr>
                ))}
                {due.length > 1 ? (
                  <tr>
                    <ConsoleTd />
                    <ConsoleTd />
                    <ConsoleTd align="right" muted>
                      Total
                    </ConsoleTd>
                    <ConsoleTd align="right">
                      {/* Safe to sum: every due row here shares one currency
                          only when it does. Mixed currencies are listed per
                          row above and this total is suppressed. */}
                      {new Set(due.map((d) => d.currency)).size === 1
                        ? formatMoney(dueTotal, due[0]!.currency)
                        : 'mixed currencies'}
                    </ConsoleTd>
                  </tr>
                ) : null}
              </ConsoleTable>
            </>
          )}
        </ConsoleCard>
      </div>

      {/* ---- The ledger -------------------------------------------------- */}
      <ConsoleCard
        title="Invoices"
        subtitle="Overdue first, then newest"
        padded={false}
        action={
          <ConsoleButton onClick={() => setOverdueOnly((v) => !v)}>
            {overdueOnly ? 'Show all' : 'Overdue only'}
          </ConsoleButton>
        }
      >
        <div className="px-5 pb-4">
          <ConsoleTable
            head={
              <>
                <ConsoleTh>Invoice</ConsoleTh>
                <ConsoleTh>Hospital</ConsoleTh>
                <ConsoleTh>Period</ConsoleTh>
                <ConsoleTh align="right">Total</ConsoleTh>
                <ConsoleTh align="right">Balance</ConsoleTh>
                <ConsoleTh>Status</ConsoleTh>
                <ConsoleTh align="right">Actions</ConsoleTh>
              </>
            }
          >
            {invoices.length === 0 ? (
              <tr>
                <ConsoleTd muted>
                  {overdueOnly ? 'Nothing overdue.' : 'No invoices issued yet.'}
                </ConsoleTd>
              </tr>
            ) : (
              invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <ConsoleTd>
                    <span className="tabular-nums">{invoice.invoice_number}</span>
                    <div className="mt-0.5 text-[0.75rem]" style={{ color: '#64748b' }}>
                      due {invoice.due_on.slice(0, 10)}
                    </div>
                  </ConsoleTd>
                  <ConsoleTd>
                    <Link
                      href={`/platform/tenants/${invoice.tenant_id}`}
                      className="hover:underline"
                    >
                      {invoice.tenant_name}
                    </Link>
                  </ConsoleTd>
                  <ConsoleTd muted>
                    <span className="text-[0.8125rem]">
                      {invoice.period_start.slice(0, 10)} → {invoice.period_end.slice(0, 10)}
                    </span>
                  </ConsoleTd>
                  <ConsoleTd align="right">
                    <span className="tabular-nums">
                      {formatMoney(Number(invoice.total_cents), invoice.currency)}
                    </span>
                  </ConsoleTd>
                  <ConsoleTd align="right">
                    <span
                      className="tabular-nums"
                      style={{ color: invoice.is_overdue ? '#fbbf24' : undefined }}
                    >
                      {formatMoney(Number(invoice.balance_cents), invoice.currency)}
                    </span>
                  </ConsoleTd>
                  <ConsoleTd>
                    <ConsoleBadge value={invoice.status} />
                    {invoice.is_overdue ? (
                      <div className="mt-1 text-[0.75rem]" style={{ color: '#fbbf24' }}>
                        {invoice.days_overdue} days overdue
                      </div>
                    ) : null}
                  </ConsoleTd>
                  <ConsoleTd align="right">
                    {invoice.status === 'paid' || invoice.status === 'void' ? (
                      <span className="text-[0.8125rem]" style={{ color: '#475569' }}>
                        —
                      </span>
                    ) : (
                      <ConsoleButton onClick={() => setPaying(invoice)}>Record payment</ConsoleButton>
                    )}
                  </ConsoleTd>
                </tr>
              ))
            )}
          </ConsoleTable>
        </div>
      </ConsoleCard>

      {/* ---- The price book ---------------------------------------------- */}
      <div className="mt-5">
        <ConsoleCard
          title="Price book"
          subtitle="What each tier costs. Changing a price never restates an invoice already issued."
          action={
            <ConsoleButton onClick={() => setShowPlans((v) => !v)}>
              {showPlans ? 'Hide' : 'Show'}
            </ConsoleButton>
          }
        >
          {showPlans ? <PlanEditor plans={plans} onSaved={reload} /> : null}
        </ConsoleCard>
      </div>

      <RecordPaymentDialog
        invoice={paying}
        onClose={() => setPaying(null)}
        onRecorded={reload}
      />
    </>
  );
}

function Figure({
  label,
  value,
  hint,
  alarming,
}: {
  label: string;
  value: string;
  hint?: string;
  alarming?: boolean;
}) {
  return (
    <div>
      <p className="text-[0.75rem] tracking-[0.03em] uppercase" style={{ color: '#64748b' }}>
        {label}
      </p>
      <p
        className="mt-1 text-[1.125rem] font-semibold tabular-nums"
        style={{ color: alarming ? '#fbbf24' : '#f1f5f9' }}
      >
        {value}
      </p>
      {hint ? (
        <p className="text-[0.75rem]" style={{ color: '#64748b' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
