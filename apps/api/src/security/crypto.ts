/**
 * Field-level encryption for PHI.
 *
 * DESIGN
 * ------
 * Envelope encryption, two levels deep:
 *
 *   MASTER KEY (KMS / env in development)
 *       |  wraps
 *   TENANT DATA KEY (DEK)   <- one per hospital, stored wrapped in tenants.dek_wrapped
 *       |  encrypts
 *   FIELD CIPHERTEXT        <- what lands in the *_encrypted bytea columns
 *
 * Why per-tenant keys: one hospital's compromise does not decrypt another's,
 * and offboarding a tenant becomes crypto-shredding (destroy the DEK) rather
 * than a DELETE that leaves rows in backups for years.
 *
 * AES-256-GCM provides confidentiality AND integrity. The record's identity is
 * bound in as Additional Authenticated Data, so a ciphertext lifted from one
 * patient's row and pasted into another's fails to decrypt instead of silently
 * mixing up two charts.
 *
 * WIRE FORMAT  (single bytea column, self-describing so keys can be rotated)
 *   byte 0        version       (0x01)
 *   byte 1        key version   (which master key wrapped the DEK)
 *   bytes 2..13   IV            (12 bytes, random per encryption)
 *   bytes 14..29  auth tag      (16 bytes)
 *   bytes 30..     ciphertext
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env.js';

const FORMAT_VERSION = 0x01;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HEADER_LENGTH = 2 + IV_LENGTH + TAG_LENGTH;

const MASTER_KEY = Buffer.from(env.MASTER_KEY, 'base64');
const BLIND_INDEX_KEY = Buffer.from(env.BLIND_INDEX_KEY, 'base64');

/** Identifies the record a ciphertext belongs to, bound in as AAD. */
export interface CryptoContext {
  tenantId: string;
  /** Table name, e.g. 'patients'. */
  table: string;
  /** Column name, e.g. 'national_id_encrypted'. */
  column: string;
  /**
   * Primary key of the row the ciphertext belongs to.
   *
   * REQUIRED, and not merely for tidiness: this value is what binds a
   * ciphertext to its row. If one call site omits it and the matching reader
   * supplies it, the AAD differs and decryption fails with an authentication
   * error — a bug that surfaces only when someone opens that chart. Making it
   * mandatory moves that failure to compile time.
   *
   * It follows that the row's id must be generated BEFORE its encrypted
   * fields, which is why the repositories select `gen_random_uuid()` rather
   * than relying on the column default.
   */
  recordId: string;
}

function buildAad(ctx: CryptoContext): Buffer {
  // Order matters: the exact same string must be reproducible at decrypt time.
  return Buffer.from([ctx.tenantId, ctx.table, ctx.column, ctx.recordId].join('|'), 'utf8');
}

/* ---------------------------------------------------------------------------
 * Low-level AES-256-GCM
 * ------------------------------------------------------------------------- */

function seal(plaintext: Buffer, key: Buffer, aad: Buffer, keyVersion: number): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([FORMAT_VERSION, keyVersion]), iv, tag, ciphertext]);
}

function open(envelope: Buffer, key: Buffer, aad: Buffer): Buffer {
  if (envelope.length < HEADER_LENGTH) {
    throw new Error('ciphertext is truncated');
  }

  const version = envelope[0];
  if (version !== FORMAT_VERSION) {
    throw new Error(`unsupported ciphertext format version ${version}`);
  }

  const iv = envelope.subarray(2, 2 + IV_LENGTH);
  const tag = envelope.subarray(2 + IV_LENGTH, HEADER_LENGTH);
  const ciphertext = envelope.subarray(HEADER_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  // Throws if the tag does not verify: wrong key, tampered bytes, or the
  // ciphertext was moved to a different row (AAD mismatch).
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/* ---------------------------------------------------------------------------
 * Tenant data keys
 * ------------------------------------------------------------------------- */

/**
 * Mint a data key for a new tenant. Returns the wrapped form for storage; the
 * caller must not persist the plaintext anywhere.
 *
 * In production, replace the local wrap with a KMS Encrypt call so the master
 * key never enters application memory.
 */
export function generateTenantDataKey(tenantId: string): { wrapped: Buffer; keyVersion: number } {
  const dek = randomBytes(KEY_LENGTH);
  const aad = buildAad({ tenantId, table: 'tenants', column: 'dek_wrapped', recordId: tenantId });
  const wrapped = seal(dek, MASTER_KEY, aad, env.MASTER_KEY_VERSION);
  dek.fill(0);
  return { wrapped, keyVersion: env.MASTER_KEY_VERSION };
}

/**
 * Unwrapped data keys are cached in memory, because unwrapping on every field
 * of every row would dominate request latency (and, with a real KMS, cost
 * money per call). The cache is process-local and never written to disk.
 */
const dekCache = new Map<string, { key: Buffer; expiresAt: number }>();
const DEK_CACHE_TTL_MS = 5 * 60 * 1000;

export function unwrapTenantDataKey(tenantId: string, wrapped: Buffer): Buffer {
  const cached = dekCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }

  const aad = buildAad({ tenantId, table: 'tenants', column: 'dek_wrapped', recordId: tenantId });
  const key = open(wrapped, MASTER_KEY, aad);

  if (key.length !== KEY_LENGTH) {
    throw new Error(`tenant ${tenantId} data key has wrong length`);
  }

  dekCache.set(tenantId, { key, expiresAt: Date.now() + DEK_CACHE_TTL_MS });
  return key;
}

/** Drop a cached key — call on tenant suspension or key rotation. */
export function evictTenantDataKey(tenantId: string): void {
  const cached = dekCache.get(tenantId);
  cached?.key.fill(0);
  dekCache.delete(tenantId);
}

export function evictAllDataKeys(): void {
  for (const [, v] of dekCache) v.key.fill(0);
  dekCache.clear();
}

/* ---------------------------------------------------------------------------
 * Field encryption — the API the repositories use
 * ------------------------------------------------------------------------- */

export interface FieldCipher {
  encrypt(value: string | null | undefined, ctx: Omit<CryptoContext, 'tenantId'>): Buffer | null;
  decrypt(envelope: Buffer | null | undefined, ctx: Omit<CryptoContext, 'tenantId'>): string | null;
  encryptJson(value: unknown, ctx: Omit<CryptoContext, 'tenantId'>): Buffer | null;
  decryptJson<T>(envelope: Buffer | null | undefined, ctx: Omit<CryptoContext, 'tenantId'>): T | null;
}

/**
 * Bind a cipher to one tenant's data key. Repositories receive this, so they
 * cannot accidentally encrypt with the wrong hospital's key.
 */
export function createFieldCipher(tenantId: string, wrappedDek: Buffer): FieldCipher {
  const dek = unwrapTenantDataKey(tenantId, wrappedDek);

  return {
    encrypt(value, ctx) {
      if (value === null || value === undefined || value === '') return null;
      return seal(Buffer.from(value, 'utf8'), dek, buildAad({ ...ctx, tenantId }), env.MASTER_KEY_VERSION);
    },

    decrypt(envelope, ctx) {
      if (!envelope || envelope.length === 0) return null;
      return open(envelope, dek, buildAad({ ...ctx, tenantId })).toString('utf8');
    },

    encryptJson(value, ctx) {
      if (value === null || value === undefined) return null;
      return seal(Buffer.from(JSON.stringify(value), 'utf8'), dek, buildAad({ ...ctx, tenantId }), env.MASTER_KEY_VERSION);
    },

    decryptJson<T>(envelope: Buffer | null | undefined, ctx: Omit<CryptoContext, 'tenantId'>): T | null {
      if (!envelope || envelope.length === 0) return null;
      const json = open(envelope, dek, buildAad({ ...ctx, tenantId })).toString('utf8');
      return JSON.parse(json) as T;
    },
  };
}

/* ---------------------------------------------------------------------------
 * Blind indexes — exact-match search over encrypted columns
 * ------------------------------------------------------------------------- */

/**
 * AES-GCM is randomised, so two encryptions of the same phone number produce
 * different bytes and `WHERE phone_encrypted = $1` can never match. A blind
 * index is a deterministic HMAC of the normalised value, stored alongside the
 * ciphertext, giving exact-match lookup without decryption.
 *
 * The trade-off is explicit and bounded:
 *   - Equality works; ordering, ranges and prefix search do not.
 *   - Equal plaintexts produce equal indexes, so an attacker with the database
 *     can see that two patients share a phone number (not what it is).
 *   - Low-cardinality fields must never be indexed this way. A blind index over
 *     a field with few possible values is trivially brute-forced, so this is
 *     reserved for high-entropy identifiers: national IDs, phones, emails,
 *     insurance member numbers.
 *
 * The index is namespaced per tenant and per field so the same phone number at
 * two hospitals yields different digests, which blocks cross-tenant correlation
 * by anyone holding a database dump.
 */
export type BlindIndexField =
  | 'patient.national_id'
  | 'patient.phone'
  | 'patient.email'
  | 'user.phone'
  | 'policy.member_number';

/** Normalisation must be identical at write and at search time, or lookups miss. */
function normalise(field: BlindIndexField, raw: string): string {
  const value = raw.trim();

  switch (field) {
    case 'patient.email':
      return value.toLowerCase();

    case 'patient.phone':
    case 'user.phone':
      // Keep digits and a leading '+' only: "(555) 010-9999" and "+15550109999"
      // must collide, or the duplicate check silently stops working.
      return value.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');

    case 'patient.national_id':
    case 'policy.member_number':
      // Strip separators and case; "123-45-6789" == "123456789".
      return value.replace(/[\s-]/g, '').toUpperCase();

    default:
      return value;
  }
}

export function blindIndex(
  tenantId: string,
  field: BlindIndexField,
  raw: string | null | undefined,
): Buffer | null {
  if (!raw) return null;

  const normalised = normalise(field, raw);
  if (normalised.length === 0) return null;

  return createHmac('sha256', BLIND_INDEX_KEY)
    .update(`${tenantId}|${field}|${normalised}`, 'utf8')
    .digest();
}

/* ---------------------------------------------------------------------------
 * Misc helpers
 * ------------------------------------------------------------------------- */

/** Constant-time comparison; use for any secret, never `===`. */
export function secureEquals(a: Buffer | string, b: Buffer | string): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * SHA-256 digest, used for refresh-token storage and document integrity.
 * Tokens are high-entropy random values, so a plain digest is sufficient here;
 * passwords go through Argon2id in security/password.ts instead.
 */
export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Cryptographically random, URL-safe token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Last n characters, for the "card ending 4821" affordance. */
export function lastChars(value: string | null | undefined, n = 4): string | null {
  if (!value) return null;
  const digits = value.replace(/[\s-]/g, '');
  return digits.length >= n ? digits.slice(-n) : null;
}
