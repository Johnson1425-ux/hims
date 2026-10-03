/**
 * Permission gates for routes.
 *
 * `requirePermission` covers layer 1 of the RBAC model (may this role do this
 * kind of thing). The per-patient relationship check is layer 2 and lives in
 * the handlers, because only the handler knows which patient is involved.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors.js';
import {
  PHI_PERMISSIONS,
  hasAnyPermission,
  hasPermission,
  type Permission,
  type RoleKey,
} from '../security/rbac.js';

function principalOrThrow(req: Request) {
  if (!req.principal) throw new UnauthenticatedError();
  return req.principal;
}

export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const principal = principalOrThrow(req);

      // Several permissions means any one suffices: a route readable by both a
      // doctor and a billing clerk should not demand both grants.
      if (!hasAnyPermission(principal, permissions)) {
        // Record the refusal. Denied attempts are the signal a privacy officer
        // actually reviews, so they must reach the audit trail.
        req.auditEntries.push({
          action: `authz.denied`,
          resourceType: 'permission',
          outcome: 'denied',
          denialReason: `missing one of: ${permissions.join(', ')}`,
          touchedPhi: permissions.some((p) => PHI_PERMISSIONS.has(p)),
          metadata: { required: permissions, held: [...principal.permissions] },
        });

        throw new ForbiddenError('You do not have permission to do this.', {
          required: permissions,
          userId: principal.userId,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Every listed permission must be held. For genuinely compound actions. */
export function requireAllPermissions(...permissions: Permission[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const principal = principalOrThrow(req);
      const missing = permissions.filter((p) => !hasPermission(principal, p));

      if (missing.length > 0) {
        throw new ForbiddenError('You do not have permission to do this.', { missing });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRole(...roles: RoleKey[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const principal = principalOrThrow(req);

      if (!roles.some((r) => principal.roles.includes(r))) {
        throw new ForbiddenError('This area is restricted.', { required: roles });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Block staff accounts from patient-portal routes and vice versa.
 *
 * The two surfaces have different threat models — a portal session is on a
 * patient's own device — so they are kept strictly apart rather than sharing
 * endpoints with conditional behaviour.
 */
export function requirePortalAccount(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const principal = principalOrThrow(req);
      if (!principal.patientId) {
        throw new ForbiddenError('This endpoint is for patient portal accounts.');
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireStaffAccount(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const principal = principalOrThrow(req);
      if (principal.patientId) {
        throw new ForbiddenError('Patient portal accounts cannot use staff endpoints.');
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Facility scoping. A grant narrowed to one site must not reach another's data,
 * even with the right permission.
 */
export function assertFacilityAccess(req: Request, facilityId: string | null): void {
  const principal = principalOrThrow(req);
  if (!facilityId) return;
  if (principal.facilityIds.length === 0) return; // tenant-wide grant

  if (!principal.facilityIds.includes(facilityId)) {
    throw new ForbiddenError('Your access is limited to your assigned facilities.', {
      facilityId,
      allowed: principal.facilityIds,
    });
  }
}
