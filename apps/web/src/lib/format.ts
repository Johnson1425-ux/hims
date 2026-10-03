/**
 * Formatting helpers.
 *
 * Centralised because a hospital system displays the same few kinds of value
 * on every screen, and they must read identically everywhere: a date shown as
 * "3 Oct" on one page and "10/03" on another is how a dose gets given on the
 * wrong day.
 */

/** Money arrives as integer minor units and must never pass through a float. */
export function formatMoney(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined) return '—';

  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatMoneyCompact(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined) return '—';

  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * A date of birth is rendered unambiguously — "11 Mar 1974", never 03/11/74.
 * Numeric formats are read differently either side of the Atlantic and this is
 * the field used to confirm patient identity.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

/** "in 3 days", "2 hours ago" — for recency, never for a clinical timestamp. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const deltaSeconds = (date.getTime() - Date.now()) / 1000;
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];

  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }

  return formatter.format(Math.round(deltaSeconds), 'second');
}

/** "52y", or "7m" / "18d" for infants, where months and days are what matter. */
export function formatAge(dateOfBirth: string, age: number): string {
  if (age >= 2) return `${age}y`;

  const dob = new Date(dateOfBirth);
  const months =
    (Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24 * 30.4375);

  if (months >= 1) return `${Math.floor(months)}m`;

  const days = Math.floor((Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24));
  return `${days}d`;
}

export function initials(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** snake_case or kebab-case into sentence case, for status strings from the API. */
export function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
