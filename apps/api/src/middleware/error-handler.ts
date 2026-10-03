/**
 * The single exit point for every error.
 *
 * Its job is to translate — database and library errors in, a clean contract
 * out — while guaranteeing that no stack trace, SQL fragment, constraint name
 * or PHI value crosses the boundary. A 500 body that leaks `detail: Key
 * (national_id)=(123-45-6789) already exists` is a breach, so unknown errors
 * are always replaced with a generic message and only logged.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import {
  AppError,
  InsufficientStockError,
  InternalError,
  PG_CODES,
  RecordLockedError,
  SlotUnavailableError,
  isPgError,
  type FieldIssue,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { isProduction } from '../config/env.js';

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    issues?: FieldIssue[];
    requestId: string;
  };
}

/**
 * Map database constraint violations onto domain errors.
 *
 * The constraint names here are the contract between the schema and the API:
 * `excl_provider_double_booking` firing is the DOUBLE-BOOKING case, and the
 * patient deserves "that slot was just taken", not a 500.
 */
function translatePgError(error: { code: string; constraint?: string; message: string }): AppError | null {
  switch (error.code) {
    case PG_CODES.EXCLUSION_VIOLATION:
      if (error.constraint === 'excl_provider_double_booking') {
        return new SlotUnavailableError();
      }
      return new AppError(409, 'CONFLICT', 'That change overlaps an existing record.');

    case PG_CODES.UNIQUE_VIOLATION: {
      // Friendly messages for the collisions a user can actually act on.
      const byConstraint: Record<string, AppError> = {
        uq_patients_mrn: new AppError(409, 'CONFLICT', 'A patient with that medical record number already exists.'),
        uq_users_tenant_email: new AppError(409, 'CONFLICT', 'An account with that email address already exists.'),
        uq_invoices_number: new AppError(409, 'CONFLICT', 'That invoice number is already in use.'),
        uq_policy_precedence: new AppError(
          409,
          'CONFLICT',
          'This patient already has an active policy at that precedence. Deactivate it first.',
        ),
        uq_stock_alert_open: new AppError(409, 'CONFLICT', 'An open alert already exists for this item.'),
        uq_notifications_dedupe: new AppError(409, 'CONFLICT', 'That notification has already been queued.'),
      };

      return (
        (error.constraint ? byConstraint[error.constraint] : undefined) ??
        new AppError(409, 'CONFLICT', 'That record already exists.')
      );
    }

    case PG_CODES.CHECK_VIOLATION:
      // Raised by apply_stock_movement() and guard_allocation_total().
      if (/drive .* negative/.test(error.message)) {
        return new AppError(409, 'INSUFFICIENT_STOCK', 'There is not enough stock on hand for that movement.');
      }
      if (/exceed its total/.test(error.message)) {
        return new AppError(
          409,
          'PAYMENT_EXCEEDS_BALANCE',
          'That payment is larger than the outstanding balance. Record the excess as a patient credit.',
        );
      }
      return new AppError(422, 'VALIDATION_FAILED', 'One of the submitted values is outside the allowed range.');

    case PG_CODES.INTEGRITY_CONSTRAINT_VIOLATION:
      // Raised by guard_signed_encounter() and reject_ledger_mutation().
      if (/is signed/.test(error.message)) return new RecordLockedError();
      if (/append-only/.test(error.message)) {
        return new RecordLockedError('That record is part of an append-only register and cannot be changed.');
      }
      return new AppError(409, 'CONFLICT', 'That change is not permitted on this record.');

    case PG_CODES.FOREIGN_KEY_VIOLATION:
      return new AppError(422, 'VALIDATION_FAILED', 'A referenced record does not exist or is no longer available.');

    case PG_CODES.NOT_NULL_VIOLATION:
      return new AppError(422, 'VALIDATION_FAILED', 'A required field was missing.');

    case PG_CODES.INSUFFICIENT_PRIVILEGE:
      // An RLS WITH CHECK refusal: the write targeted another tenant. Surfaced
      // as 404, because confirming the row exists elsewhere is itself a leak.
      return new AppError(404, 'NOT_FOUND', 'That record could not be found.');

    case PG_CODES.QUERY_CANCELED:
      return new AppError(503, 'INTERNAL', 'That request took too long. Please narrow it and try again.');

    case PG_CODES.SERIALIZATION_FAILURE:
    case PG_CODES.DEADLOCK_DETECTED:
      return new AppError(
        409,
        'CONFLICT',
        'Someone else changed this at the same time. Please review and try again.',
      );

    default:
      return null;
  }
}

function zodToIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    message: issue.message,
  }));
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Headers already sent: nothing useful left to say to the client.
  if (res.headersSent) {
    logger.error({ err: error, requestId: req.requestId }, 'error after response was sent');
    next(error);
    return;
  }

  let appError: AppError;

  if (error instanceof AppError) {
    appError = error;
  } else if (error instanceof ZodError) {
    appError = new AppError(422, 'VALIDATION_FAILED', 'The submitted data is not valid.', {
      issues: zodToIssues(error),
    });
  } else if (isPgError(error)) {
    appError = translatePgError(error) ?? new InternalError(error, { pgCode: error.code });
  } else if (error instanceof SyntaxError && 'body' in error) {
    appError = new AppError(400, 'VALIDATION_FAILED', 'The request body is not valid JSON.');
  } else {
    appError = new InternalError(error);
  }

  const logPayload = {
    err: error,
    requestId: req.requestId,
    userId: req.principal?.userId,
    tenantId: req.principal?.tenantId,
    method: req.method,
    // Route pattern, not the populated path, which can embed identifiers.
    route: req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl || req.path,
    status: appError.status,
    code: appError.code,
    ...appError.logContext,
  };

  if (appError.status >= 500) {
    logger.error(logPayload, 'request failed');
  } else if (appError.status === 403 || appError.status === 401) {
    logger.warn(logPayload, 'request refused');
  } else {
    logger.info(logPayload, 'request rejected');
  }

  // Any unexpected error has already been replaced by InternalError above, so
  // nothing from the original message can reach the client.
  const body: ErrorResponseBody = {
    error: {
      code: appError.code,
      message: appError.exposeMessage
        ? appError.message
        : 'Something went wrong on our side. The team has been notified.',
      requestId: req.requestId,
    },
  };

  if (appError.issues?.length) {
    body.error.issues = appError.issues;
  }

  // One concession to developer experience, and only off production.
  if (!isProduction && appError.status >= 500 && error instanceof Error) {
    (body.error as Record<string, unknown>).devDetail = error.message;
  }

  res.status(appError.status).json(body);
}

/** 404 for unmatched routes, so the shape matches every other error. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.path}.`,
      requestId: req.requestId,
    },
  } satisfies ErrorResponseBody);
}
