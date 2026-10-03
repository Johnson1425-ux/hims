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
