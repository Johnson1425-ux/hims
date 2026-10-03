/**
 * Structured logging.
 *
 * Redaction is not a nicety here. Logs are shipped off-box, retained for
 * months and read by people with no treatment relationship to the patient, so
 * anything resembling PHI or a credential is stripped before serialisation.
 */
import { createRequire } from 'node:module';
import pino from 'pino';
import { env, isProduction } from '../config/env.js';

/**
 * Pretty-printing is a development convenience, and `pino-pretty` is a dev
 * dependency. A production image installed with --omit=dev must not crash on a
 * missing transport, and neither must a worker started before dev deps are in
 * place, so resolution is checked rather than assumed.
 */
function prettyTransportIfAvailable(): pino.TransportSingleOptions | undefined {
  if (isProduction) return undefined;

  try {
    createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return undefined;
  }

  return {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname,service,env',
    },
  };
}

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'hims-api', env: env.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
      // Credentials
      '*.password',
      '*.passwordHash',
      '*.currentPassword',
      '*.newPassword',
      '*.refreshToken',
      '*.accessToken',
      '*.mfaSecret',
      '*.token',
      // Direct identifiers
      '*.nationalId',
      '*.ssn',
      '*.memberNumber',
      '*.phone',
      '*.email',
      '*.address',
      '*.dateOfBirth',
      // Clinical narrative
      '*.subjective',
      '*.objective',
      '*.assessment',
      '*.plan',
      '*.chiefComplaint',
      '*.diagnosis',
      'body.patient',
      'body.answers',
    ],
    censor: '[redacted]',
  },
  transport: prettyTransportIfAvailable(),
});

export type Logger = typeof logger;
