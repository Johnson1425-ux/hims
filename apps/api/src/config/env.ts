/**
 * Environment loading and validation.
 *
 * The process exits if configuration is invalid or unsafe. An HMS that boots
 * with a placeholder encryption key is worse than one that does not boot: the
 * first writes unrecoverable patient data, the second pages someone.
 */
import { z } from 'zod';
import { loadEnv } from './load-env.js';
import { booleanish } from '../utils/schema.js';

loadEnv();

const PLACEHOLDERS = [
  'replace-with-32-byte-base64-key',
  'replace-with-long-random-secret',
  'replace-with-a-different-long-random-secret',
  'change-me',
];

/** A 32-byte key, supplied base64-encoded. */
const base64Key32 = z
  .string()
  .refine((v) => !PLACEHOLDERS.includes(v), 'still set to the .env.example placeholder')
  .refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'must be exactly 32 bytes of base64 (generate with: openssl rand -base64 32)');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_PORT: z.coerce.number().int().positive().default(4000),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATION_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(200).default(20),
  DATABASE_SSL: booleanish().default(false),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * The BYPASSRLS connection (`hims_platform`), used by the vendor console
   * and by nothing else. Optional: leave it unset and the console is not
   * mounted at all. That is the safe default — a deployment that has not
   * deliberately turned on cross-tenant access should not be running an
   * endpoint capable of it.
   */
  DATABASE_PLATFORM_URL: z.string().min(1).optional(),

  MASTER_KEY: base64Key32,
  MASTER_KEY_VERSION: z.coerce.number().int().positive().default(1),
  BLIND_INDEX_KEY: base64Key32,

  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'needs at least 32 characters')
    .refine((v) => !PLACEHOLDERS.includes(v), 'still set to the .env.example placeholder'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'needs at least 32 characters')
    .refine((v) => !PLACEHOLDERS.includes(v), 'still set to the .env.example placeholder'),
  /**
   * A THIRD secret, for the platform console. Not a flourish: with a separate
   * key, a tenant access token cannot be verified as a platform token even if
   * an audience check were one day forgotten. Optional for the same reason as
   * DATABASE_PLATFORM_URL — no secret, no console.
   */
  JWT_PLATFORM_SECRET: z
    .string()
    .min(32, 'needs at least 32 characters')
    .refine((v) => !PLACEHOLDERS.includes(v), 'still set to the .env.example placeholder')
    .optional(),
  JWT_ISSUER: z.string().default('hims.local'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(15),

  MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
  ACCOUNT_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('hims-documents'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish().default(true),

  MAIL_PROVIDER: z.enum(['smtp', 'ses', '']).default(''),
  MAIL_FROM: z.string().default('no-reply@hims.local'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  SMS_PROVIDER: z.enum(['twilio', 'africastalking', '']).default(''),
  SMS_FROM: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),

  // Reserved. Nothing connects to Redis today — the reminder worker polls the
  // outbox table directly — so no Redis has to be running. Kept so the
  // deployment shape does not change when caching and a real queue arrive.
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REMINDER_SCAN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  REMINDER_OFFSETS_HOURS: z
    .string()
    .default('48,24,2')
    .transform((v) =>
      v
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 0),
    ),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;

/**
 * Cross-field checks that the schema cannot express on its own.
 * Each one is a mistake that would otherwise surface as a security hole.
 */
const configErrors: string[] = [];

if (env.MASTER_KEY === env.BLIND_INDEX_KEY) {
  configErrors.push(
    'MASTER_KEY and BLIND_INDEX_KEY must differ. Deriving blind indexes from the ' +
      'encryption key lets anyone who can compute an index confirm a guessed ' +
      'plaintext against the ciphertext.',
  );
}

if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
  configErrors.push(
    'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ, otherwise a leaked ' +
      'access token can be replayed as a refresh token.',
  );
}

/**
 * The console is all-or-nothing. Half-configured would mean either an
 * authenticated endpoint with no privileged connection behind it, or a
 * privileged connection reachable with the tenant signing key.
 */
const platformParts = [
  env.DATABASE_PLATFORM_URL ? null : 'DATABASE_PLATFORM_URL',
  env.JWT_PLATFORM_SECRET ? null : 'JWT_PLATFORM_SECRET',
].filter((name): name is string => name !== null);

export const platformConsoleEnabled = platformParts.length === 0;

if (!platformConsoleEnabled && platformParts.length === 1) {
  configErrors.push(
    `The platform console is half-configured: ${platformParts[0]} is missing. ` +
      'Set both DATABASE_PLATFORM_URL and JWT_PLATFORM_SECRET to enable it, or neither to leave it off.',
  );
}

if (
  env.JWT_PLATFORM_SECRET &&
  (env.JWT_PLATFORM_SECRET === env.JWT_ACCESS_SECRET ||
    env.JWT_PLATFORM_SECRET === env.JWT_REFRESH_SECRET)
) {
  configErrors.push(
    'JWT_PLATFORM_SECRET must differ from the tenant secrets. Sharing one would let a ' +
      'hospital access token be presented to the vendor console.',
  );
}

if (env.NODE_ENV === 'production') {
  if (!env.DATABASE_SSL) {
    configErrors.push('DATABASE_SSL must be true in production: ePHI in transit requires TLS.');
  }
  if (env.CORS_ORIGINS.some((o) => o.startsWith('http://'))) {
    configErrors.push('CORS_ORIGINS contains a plaintext http:// origin in production.');
  }
  if (env.CORS_ORIGINS.includes('*')) {
    configErrors.push('CORS_ORIGINS must not be a wildcard in production.');
  }
}

if (configErrors.length > 0) {
  console.error(`Unsafe configuration:\n${configErrors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export type Env = typeof env;
