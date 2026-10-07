'use client';

/**
 * The price book.
 *
 * Editing in place rather than through a dialog, because the job is usually
 * "put standard up by ten percent across the board" and six dialogs is six
 * chances to change the wrong row.
 *
 * The note about issued invoices is not reassurance, it is the actual
 * behaviour: an invoice carries its own amount, copied at issue, so a price
 * change here only affects what is billed next. A customer comparing their
 * copy of an invoice against the system will always find them equal.
 */
import { useState } from 'react';
import { ApiError, platformApi, type PlanRow } from '@/lib/platform-api';
import { formatMoney } from '@/lib/format';
import { ConsoleButton, ConsoleTable, ConsoleTd, ConsoleTh } from './console-shell';

export function PlanEditor({ plans, onSaved }: { plans: PlanRow[]; onSaved: () => void }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const save = async (plan: PlanRow) => {
    const raw = edits[plan.id];
    if (raw === undefined) return;

    setSaving(plan.id);
    setMessage(null);

    try {
      await platformApi.patch(`/billing/plans/${plan.id}`, { amountCents: Number(raw) });
      setEdits((previous) => {
        const next = { ...previous };
        delete next[plan.id];
        return next;
      });
      onSaved();
    } catch (caught) {
      setMessage(
        caught instanceof ApiError
          ? (caught.issues[0]?.message ?? caught.message)
          : 'That price could not be saved.',
      );
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      {message ? (
        <div
          className="mb-3 rounded-[8px] px-3 py-2.5 text-[0.8125rem]"
          style={{ background: '#450a0a', color: '#fecaca' }}
        >
          {message}
        </div>
      ) : null}

      <ConsoleTable
        head={
          <>
            <ConsoleTh>Tier</ConsoleTh>
            <ConsoleTh>Currency</ConsoleTh>
            <ConsoleTh align="right">Price</ConsoleTh>
            <ConsoleTh>Per</ConsoleTh>
            <ConsoleTh align="right">Terms</ConsoleTh>
            <ConsoleTh align="right"></ConsoleTh>
          </>
        }
      >
        {plans.map((plan) => {
          const pending = edits[plan.id];
          const dirty = pending !== undefined && pending !== plan.amount_cents;
          const isTrial = plan.tier === 'trial';

          return (
            <tr key={plan.id}>
              <ConsoleTd>
                <span className="capitalize">{plan.tier}</span>
                {plan.description ? (
                  <div className="mt-0.5 max-w-[20rem] text-[0.75rem]" style={{ color: '#64748b' }}>
                    {plan.description}
                  </div>
                ) : null}
              </ConsoleTd>
              <ConsoleTd muted>{plan.currency}</ConsoleTd>
              <ConsoleTd align="right">
                {isTrial ? (
                  <span style={{ color: '#64748b' }}>Free</span>
                ) : (
                  <div className="flex flex-col items-end gap-1">
                    <input
                      aria-label={`${plan.tier} price in ${plan.currency}`}
                      inputMode="numeric"
                      value={pending ?? plan.amount_cents}
                      onChange={(event) =>
                        setEdits((previous) => ({
                          ...previous,
                          [plan.id]: event.target.value.replace(/[^0-9]/g, ''),
                        }))
                      }
                      className="h-8 w-32 rounded-[6px] px-2 text-right text-[0.875rem] tabular-nums"
                      style={{
                        background: '#0b1220',
                        color: '#e2e8f0',
                        border: `1px solid ${dirty ? '#f59e0b' : '#334155'}`,
                      }}
                    />
                    <span className="text-[0.75rem]" style={{ color: '#64748b' }}>
                      {formatMoney(Number(pending ?? plan.amount_cents), plan.currency)}
                    </span>
                  </div>
                )}
              </ConsoleTd>
              <ConsoleTd muted>{plan.billing_interval}</ConsoleTd>
              <ConsoleTd align="right" muted>
                {plan.payment_terms_days}d
              </ConsoleTd>
              <ConsoleTd align="right">
                {dirty ? (
                  <ConsoleButton
                    variant="primary"
                    disabled={saving === plan.id}
                    onClick={() => void save(plan)}
                  >
                    {saving === plan.id ? 'Saving…' : 'Save'}
                  </ConsoleButton>
                ) : null}
              </ConsoleTd>
            </tr>
          );
        })}
      </ConsoleTable>

      <p className="mt-3 text-[0.8125rem]" style={{ color: '#475569' }}>
        Prices are whole units of the currency shown — TZS has no subunit, USD is in cents.
        Changing one affects what is billed from the next run onwards and never an invoice
        already issued. A hospital on a negotiated rate ignores this table entirely; its rate is
        set on its own page.
      </p>
    </>
  );
}
