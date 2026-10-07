/**
 * Shared zod helpers.
 *
 * Kept free of other imports so `config/env.ts` can use it without a cycle.
 */
import { z } from 'zod';

const TRUTHY = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSY = new Set(['false', '0', 'no', 'n', 'off', '']);

/**
 * A boolean that arrives as text — from an environment variable or a query
 * string — parsed by MEANING rather than by truthiness.
 *
 * `z.coerce.boolean()` is a trap here, and an expensive one: it is
 * `Boolean(value)`, so every non-empty string is true. `DATABASE_SSL=false`
 * turns SSL ON. `?overdueOnly=false` filters to overdue only — the exact
 * opposite of the request. Nothing warns, because the value is perfectly valid;
 * it just means the other thing.
 *
 * An unrecognised value is REJECTED rather than guessed at. `DATABASE_SSL=maybe`
 * should fail loudly at boot, not resolve to whichever default the author
 * happened to write.
 */
export function booleanish() {
  return z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;

    if (typeof value === 'string') {
      const normalised = value.trim().toLowerCase();
      if (TRUTHY.has(normalised)) return true;
      if (FALSY.has(normalised)) return false;
      // Fall through unchanged so z.boolean() reports it as invalid.
      return value;
    }

    return value;
  }, z.boolean());
}

/**
 * An IANA timezone name, canonicalised.
 *
 * `z.string().max(64)` was the previous guard, which accepted "banana" —
 * harmless-looking until a clinician opens the appointment board and every
 * `Intl.DateTimeFormat` call on it throws a RangeError. A timezone is not
 * free text: it is the key by which absolute instants become the times
 * printed on a clinic list, so a bad one breaks rendering rather than merely
 * looking wrong.
 *
 * Three things happen here, and the order matters:
 *
 *  1. ICU is asked whether it knows the zone. This is what rejects nonsense.
 *  2. The name is CANONICALISED. ICU is case-insensitive and resolves aliases,
 *     so `us/eastern` and `US/Eastern` both arrive as `America/New_York` and
 *     the column holds one spelling rather than three. That matters because
 *     the stored value is compared against the dropdown's options, and a
 *     mismatch would silently show the wrong zone as selected.
 *  3. FIXED-OFFSET FORMS ARE REFUSED. ICU happily accepts `+03:00`, which
 *     looks like a timezone and is not one: it never observes a daylight-saving
 *     transition, so an appointment booked across one lands an hour out. Only
 *     a region/zone name survives — plus `UTC`, which is deliberate rather
 *     than an accident of formatting.
 *
 * Deliberately NOT validated against `Intl.supportedValuesOf('timeZone')`:
 * that list is ICU-build-specific and disagrees with itself across runtimes
 * (Node 22 lists `Asia/Calcutta` and omits `UTC` entirely), so a browser
 * offering `Asia/Kolkata` would have its perfectly valid choice rejected by
 * the server.
 */
export function ianaTimezone() {
  return z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((value, ctx) => {
      let canonical: string;

      try {
        canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Not a recognised timezone. Use an IANA name such as Africa/Dar_es_Salaam.',
        });
        return z.NEVER;
      }

      if (canonical !== 'UTC' && !canonical.includes('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Use a named timezone such as Africa/Dar_es_Salaam rather than a fixed offset, so daylight-saving changes are observed.',
        });
        return z.NEVER;
      }

      return canonical;
    });
}
