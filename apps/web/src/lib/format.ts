/**
 * Formatting helpers.
 *
 * Centralised because a hospital system displays the same few kinds of value
 * on every screen, and they must read identically everywhere: a date shown as
 * "3 Oct" on one page and "10/03" on another is how a dose gets given on the
 * wrong day.
 */

/* ---------------------------------------------------------------------------
 * Money
 *
 * Amounts are stored as integer MINOR UNITS — the `*_cents` columns — and must
 * never pass through a float on the way to a screen.
 *
 * How many minor units make a unit is a property of the currency, not a
 * constant 100. The Tanzanian shilling is quoted in whole shillings: the senti
 * is long obsolete, prices are written TSh 20,000, and ICU's own cash-rounding
 * data gives TZS zero fraction digits even though ISO 4217 still lists two. So
 * for TZS the minor unit IS the shilling and there is nothing to divide. Doing
 * it the other way — dividing by 100 and formatting with two decimals — would
 * put every amount in this system out by a factor of a hundred and print a
 * subunit no invoice in the country uses.
 *
 * The locale matters as much as the code: only an East African locale renders
 * TZS as "TSh". Elsewhere it comes out as the bare ISO code.
 * ------------------------------------------------------------------------- */

/**
 * Currencies quoted in whole units, so their minor unit IS the unit.
 *
 * All but the first are ISO 4217 exponent 0 — they have no subunit at all.
 * TZS is the deliberate exception: ISO still lists two decimals for it, but the
 * senti has been out of use for decades, prices are written TSh 20,000, and
 * ICU's cash-rounding data gives it zero fraction digits. The Kenyan shilling
 * is NOT in this list, because its cents are still quoted.
 */
const WHOLE_UNIT_CURRENCIES = new Set([
  'TZS',
  'UGX', 'RWF', 'BIF', 'DJF', 'GNF', 'KMF', 'XAF', 'XOF', 'XPF',
  'CLP', 'ISK', 'JPY', 'KRW', 'PYG', 'VND', 'VUV',
]);

interface MoneyFormat {
  currency: string;
  locale: string;
}

/**
 * The default, overridden once per session from the tenant's own settings —
 * the hospital record carries `currency` and `locale`, and a multi-tenant
 * system has no business hard-coding either.
 */
let moneyFormat: MoneyFormat = { currency: 'TZS', locale: 'en-TZ' };

export function setMoneyFormat(format: Partial<MoneyFormat>): void {
  moneyFormat = {
    currency: format.currency?.toUpperCase() || moneyFormat.currency,
    locale: format.locale || moneyFormat.locale,
  };
}

export function getMoneyFormat(): MoneyFormat {
  return moneyFormat;
}

/** Minor units per unit: 1 for a whole-unit currency, 100 otherwise. */
function minorUnitsPer(currency: string): number {
  return WHOLE_UNIT_CURRENCIES.has(currency) ? 1 : 100;
}

function fractionDigits(currency: string): number {
  return WHOLE_UNIT_CURRENCIES.has(currency) ? 0 : 2;
}

export function formatMoney(
  minorUnits: number | null | undefined,
  currency = moneyFormat.currency,
): string {
  if (minorUnits === null || minorUnits === undefined) return '—';

  const digits = fractionDigits(currency);

  return new Intl.NumberFormat(moneyFormat.locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minorUnits / minorUnitsPer(currency));
}

export function formatMoneyCompact(
  minorUnits: number | null | undefined,
  currency = moneyFormat.currency,
): string {
  if (minorUnits === null || minorUnits === undefined) return '—';

  return new Intl.NumberFormat(moneyFormat.locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(minorUnits / minorUnitsPer(currency));
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
