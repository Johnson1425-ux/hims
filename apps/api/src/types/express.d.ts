import type { Principal } from '../security/rbac.js';
import type { TenantContext } from '../db/pool.js';
import type { PlatformPrincipal } from '../middleware/authenticate-platform.js';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id, echoed in the X-Request-Id response header. */
      requestId: string;
      /** Set by `authenticate`. Absent on public routes. */
      principal?: Principal;
      /** Set by `withTenantContext`. Carries the RLS-scoped transaction. */
      tenant?: TenantContext;
      /**
       * Set by `authenticatePlatform`. A vendor operator, who is NOT a user of
       * any hospital — deliberately a different field from `principal` so a
       * tenant route cannot be satisfied by a console credential, or vice
       * versa, through a shared name.
       */
      platformPrincipal?: PlatformPrincipal;
      /** Accumulated by handlers; flushed to audit_events by the audit middleware. */
      auditEntries: AuditEntry[];
    }
  }
}

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  patientId?: string | null;
  touchedPhi?: boolean;
  outcome?: 'success' | 'denied' | 'error';
  denialReason?: string | null;
  changes?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export {};
