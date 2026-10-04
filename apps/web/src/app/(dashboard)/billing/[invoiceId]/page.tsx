'use client';

/**
 * One invoice.
 *
 * The two things anyone opens an invoice to do are take money and raise a
 * claim, so both are here rather than behind a menu.
 *
 * PAYMENTS ARE ALLOCATED, not merely recorded. A payment that exists but is
 * allocated to nothing leaves the invoice looking unpaid, which is how a
 * patient who has already paid gets chased. The server allocates on write and
 * refuses to allocate more than the balance — over-allocation would drive a
 * balance negative while the invoice reported itself paid.
 *
 * Line prices are what was SNAPSHOTTED at billing time, not a live lookup.
 * An issued invoice must not change because someone edited the price list
 * next month.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
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
  Table,
  Td,
  Th,
  Tr,
  type Tone,
} from '@/components/ui/primitives';
import { Field, FormDialog, Select, TextArea, useFormErrors } from '@/components/ui/forms';
import { useSession } from '@/lib/session';
import { api, ApiError, type InvoiceDetail } from '@/lib/api';
import { formatDate, formatMoney, formatNumber, formatRelative, humanise, pluralise } from '@/lib/format';
import { IconReceipt } from '@/components/layout/icons';

const STATUS_TONE: Record<string, Tone> = {
  draft: 'neutral',
  issued: 'info',
  partially_paid: 'warning',
  paid: 'good',
  overdue: 'critical',
  void: 'neutral',
  written_off: 'neutral',
};

const CLAIM_TONE: Record<string, Tone> = {
  draft: 'neutral',
  ready: 'neutral',
  submitted: 'info',
  acknowledged: 'info',
  in_review: 'info',
  approved: 'good',
  partially_approved: 'warning',
  paid: 'good',
  denied: 'critical',
  appealed: 'serious',
  closed: 'neutral',
  void: 'neutral',
};

export default function InvoicePage() {
  const params = useParams<{ invoiceId: string }>();
  const invoiceId = params.invoiceId;
  const { can } = useSession();

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);

  const [paying, setPaying] = useState(false);
  const [payment, setPayment] = useState({ amount: '', method: 'mobile_money', reference: '', notes: '' });
  const [claiming, setClaiming] = useState(false);
  const [policyId, setPolicyId] = useState('');
  const [priorAuth, setPriorAuth] = useState('');

  const payForm = useFormErrors();
  const claimForm = useFormErrors();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);

      try {
        const { data } = await api.get<InvoiceDetail>(`/billing/invoices/${invoiceId}`, undefined, signal);
        setInvoice(data);
        setPayment((p) => ({ ...p, amount: String(data.balance_cents) }));
        if (data.policies.length > 0) setPolicyId((current) => current || data.policies[0]!.id);
      } catch (caught) {
        if (caught instanceof ApiError) setLoadError(caught.message);
      } finally {
        setLoading(false);
      }
    },
    [invoiceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function recordPayment(): Promise<void> {
    payForm.reset();

    try {
      const { data } = await api.post<{ receiptNumber?: string }>('/billing/payments', {
        invoiceId,
        amountCents: Number(payment.amount),
        method: payment.method,
        payerKind: payment.method === 'insurance_remittance' ? 'insurance' : 'patient',
        gatewayReference: payment.reference || undefined,
        notes: payment.notes || undefined,
      });

      setPaying(false);
      setNotice({
        tone: 'good',
        text: `Payment recorded${data?.receiptNumber ? ` — receipt ${data.receiptNumber}` : ''}.`,
      });
      setPayment({ amount: '', method: 'mobile_money', reference: '', notes: '' });
      await load();
    } catch (caught) {
      payForm.capture(caught);
    }
  }

  async function submitClaim(): Promise<void> {
    claimForm.reset();

    try {
      const { data } = await api.post<{ claimNumber?: string }>('/billing/claims', {
        invoiceId,
        policyId,
        priorAuthNumber: priorAuth || undefined,
      });

      setClaiming(false);
      setNotice({
        tone: 'good',
        text: `Claim built and validated${data?.claimNumber ? ` — ${data.claimNumber}` : ''}.`,
      });
      setPriorAuth('');
      await load();
    } catch (caught) {
      claimForm.capture(caught);
    }
  }

  if (loading && !invoice) {
    return (
      <>
        <PageHeader title="Invoice" breadcrumbs={[{ label: 'Billing', href: '/billing' }]} />
        <Skeleton height={320} />
      </>
    );
  }

  if (loadError || !invoice) {
    return (
      <>
        <PageHeader title="Invoice" breadcrumbs={[{ label: 'Billing', href: '/billing' }]} />
        <Card>
          <Alert tone="critical" title="This invoice could not be opened">
            {loadError ?? 'It may have been voided.'}
          </Alert>
        </Card>
      </>
    );
  }

  const settled = invoice.balance_cents === 0;

  return (
    <>
      <PageHeader
        title={invoice.invoice_number}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/patients/${invoice.patient_id}`} style={{ color: 'var(--accent)' }}>
              {invoice.patient_name}
            </Link>
            <span className="tabular">{invoice.mrn}</span>
            <span aria-hidden="true">·</span>
            <span>Issued {formatDate(invoice.issued_on)}</span>
            <Badge tone={STATUS_TONE[invoice.status] ?? 'neutral'}>{humanise(invoice.status)}</Badge>
            <Badge tone="neutral" dot>
              {humanise(invoice.billing_stage)}
            </Badge>
          </span>
        }
        breadcrumbs={[{ label: 'Billing', href: '/billing' }, { label: invoice.invoice_number }]}
        actions={
          <>
            {can('payment:write') && !settled ? (
              <Button
                variant="primary"
                onClick={() => {
                  setPayment((p) => ({ ...p, amount: String(invoice.balance_cents) }));
                  payForm.reset();
                  setPaying(true);
                }}
              >
                Record a payment
              </Button>
            ) : null}
            {can('claim:write') && invoice.policies.length > 0 ? (
              <Button
                variant="secondary"
                onClick={() => {
                  claimForm.reset();
                  setClaiming(true);
                }}
              >
                Raise a claim
              </Button>
            ) : null}
          </>
        }
      />

      {notice ? (
        <div className="mb-5">
          <Alert tone={notice.tone} title={notice.tone === 'good' ? 'Done' : 'Not done'}>
            {notice.text}
          </Alert>
        </div>
      ) : null}

      {invoice.days_overdue > 0 && !settled ? (
        <div className="mb-5">
          <Alert tone="critical" title={`${pluralise(invoice.days_overdue, 'day')} overdue`}>
            Due {formatDate(invoice.due_on)}. {formatMoney(invoice.balance_cents)} outstanding.
          </Alert>
        </div>
      ) : null}

      <section aria-label="Invoice totals" className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total" value={formatMoney(invoice.total_cents)} emphasis />
        <StatTile label="Paid" value={formatMoney(invoice.amount_paid_cents)} tone="good" />
        <StatTile
          label="Outstanding"
          value={formatMoney(invoice.balance_cents)}
          tone={settled ? 'good' : invoice.days_overdue > 0 ? 'critical' : 'warning'}
        />
        <StatTile
          label="Due"
          value={invoice.due_on ? formatDate(invoice.due_on) : '—'}
          hint={settled ? 'Settled in full' : undefined}
        />
      </section>

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-5">
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title="Lines"
                subtitle="Prices as snapshotted when the invoice was raised, not a live catalogue lookup"
              />
            </div>
            <div className="px-5 pb-1">
              <Table>
                <thead>
                  <tr>
                    <Th>Description</Th>
                    <Th>Code</Th>
                    <Th align="right">Qty</Th>
                    <Th align="right">Unit</Th>
                    <Th align="right">Discount</Th>
                    <Th align="right">Net</Th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lines.map((line) => (
                    <Tr key={line.id}>
                      <Td>
                        <span className="block" style={{ color: 'var(--ink)' }}>
                          {line.description}
                        </span>
                        {line.category ? (
                          <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                            {humanise(line.category)}
                          </span>
                        ) : null}
                      </Td>
                      <Td className="tabular" style={{ color: 'var(--ink-muted)' }}>
                        {line.cpt_code ?? '—'}
                      </Td>
                      <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                        {formatNumber(Number(line.quantity), 0)}
                      </Td>
                      <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                        {formatMoney(line.unit_price_cents)}
                      </Td>
                      <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                        {line.discount_cents > 0 ? `−${formatMoney(line.discount_cents)}` : '—'}
                      </Td>
                      <Td numeric align="right" className="font-medium">
                        {formatMoney(line.net_cents)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>

            <dl
              className="flex flex-col gap-1.5 p-5 text-[0.875rem]"
              style={{ borderTop: '1px solid var(--line)' }}
            >
              {[
                ['Subtotal', invoice.subtotal_cents],
                ['Discount', -invoice.discount_cents],
                ['Tax', invoice.tax_cents],
              ].map(([label, value]) => (
                <div key={label as string} className="flex justify-between gap-3">
                  <dt style={{ color: 'var(--ink-muted)' }}>{label}</dt>
                  <dd className="tabular" style={{ color: 'var(--ink)' }}>
                    {formatMoney(value as number)}
                  </dd>
                </div>
              ))}
              <div
                className="mt-1.5 flex justify-between gap-3 pt-1.5"
                style={{ borderTop: '1px solid var(--line)' }}
              >
                <dt className="font-semibold" style={{ color: 'var(--ink)' }}>
                  Total
                </dt>
                <dd className="tabular font-semibold" style={{ color: 'var(--ink)' }}>
                  {formatMoney(invoice.total_cents)}
                </dd>
              </div>
            </dl>
          </Card>

          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader title="Payments" subtitle="Allocated against this invoice" />
            </div>
            {invoice.payments.length === 0 ? (
              <EmptyState icon={<IconReceipt />} title="Nothing received yet" />
            ) : (
              <div className="px-5 pb-1">
                <Table>
                  <thead>
                    <tr>
                      <Th>Receipt</Th>
                      <Th>Method</Th>
                      <Th>From</Th>
                      <Th align="right">Allocated</Th>
                      <Th align="right">When</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.payments.map((received) => (
                      <Tr key={received.id}>
                        <Td className="tabular" style={{ color: 'var(--ink)' }}>
                          {received.receipt_number}
                        </Td>
                        <Td>{humanise(received.method)}</Td>
                        <Td style={{ color: 'var(--ink-muted)' }}>{humanise(received.payer_kind)}</Td>
                        <Td numeric align="right" className="font-medium">
                          {formatMoney(received.allocated_cents)}
                        </Td>
                        <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                          {formatRelative(received.received_at)}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader title="Claims" subtitle="Built and validated before transmission" />
            </div>
            {invoice.claims.length === 0 ? (
              <EmptyState
                icon={<IconReceipt />}
                title="No claim raised"
                description={
                  invoice.policies.length === 0
                    ? 'This patient has no active policy on file.'
                    : 'Raise one against the policy below.'
                }
              />
            ) : (
              <ul className="flex flex-col">
                {invoice.claims.map((claim) => (
                  <li key={claim.id} className="px-5 py-3" style={{ borderTop: '1px solid var(--line)' }}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="tabular text-[0.875rem] font-medium" style={{ color: 'var(--ink)' }}>
                        {claim.claim_number}
                      </span>
                      <Badge tone={CLAIM_TONE[claim.status] ?? 'neutral'}>{humanise(claim.status)}</Badge>
                    </div>
                    <p className="mt-1 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                      {claim.payer_name ?? 'Unknown payer'} · claimed {formatMoney(claim.claimed_cents)}
                      {claim.paid_cents ? ` · paid ${formatMoney(claim.paid_cents)}` : ''}
                    </p>
                    {claim.denial_codes && claim.denial_codes.length > 0 ? (
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {claim.denial_codes.map((denial) => (
                          <li key={denial.code} className="text-[0.75rem]" style={{ color: 'var(--critical-ink)' }}>
                            {denial.code} — {denial.description}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Cover" subtitle="Active policies, in order of precedence" />
            {invoice.policies.length === 0 ? (
              <p className="text-[0.875rem]" style={{ color: 'var(--ink-muted)' }}>
                None on file — this invoice is the patient's own responsibility.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {invoice.policies.map((policy) => (
                  <li
                    key={policy.id}
                    className="rounded-[var(--radius-md)] p-3"
                    style={{ background: 'var(--surface-sunken)' }}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[0.875rem] font-medium" style={{ color: 'var(--ink)' }}>
                        {policy.payer_name}
                      </span>
                      <Badge tone={policy.verification_status === 'active' ? 'good' : 'warning'}>
                        {humanise(policy.verification_status)}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                      {policy.plan_name ?? 'Plan not named'}
                      {policy.member_number_last4 ? ` · ••••${policy.member_number_last4}` : ''}
                      {policy.copay_cents ? ` · copay ${formatMoney(policy.copay_cents)}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <FormDialog
        open={paying}
        onClose={() => setPaying(false)}
        title="Record a payment"
        description={`${invoice.invoice_number} · ${formatMoney(invoice.balance_cents)} outstanding`}
        submitLabel="Record it"
        message={payForm.message}
        disabled={!payment.amount || Number(payment.amount) <= 0}
        onSubmit={recordPayment}
      >
        <Field
          name="amountCents"
          label="Amount"
          type="number"
          min={1}
          required
          hint="Whole shillings. More than the balance is refused — an over-allocation drives it negative."
          value={payment.amount}
          error={payForm.errors.amountCents}
          onChange={(event) => setPayment((p) => ({ ...p, amount: event.target.value }))}
        />
        <Select
          name="method"
          label="How was it paid"
          options={[
            { value: 'mobile_money', label: 'Mobile money' },
            { value: 'cash', label: 'Cash' },
            { value: 'card', label: 'Card' },
            { value: 'bank_transfer', label: 'Bank transfer' },
            { value: 'cheque', label: 'Cheque' },
            { value: 'insurance_remittance', label: 'Insurance remittance' },
            { value: 'credit_note', label: 'Credit note' },
            { value: 'writeoff', label: 'Write-off' },
          ]}
          value={payment.method}
          error={payForm.errors.method}
          onChange={(event) => setPayment((p) => ({ ...p, method: event.target.value }))}
        />
        <Field
          name="gatewayReference"
          label="Reference"
          hint="Transaction id from the gateway or the till. No card number is ever stored."
          value={payment.reference}
          error={payForm.errors.gatewayReference}
          onChange={(event) => setPayment((p) => ({ ...p, reference: event.target.value }))}
        />
        <TextArea
          name="paymentNotes"
          label="Notes"
          rows={2}
          value={payment.notes}
          error={payForm.errors.notes}
          onChange={(event) => setPayment((p) => ({ ...p, notes: event.target.value }))}
        />
      </FormDialog>

      <FormDialog
        open={claiming}
        onClose={() => setClaiming(false)}
        title="Raise a claim"
        description="Built from the invoice lines and validated before it can be transmitted"
        submitLabel="Build the claim"
        message={claimForm.message}
        disabled={!policyId}
        onSubmit={submitClaim}
      >
        <Select
          name="policyId"
          label="Against which policy"
          required
          options={invoice.policies.map((policy) => ({
            value: policy.id,
            label: `${policy.payer_name} · ${policy.plan_name ?? 'plan not named'}${
              policy.precedence === 1 ? ' (primary)' : ''
            }`,
          }))}
          value={policyId}
          error={claimForm.errors.policyId}
          onChange={(event) => setPolicyId(event.target.value)}
        />
        <Field
          name="priorAuthNumber"
          label="Prior authorisation number"
          hint="The commonest denial reason in the revenue report is a missing pre-authorisation."
          value={priorAuth}
          error={claimForm.errors.priorAuthNumber}
          onChange={(event) => setPriorAuth(event.target.value)}
        />
        <Alert tone="info" title="Built, not transmitted">
          The claim is assembled in X12 837 shape and validated here. Sending it to a clearinghouse
          is an integration this system names as out of scope rather than pretending to do.
        </Alert>
      </FormDialog>
    </>
  );
}
