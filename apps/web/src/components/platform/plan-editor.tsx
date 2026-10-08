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
import { Alert, Button, Table, Td, Th, Tr } from '@/components/ui/primitives';

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
        <div className="mb-3">
          <Alert tone="critical">{message}</Alert>
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>Tier</Th>
            <Th>Currency</Th>
            <Th align="right">Price</Th>
            <Th>Per</Th>
            <Th align="right">Terms</Th>
            <Th align="right" width="7rem" />
          </tr>
        </thead>
        <tbody>
          {plans.map((plan) => {
            const pending = edits[plan.id];
            const dirty = pending !== undefined && pending !== plan.amount_cents;
            const isTrial = plan.tier === 'trial';

            return (
              <Tr key={plan.id}>
                <Td>
                  <span className="font-medium capitalize">{plan.tier}</span>
                  {plan.description ? (
                    <div
                      className="mt-0.5 max-w-[20rem] text-[0.75rem]"
                      style={{ color: 'var(--ink-muted)' }}
                    >
                      {plan.description}
                    </div>
                  ) : null}
                </Td>
                <Td style={{ color: 'var(--ink-secondary)' }}>{plan.currency}</Td>
                <Td align="right">
                  {isTrial ? (
                    <span style={{ color: 'var(--ink-muted)' }}>Free</span>
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
                        className="tabular h-8 w-32 rounded-[var(--radius-md)] px-2 text-right text-[0.875rem]"
                        style={{
                          background: 'var(--surface)',
                          color: 'var(--ink)',
                          // The dirty border is the only cue that a row has
                          // an unsaved edit, so it uses the accent rather
                          // than a weight change that reflows the column.
                          border: `1px solid ${dirty ? 'var(--accent)' : 'var(--line-strong)'}`,
                        }}
                      />
                      <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                        {formatMoney(Number(pending ?? plan.amount_cents), plan.currency)}
                      </span>
                    </div>
                  )}
                </Td>
                <Td style={{ color: 'var(--ink-secondary)' }}>{plan.billing_interval}</Td>
                <Td align="right" numeric style={{ color: 'var(--ink-secondary)' }}>
                  {plan.payment_terms_days}d
                </Td>
                <Td align="right">
                  {dirty ? (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={saving === plan.id}
                      onClick={() => void save(plan)}
                    >
                      Save
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>

      <p className="mt-3 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
        Prices are whole units of the currency shown — TZS has no subunit, USD is in cents.
        Changing one affects what is billed from the next run onwards and never an invoice
        already issued. A hospital on a negotiated rate ignores this table entirely; its rate is
        set on its own page.
      </p>
    </>
  );
}
