/**
 * Schema validation.
 *
 * Validated values REPLACE the raw ones on the request, so a handler cannot
 * accidentally read an unvalidated field. Unknown keys are stripped rather
 * than rejected, which stops a client smuggling `{ "status": "signed" }` into
 * a patient-update payload and having it reach the database.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError } from '../utils/errors.js';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) {
        // Express 5 makes req.query a getter, so it is replaced via defineProperty.
        const parsed = schemas.query.parse(req.query);
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) {
        // Express 5 leaves `req.body` undefined when a request carries no body
        // at all (no Content-Type, nothing to parse). An absent body is an
        // empty object as far as validation is concerned — otherwise a
        // bodyless POST such as /auth/refresh fails with an unhelpful
        // "(body): Required" instead of being accepted, or, where fields are
        // genuinely required, instead of naming them.
        req.body = schemas.body.parse(req.body ?? {});
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(
          new AppError(422, 'VALIDATION_FAILED', 'The submitted data is not valid.', {
            issues: error.issues.map((i) => ({
              field: i.path.join('.') || '(body)',
              message: i.message,
            })),
          }),
        );
        return;
      }
      next(error);
    }
  };
}

/**
 * Read a validated path parameter.
 *
 * Express 5 types `req.params` values as `string | string[]`, because a route
 * pattern can repeat a name. Every route here declares each parameter once and
 * validates it with a zod schema first, so this narrows the type in one place
 * instead of scattering non-null assertions through the handlers.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];

  if (typeof value !== 'string') {
    throw new AppError(400, 'VALIDATION_FAILED', `Missing or repeated path parameter "${name}".`);
  }

  return value;
}

/** Typed accessors, so handlers do not re-assert the shape they just validated. */
export function body<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.body as z.infer<T>;
}

export function queryParams<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.query as unknown as z.infer<T>;
}
