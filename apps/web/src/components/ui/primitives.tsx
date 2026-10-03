'use client';

/**
 * UI primitives.
 *
 * Deliberately a small, hand-written set rather than a component library: a
 * clinical interface needs a handful of pieces used consistently, and every
 * one of them has to carry the status-plus-icon-plus-label rule. Pulling in a
 * general-purpose kit would mean fighting its defaults on exactly those points.
 *
 * All colour references go through the semantic tokens in globals.css, so the
 * two themes swap in one place.
 */
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ===========================================================================
 * Card
 * ======================================================================== */

export function Card({
  children,
  className,
  padded = true,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }): ReactNode {
  return (
    <div
      className={cx('card rounded-[var(--radius-lg)] fade-in', padded && 'p-5', className)}
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--line)',
        boxShadow: 'var(--shadow-sm)',
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-[0.9375rem] font-semibold tracking-[-0.01em]" style={{ color: 'var(--ink)' }}>
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-0.5 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
            {subtitle}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/* ===========================================================================
 * Button
 * ======================================================================== */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[0.8125rem] gap-1.5',
  md: 'h-9.5 px-4 text-[0.875rem] gap-2',
  lg: 'h-11 px-5 text-[0.9375rem] gap-2',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
    icon?: ReactNode;
  }
>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest },
  ref,
) {
  const styles: Record<ButtonVariant, React.CSSProperties> = {
    primary: {
      background: 'var(--accent)',
      color: 'var(--ink-on-brand)',
      border: '1px solid transparent',
    },
    secondary: {
      background: 'var(--surface)',
      color: 'var(--ink)',
      border: '1px solid var(--line-strong)',
    },
    ghost: { background: 'transparent', color: 'var(--ink-secondary)', border: '1px solid transparent' },
    danger: {
      background: 'var(--critical)',
      color: '#ffffff',
      border: '1px solid transparent',
    },
  };

  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center rounded-[var(--radius-md)] font-medium',
        'transition-[background-color,border-color,opacity] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-55',
        'hover:not-disabled:brightness-[0.97] active:not-disabled:brightness-[0.94]',
        BUTTON_SIZES[size],
        className,
      )}
      style={styles[variant]}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

function Spinner(): ReactNode {
  return (
    <svg
      className="animate-spin"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ===========================================================================
 * Status badge
 *
 * A status never relies on colour alone: every tone ships with a glyph and a
 * text label, which is both the accessibility requirement and the mitigation
 * for `warning` and `serious` sitting below 3:1 on the light surface.
 * ======================================================================== */

export type Tone = 'neutral' | 'info' | 'good' | 'warning' | 'serious' | 'critical';

const TONE_TOKENS: Record<Tone, { bg: string; fg: string; glyph: string; label: string }> = {
  neutral: { bg: 'var(--surface-sunken)', fg: 'var(--ink-secondary)', glyph: '•', label: 'Status' },
  info: { bg: 'var(--info-soft)', fg: 'var(--info-ink)', glyph: 'i', label: 'Information' },
  good: { bg: 'var(--good-soft)', fg: 'var(--good-ink)', glyph: '✓', label: 'Good' },
  warning: { bg: 'var(--warning-soft)', fg: 'var(--warning-ink)', glyph: '!', label: 'Warning' },
  serious: { bg: 'var(--serious-soft)', fg: 'var(--serious-ink)', glyph: '!', label: 'Serious' },
  critical: { bg: 'var(--critical-soft)', fg: 'var(--critical-ink)', glyph: '!', label: 'Critical' },
};

export function Badge({
  tone = 'neutral',
  children,
  dot,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  /** Replace the glyph with a plain dot, for low-stakes labels like a modality. */
  dot?: boolean;
  className?: string;
}): ReactNode {
  const token = TONE_TOKENS[tone];

  return (
    <span
      className={cx(
        'badge inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-0.5',
        'text-[0.75rem] font-medium whitespace-nowrap',
        className,
      )}
      style={{ background: token.bg, color: token.fg }}
    >
      <span aria-hidden="true" className="text-[0.6875rem] leading-none font-bold">
        {dot ? '•' : token.glyph}
      </span>
      {children}
    </span>
  );
}

/* ===========================================================================
 * Stat tile
 *
 * The right form for "a single current value, maybe with a trend". A KPI row
 * of these beats a grouped bar chart of unrelated measures, which is the most
 * common dashboard mistake.
 * ======================================================================== */

export function StatTile({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
  href,
  emphasis = false,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: Tone;
  href?: string;
  /** Lifts the headline figure for the one number a screen leads with. */
  emphasis?: boolean;
}): ReactNode {
  const token = TONE_TOKENS[tone];
  const interactive = Boolean(href);

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="text-[0.75rem] font-medium tracking-[0.02em] uppercase"
          style={{ color: 'var(--ink-muted)' }}
        >
          {label}
        </span>
        {tone !== 'neutral' ? (
          <span
            aria-hidden="true"
            className="flex h-4 w-4 items-center justify-center rounded-full text-[0.625rem] font-bold"
            style={{ background: token.bg, color: token.fg }}
          >
            {token.glyph}
          </span>
        ) : null}
      </div>

      <div
        className={cx('mt-2 font-semibold tracking-[-0.02em]', emphasis ? 'text-[2.5rem] leading-none' : 'text-[1.75rem] leading-none')}
        style={{ color: tone === 'neutral' ? 'var(--ink)' : token.fg }}
      >
        {value}
        {unit ? (
          <span className="ml-1 text-[0.875rem] font-normal" style={{ color: 'var(--ink-muted)' }}>
            {unit}
          </span>
        ) : null}
      </div>

      {hint ? (
        <div className="mt-1.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
          {hint}
        </div>
      ) : null}
    </>
  );

  const shared = {
    className: cx(
      'stat-tile block rounded-[var(--radius-lg)] p-4 text-left',
      interactive && 'transition-colors duration-150 hover:brightness-[0.99]',
    ),
    style: {
      background: 'var(--surface-raised)',
      border: '1px solid var(--line)',
      boxShadow: 'var(--shadow-sm)',
    } as React.CSSProperties,
  };

  return interactive ? (
    <a href={href} {...shared}>
      {body}
    </a>
  ) : (
    <div {...shared}>{body}</div>
  );
}

/* ===========================================================================
 * Meter
 *
 * The right form for "a single ratio against a limit" — stock on hand against
 * its reorder level. A same-hue track, not a two-slice pie.
 * ======================================================================== */

export function Meter({
  value,
  max,
  threshold,
  tone = 'info',
  label,
  compact = false,
}: {
  value: number;
  max: number;
  /** Marked on the track, so "where the line is" is visible, not inferred. */
  threshold?: number;
  tone?: Tone;
  label?: string;
  compact?: boolean;
}): ReactNode {
  const safeMax = max > 0 ? max : 1;
  const pct = Math.max(0, Math.min(100, (value / safeMax) * 100));
  const thresholdPct =
    threshold !== undefined ? Math.max(0, Math.min(100, (threshold / safeMax) * 100)) : null;

  const fill: Record<Tone, string> = {
    neutral: 'var(--ink-muted)',
    info: 'var(--ramp-3)',
    good: 'var(--good)',
    warning: 'var(--warning)',
    serious: 'var(--serious)',
    critical: 'var(--critical)',
  };

  return (
    <div
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-label={label ?? 'Level'}
      className="w-full"
    >
      <div
        className="relative w-full overflow-hidden rounded-full"
        style={{ height: compact ? 4 : 6, background: 'var(--surface-sunken)' }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, background: fill[tone] }}
        />
        {thresholdPct !== null ? (
          <div
            aria-hidden="true"
            className="absolute inset-y-0"
            style={{
              left: `${thresholdPct}%`,
              width: 2,
              background: 'var(--ink-muted)',
              opacity: 0.55,
            }}
            title={`Reorder level: ${threshold}`}
          />
        ) : null}
      </div>
    </div>
  );
}

/* ===========================================================================
 * Table
 *
 * Plain semantic markup. A clinical table is read by screen readers and
 * printed, so it stays a real <table> rather than a grid of divs.
 * ======================================================================== */

export function Table({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className={cx('w-full border-collapse text-[0.875rem]', className)}>{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
  width,
}: {
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
}): ReactNode {
  return (
    <th
      scope="col"
      style={{
        textAlign: align,
        width,
        color: 'var(--ink-muted)',
        borderBottom: '1px solid var(--line)',
      }}
      className="px-3 py-2 text-[0.75rem] font-medium tracking-[0.02em] uppercase whitespace-nowrap"
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
  numeric = false,
  style,
}: {
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** `numeric` applies tabular figures, so columns of numbers line up. */
  numeric?: boolean;
  style?: React.CSSProperties;
}): ReactNode {
  return (
    <td
      style={{ textAlign: align, borderBottom: '1px solid var(--line)', ...style }}
      className={cx('px-3 py-2.5 align-middle', numeric && 'tabular', className)}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  href,
  className,
}: {
  children: ReactNode;
  href?: string;
  className?: string;
}): ReactNode {
  return (
    <tr
      className={cx(
        'transition-colors duration-100',
        href && 'cursor-pointer hover:[background:var(--surface-hover)]',
        className,
      )}
      onClick={href ? () => (window.location.href = href) : undefined}
    >
      {children}
    </tr>
  );
}

/* ===========================================================================
 * Input
 * ======================================================================== */

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: string; hint?: string; leading?: ReactNode }
>(function Input({ label, error, hint, leading, className, id, ...rest }, ref) {
  const inputId = id ?? rest.name ?? undefined;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="w-full">
      {label ? (
        <label
          htmlFor={inputId}
          className="mb-1.5 block text-[0.8125rem] font-medium"
          style={{ color: 'var(--ink-secondary)' }}
        >
          {label}
        </label>
      ) : null}

      <div className="relative">
        {leading ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
            style={{ color: 'var(--ink-muted)' }}
          >
            {leading}
          </span>
        ) : null}

        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx(
            'h-9.5 w-full rounded-[var(--radius-md)] px-3 text-[0.875rem]',
            'transition-[border-color,box-shadow] duration-150',
            'placeholder:[color:var(--ink-muted)]',
            Boolean(leading) && 'pl-9',
            className,
          )}
          style={{
            background: 'var(--surface)',
            color: 'var(--ink)',
            border: `1px solid ${error ? 'var(--critical)' : 'var(--line-strong)'}`,
          }}
          {...rest}
        />
      </div>

      {error ? (
        <p id={`${inputId}-error`} role="alert" className="mt-1.5 text-[0.75rem]" style={{ color: 'var(--critical-ink)' }}>
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
});

/* ===========================================================================
 * Feedback
 * ======================================================================== */

export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  const token = TONE_TOKENS[tone];

  return (
    <div
      role={tone === 'critical' || tone === 'serious' ? 'alert' : 'status'}
      className="flex items-start gap-3 rounded-[var(--radius-md)] p-3.5"
      style={{ background: token.bg, color: token.fg, border: `1px solid ${token.fg}22` }}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.75rem] font-bold"
        style={{ background: `${token.fg}1f` }}
      >
        {token.glyph}
      </span>

      <div className="min-w-0 flex-1 text-[0.875rem]">
        {title ? <div className="font-semibold">{title}</div> : null}
        {children ? <div className={title ? 'mt-0.5 opacity-90' : 'opacity-90'}>{children}</div> : null}
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon ? (
        <div
          aria-hidden="true"
          className="mb-3 flex h-11 w-11 items-center justify-center rounded-full"
          style={{ background: 'var(--surface-sunken)', color: 'var(--ink-muted)' }}
        >
          {icon}
        </div>
      ) : null}
      <p className="text-[0.9375rem] font-medium" style={{ color: 'var(--ink)' }}>
        {title}
      </p>
      {description ? (
        <p className="mt-1 max-w-sm text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className, height = 16 }: { className?: string; height?: number }): ReactNode {
  return <div className={cx('skeleton', className)} style={{ height }} aria-hidden="true" />;
}

export function Avatar({
  name,
  size = 32,
  tone,
}: {
  name: string;
  size?: number;
  tone?: string;
}): ReactNode {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: tone ?? 'var(--accent-soft)',
        color: 'var(--info-ink)',
      }}
    >
      {letters}
    </span>
  );
}

export { cx };
