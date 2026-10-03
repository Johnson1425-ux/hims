/**
 * The application error taxonomy.
 *
 * Every error reaching a client passes through here, which is what lets the
 * error handler guarantee one thing: no PHI, no stack trace and no SQL ever
 * crosses the boundary. Messages on these classes are written for a clinician
 * to read, not for a debugger.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SLOT_UNAVAILABLE'
  | 'DUPLICATE_PATIENT'
  | 'INSUFFICIENT_STOCK'
  | 'RECORD_LOCKED'
  | 'PAYMENT_EXCEEDS_BALANCE'
  | 'RATE_LIMITED'
  | 'TENANT_SUSPENDED'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL';

export interface FieldIssue {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly issues?: FieldIssue[];
  /** Safe to show the end user? Internal errors are replaced with a generic message. */
  readonly exposeMessage: boolean;
  /** Extra context for the log only. Never serialised into a response. */
  readonly logContext?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options: {
      issues?: FieldIssue[];
      exposeMessage?: boolean;
      logContext?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.issues = options.issues;
    this.exposeMessage = options.exposeMessage ?? true;
    this.logContext = options.logContext;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(issues: FieldIssue[], message = 'The submitted data is not valid.') {
    super(422, 'VALIDATION_FAILED', message, { issues });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Sign in to continue.') {
    super(401, 'UNAUTHENTICATED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this.', logContext?: Record<string, unknown>) {
    super(403, 'FORBIDDEN', message, { logContext });
  }
}

export class NotFoundError extends AppError {
  /**
   * Deliberately indistinguishable from a cross-tenant access attempt: under
   * RLS a record in another hospital simply does not exist for this session,
   * and the response must not reveal otherwise.
   */
  constructor(resource = 'record') {
    super(404, 'NOT_FOUND', `That ${resource} could not be found.`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = 'CONFLICT') {
    super(409, code, message);
  }
}

export class SlotUnavailableError extends AppError {
  constructor(message = 'That time slot has just been taken. Please pick another.') {
    super(409, 'SLOT_UNAVAILABLE', message);
  }
}

export class InsufficientStockError extends AppError {
  constructor(itemName: string, available: number, requested: number) {
    super(
      409,
      'INSUFFICIENT_STOCK',
      `Only ${available} of ${itemName} remain in stock; ${requested} were requested.`,
    );
  }
}

export class RecordLockedError extends AppError {
  constructor(message = 'This record is signed and can no longer be edited. Record an amendment instead.') {
    super(409, 'RECORD_LOCKED', message);
  }
}

export class InternalError extends AppError {
  constructor(cause?: unknown, logContext?: Record<string, unknown>) {
    super(500, 'INTERNAL', 'Something went wrong on our side. The team has been notified.', {
      exposeMessage: true,
      logContext,
      cause,
    });
  }
}

/** PostgreSQL error codes this application reacts to specifically. */
export const PG_CODES = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  EXCLUSION_VIOLATION: '23P01',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  INTEGRITY_CONSTRAINT_VIOLATION: '23000',
  INSUFFICIENT_PRIVILEGE: '42501',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  QUERY_CANCELED: '57014',
} as const;

export function isPgError(e: unknown): e is { code: string; constraint?: string; detail?: string; message: string } {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string';
}
