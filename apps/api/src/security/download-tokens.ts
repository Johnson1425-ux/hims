/**
 * Signed, expiring links for a document that has to open from an email.
 *
 * THE PROBLEM THIS SOLVES. The API authenticates with a bearer token the SPA
 * holds in memory. A hospital administrator clicking a link in their mail
 * client has no bearer token and no cookie for the API origin, so an
 * ordinary authenticated route would simply 401 — and the invoice would be
 * undeliverable by the one channel it most needs to arrive on.
 *
 * So the link carries its own authority: an HMAC over the invoice id, the
 * tenant and an expiry. Anyone holding the URL can fetch that one document
 * until it expires, which is the same property a bank's statement link has,
 * and the same risk: THE URL IS THE CREDENTIAL. That is acceptable here and
 * would not be for a chart. What is behind it is one invoice — a company
 * name, a period and an amount — with no patient data of any kind, and the
 * recipient already received the same figures in the body of the email.
 *
 * Three things keep the blast radius at one document:
 *
 *   1. THE KEY IS DERIVED, not borrowed. A subkey of BLIND_INDEX_KEY under a
 *      fixed label, so a signature minted here cannot be presented anywhere
 *      else that HMACs with that secret, and vice versa.
 *   2. THE TENANT IS SIGNED IN, not just the invoice id. A token is checked
 *      against the row it names, so a forged or swapped id fails even if the
 *      signature somehow verified.
 *   3. IT EXPIRES. Ninety days — long enough that an invoice found in a mail
 *      archive still opens during the period anyone would chase it, short
 *      enough that a leaked link is not a permanent grant. After that the
 *      operator re-sends.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/** Domain separation. Changing this invalidates every outstanding link. */
const LABEL = 'hims:subscription-invoice-download:v1';

const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function signingKey(): Buffer {
  // A subkey rather than the secret itself: the blind-index key is used to
  // HMAC patient identifiers, and the two uses must not share an input space.
  return createHmac('sha256', Buffer.from(env.BLIND_INDEX_KEY, 'base64')).update(LABEL).digest();
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

interface Claims {
  /** Invoice id. */
  i: string;
  /** Tenant id, checked against the row the id resolves to. */
  t: string;
  /** Expiry, epoch milliseconds. */
  e: number;
}

export function signInvoiceDownload(
  invoiceId: string,
  tenantId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  const claims: Claims = { i: invoiceId, t: tenantId, e: Date.now() + ttlMs };
  const body = b64url(JSON.stringify(claims));
  const signature = b64url(createHmac('sha256', signingKey()).update(body).digest());

  return `${body}.${signature}`;
}

export interface VerifiedDownload {
  invoiceId: string;
  tenantId: string;
}

/**
 * Returns null for anything that is not a currently valid token.
 *
 * One null for every failure — bad shape, bad signature, expired — because a
 * caller has no legitimate use for the distinction and an attacker would.
 */
export function verifyInvoiceDownload(token: string | undefined): VerifiedDownload | null {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, signature] = parts as [string, string];

  const expected = createHmac('sha256', signingKey()).update(body).digest();
  let presented: Buffer;

  try {
    presented = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }

  // Length-checked first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a thrown error is itself a side channel.
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;

  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Claims;
  } catch {
    return null;
  }

  if (typeof claims.i !== 'string' || typeof claims.t !== 'string' || typeof claims.e !== 'number') {
    return null;
  }

  if (claims.e <= Date.now()) return null;

  return { invoiceId: claims.i, tenantId: claims.t };
}

/** The URL that goes in the email and the in-app notification. */
export function invoiceDownloadUrl(invoiceId: string, tenantId: string): string {
  const token = signInvoiceDownload(invoiceId, tenantId);
  return `${env.API_BASE_URL}/api/v1/subscription-invoices/${invoiceId}.pdf?token=${token}`;
}
