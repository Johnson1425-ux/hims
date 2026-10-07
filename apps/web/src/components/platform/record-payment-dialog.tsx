'use client';

/**
 * Recording a payment that arrived somewhere else.
 *
 * There is no payment provider here: the hospital pays by bank transfer or
 * mobile money, and an operator writes down that it landed. So the reference
 * field matters more than it looks — a CRDB transfer number or an M-Pesa
 * confirmation code is what someone reconciling a bank statement three months
 * from now will actually match on, and it is unrecoverable if not captured
 * when the payment is entered.
 *
 * The amount defaults to the full balance, because a payment in full is the
 * common case and retyping a figure already on screen is how a digit gets
 * dropped.
 */
import { useEffect, useState } from 'react';
import {
  ApiError,
  platformApi,
  type SubscriptionInvoiceRow,
} from '@/lib/platform-api';
import { formatMoney } from '@/lib/format';
import { ConsoleBadge, ConsoleButton } from './console-shell';

const METHODS = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'mobile_money', label: 'Mobile money' },
  { value: 'card', label: 'Card' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
];

const field = (invalid = false) => ({
  background: '#0b1220',
  color: '#e2e8f0',
  border: `1px solid ${invalid ? '#991b1b' : '#334155'}`,
});

export function RecordPaymentDialog({
  invoice,
  onClose,
  onRecorded,
}: {
  invoice: SubscriptionInvoiceRow | null;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detail, setDetail] = useState<SubscriptionInvoiceRow | null>(null);

  // Re-seeded on open, and the full history is fetched so the operator can
  // see what has already been recorded before adding to it.
  useEffect(() => {
    if (!invoice) return;

    setAmount(String(invoice.balance_cents));
    setMethod('bank_transfer');
    setReference('');
    setReceivedOn(new Date().toISOString().slice(0, 10));
    setNotes('');
    setErrors({});
    setMessage(null);
    setDetail(null);

    const controller = new AbortController();
    void (async () => {
      try {
        const { data } = await platformApi.get<SubscriptionInvoiceRow>(
          `/billing/invoices/${invoice.id}`,
          undefined,
          controller.signal,
        );
        setDetail(data);
      } catch {
        // The form still works without the history.
      }
    })();

    return () => controller.abort();
  }, [invoice]);

  if (!invoice) return null;

  const balance = Number(invoice.balance_cents);
  const parsed = Number(amount);
  const invalidAmount = !Number.isInteger(parsed) || parsed <= 0 || parsed > balance;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setErrors({});
    setMessage(null);

    try {
      await platformApi.post(`/billing/invoices/${invoice.id}/payments`, {
        amountCents: parsed,
        method,
        reference: reference.trim() || null,
        receivedOn: receivedOn || undefined,
        notes: notes.trim() || null,
      });
      onRecorded();
      onClose();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors(Object.fromEntries(caught.issues.map((i) => [i.field, i.message])));
        setMessage(caught.issues.length > 0 ? null : caught.message);
      } else {
        setMessage('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const voidPayment = async (paymentId: string) => {
    const reason = window.prompt('Why is this payment being voided?');
    if (!reason?.trim()) return;

    try {
      const { data } = await platformApi.post<SubscriptionInvoiceRow>(
        `/billing/payments/${paymentId}/void`,
        { reason: reason.trim() },
      );
      setDetail(data);
      onRecorded();
    } catch (caught) {
      setMessage(caught instanceof ApiError ? caught.message : 'That payment could not be voided.');
    }
  };

  const recorded = detail?.payments ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ background: 'rgba(2, 6, 23, 0.8)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Record a payment"
        className="w-full max-w-[36rem] rounded-[10px]"
        style={{ background: '#111827', border: '1px solid #1f2937' }}
      >
        <form onSubmit={submit}>
          <div className="px-6 pt-5 pb-3">
            <h2 className="text-[1.125rem] font-semibold" style={{ color: '#f1f5f9' }}>
              Record a payment
            </h2>
            <p className="mt-1 text-[0.8125rem]" style={{ color: '#64748b' }}>
              {invoice.invoice_number} · {invoice.tenant_name}
            </p>

            <div
              className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-[8px] px-3 py-2 text-[0.8125rem]"
              style={{ background: '#0b1220' }}
            >
              <span style={{ color: '#94a3b8' }}>
                Total{' '}
                <strong className="tabular-nums" style={{ color: '#e2e8f0' }}>
                  {formatMoney(Number(invoice.total_cents), invoice.currency)}
                </strong>
              </span>
              <span style={{ color: '#94a3b8' }}>
                Paid{' '}
                <strong className="tabular-nums" style={{ color: '#e2e8f0' }}>
                  {formatMoney(Number(invoice.amount_paid_cents), invoice.currency)}
                </strong>
              </span>
              <span style={{ color: '#94a3b8' }}>
                Outstanding{' '}
                <strong className="tabular-nums" style={{ color: '#fbbf24' }}>
                  {formatMoney(balance, invoice.currency)}
                </strong>
              </span>
              {invoice.is_overdue ? <ConsoleBadge value="overdue" /> : null}
            </div>
          </div>

          <div className="px-6 pb-3">
            {message ? (
              <div
                className="mb-4 rounded-[8px] px-3 py-2.5 text-[0.8125rem]"
                style={{ background: '#450a0a', color: '#fecaca' }}
              >
                {message}
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="amountCents" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                  Amount ({invoice.currency})
                </label>
                <input
                  id="amountCents"
                  inputMode="numeric"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ''))}
                  className="h-9 w-full rounded-[6px] px-3 text-[0.875rem] tabular-nums"
                  style={field(invalidAmount || Boolean(errors.amountCents))}
                />
                <p
                  className="mt-1 text-[0.75rem]"
                  style={{ color: errors.amountCents || invalidAmount ? '#fca5a5' : '#64748b' }}
                >
                  {errors.amountCents ??
                    (invalidAmount
                      ? `Between 1 and ${balance}.`
                      : `${formatMoney(parsed, invoice.currency)} — whole ${invoice.currency}, no decimal point`)}
                </p>
              </div>

              <div>
                <label htmlFor="method" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                  How it arrived
                </label>
                <select
                  id="method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                  className="h-9 w-full rounded-[6px] px-3 text-[0.875rem]"
                  style={field()}
                >
                  {METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="reference" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                  Reference
                </label>
                <input
                  id="reference"
                  value={reference}
                  placeholder="CRDB-99812 or QGH7X2P1LM"
                  onChange={(event) => setReference(event.target.value)}
                  className="h-9 w-full rounded-[6px] px-3 text-[0.875rem]"
                  style={field(Boolean(errors.reference))}
                />
                <p className="mt-1 text-[0.75rem]" style={{ color: '#64748b' }}>
                  The transfer number or confirmation code. This is what reconciliation is done on.
                </p>
              </div>

              <div>
                <label htmlFor="receivedOn" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                  Received on
                </label>
                <input
                  id="receivedOn"
                  type="date"
                  value={receivedOn}
                  onChange={(event) => setReceivedOn(event.target.value)}
                  className="h-9 w-full rounded-[6px] px-3 text-[0.875rem]"
                  style={field(Boolean(errors.receivedOn))}
                />
                <p className="mt-1 text-[0.75rem]" style={{ color: '#64748b' }}>
                  When the money landed, not when you are typing this.
                </p>
              </div>
            </div>

            <div className="mt-4">
              <label htmlFor="notes" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                Notes
              </label>
              <input
                id="notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className="h-9 w-full rounded-[6px] px-3 text-[0.875rem]"
                style={field()}
              />
            </div>

            {recorded.length > 0 ? (
              <div className="mt-5">
                <p className="mb-2 text-[0.75rem] tracking-[0.03em] uppercase" style={{ color: '#64748b' }}>
                  Already recorded
                </p>
                <ul className="flex flex-col gap-1.5">
                  {recorded.map((payment) => (
                    <li
                      key={payment.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[6px] px-3 py-2 text-[0.8125rem]"
                      style={{
                        background: '#0b1220',
                        color: payment.voided_at ? '#64748b' : '#cbd5e1',
                        textDecoration: payment.voided_at ? 'line-through' : undefined,
                      }}
                    >
                      <span className="tabular-nums">
                        {formatMoney(Number(payment.amount_cents), payment.currency)}
                      </span>
                      <span>{payment.received_on.slice(0, 10)}</span>
                      <span>{payment.method.replace(/_/g, ' ')}</span>
                      {payment.reference ? <span>· {payment.reference}</span> : null}
                      {payment.voided_at ? (
                        <span style={{ textDecoration: 'none' }}>— voided: {payment.void_reason}</span>
                      ) : (
                        <button
                          type="button"
                          className="ml-auto underline"
                          style={{ color: '#f87171' }}
                          onClick={() => void voidPayment(payment.id)}
                        >
                          Void
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div
            className="flex items-center justify-end gap-2 px-6 py-4"
            style={{ borderTop: '1px solid #1f2937' }}
          >
            <ConsoleButton onClick={onClose} disabled={submitting}>
              Cancel
            </ConsoleButton>
            <ConsoleButton type="submit" variant="primary" disabled={invalidAmount || submitting}>
              {submitting ? 'Recording…' : 'Record payment'}
            </ConsoleButton>
          </div>
        </form>
      </div>
    </div>
  );
}
