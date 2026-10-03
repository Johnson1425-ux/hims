'use client';

/**
 * Accounts-receivable ageing.
 *
 * FORM: the job is "compare magnitude across an ordered set of buckets", so a
 * horizontal bar chart. Horizontal because the category labels ("31–60 days")
 * are long, and vertical columns would force them to rotate.
 *
 * COLOUR: the buckets are an ORDERED scale (current → 90+), so this is an
 * ordinal ramp in a single hue, light to dark, not eight categorical colours.
 * The steps are the validated blue ramp: monotone lightness, 0.06 minimum
 * lightness gap between adjacent steps, and the lightest step clears 2:1
 * against the surface in both themes.
 *
 * MARKS: thin bars with 4px rounded data-ends anchored to the baseline, a 2px
 * surface gap between adjacent bars, and direct value labels — so identity and
 * magnitude never depend on colour alone, which is also the relief required
 * where a step sits below 3:1.
 */
import type { ReactNode } from 'react';
import { formatMoney } from '@/lib/format';

export interface AgeingDatum {
  bucket: string;
  label: string;
  totalCents: number;
  count: number;
}

const BUCKET_ORDER = ['current', '1-30', '31-60', '61-90', '90+'] as const;

const BUCKET_LABELS: Record<string, string> = {
  current: 'Not yet due',
  '1-30': '1–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '90+': 'Over 90 days',
};

/** Ordinal ramp: light = fresh debt, dark = aged. Magnitude of concern. */
const RAMP = ['var(--ramp-1)', 'var(--ramp-2)', 'var(--ramp-3)', 'var(--ramp-4)', 'var(--ramp-5)'];

export function AgeingBar({
  buckets,
  currency = 'USD',
}: {
  buckets: Record<string, { totalCents: number; count: number }>;
  currency?: string;
}): ReactNode {
  const data: AgeingDatum[] = BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: BUCKET_LABELS[bucket] ?? bucket,
    totalCents: buckets[bucket]?.totalCents ?? 0,
    count: buckets[bucket]?.count ?? 0,
  }));

  const max = Math.max(...data.map((d) => d.totalCents), 1);
  const total = data.reduce((sum, d) => sum + d.totalCents, 0);

  if (total === 0) {
    return (
      <p className="py-6 text-center text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
        Nothing outstanding.
      </p>
    );
  }

  return (
    <div>
      {/* A single-series chart needs no legend box: the title names it, and
          every bar is directly labelled. */}
      <ul className="flex flex-col gap-2.5">
        {data.map((datum, index) => {
          const widthPct = (datum.totalCents / max) * 100;
          const isAged = index >= 3;

          return (
            <li key={datum.bucket} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-3">
              <span className="text-[0.8125rem] whitespace-nowrap" style={{ color: 'var(--ink-secondary)' }}>
                {datum.label}
              </span>

              <div
                className="relative h-5 overflow-hidden rounded-[var(--radius-xs)]"
                style={{ background: 'var(--surface-sunken)' }}
                title={`${datum.label}: ${formatMoney(datum.totalCents, currency)} across ${datum.count} invoice(s)`}
              >
                <div
                  className="absolute inset-y-0 left-0 transition-[width] duration-500"
                  style={{
                    width: `${Math.max(widthPct, datum.totalCents > 0 ? 1.5 : 0)}%`,
                    background: RAMP[index],
                    // 4px rounded data-end, square against the baseline.
                    borderRadius: '2px 4px 4px 2px',
                  }}
                />
              </div>

              <span
                className="tabular text-right text-[0.8125rem] font-medium whitespace-nowrap"
                style={{ color: isAged ? 'var(--critical-ink)' : 'var(--ink)' }}
              >
                {formatMoney(datum.totalCents, currency)}
                <span className="ml-1.5 font-normal" style={{ color: 'var(--ink-muted)' }}>
                  ({datum.count})
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <div
        className="mt-3.5 flex items-baseline justify-between border-t pt-3"
        style={{ borderColor: 'var(--line)' }}
      >
        <span className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
          Total outstanding
        </span>
        <span className="tabular text-[0.9375rem] font-semibold" style={{ color: 'var(--ink)' }}>
          {formatMoney(total, currency)}
        </span>
      </div>
    </div>
  );
}
