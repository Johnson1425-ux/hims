/**
 * Request correlation.
 *
 * Every log line, audit row and error response carries the same id, so a
 * clinician reporting "it failed at 10:42" can be traced to one request
 * without searching by patient name — which would mean putting PHI in a
 * support ticket.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  // Honour an upstream id so a trace spans the gateway and the API, but only
  // if it is a well-formed UUID: an attacker-supplied value ends up in logs.
  const incoming = req.header('x-request-id');
  const isUuid = incoming
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(incoming)
    : false;

  req.requestId = isUuid && incoming ? incoming : randomUUID();
  req.auditEntries = [];
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
