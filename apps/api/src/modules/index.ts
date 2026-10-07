/**
 * API surface.
 *
 * One versioned router. Every module mounts its own sub-router and owns its
 * authentication and permission wiring, so a route cannot be added without
 * passing through a `requirePermission` call that is visible in its own file.
 */
import { Router } from 'express';
import { authRoutes } from './auth/routes.js';
import { patientRoutes } from './patients/routes.js';
import { appointmentRoutes } from './appointments/routes.js';
import { inventoryRoutes } from './inventory/routes.js';
import { clinicalRoutes } from './clinical/routes.js';
import { prescriptionRoutes } from './prescriptions/routes.js';
import { billingRoutes } from './billing/routes.js';
import { staffRoutes } from './staff/routes.js';
import { notificationRoutes } from './notifications/routes.js';
import { reportRoutes } from './reports/routes.js';
import { tenantRoutes } from './tenants/routes.js';
import { subscriptionDocumentRoutes } from './subscription-documents/routes.js';
import { platformRoutes } from './platform/routes.js';
import { platformConsoleEnabled } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRoutes);
apiRouter.use('/patients', patientRoutes);
apiRouter.use('/appointments', appointmentRoutes);
apiRouter.use('/encounters', clinicalRoutes);
apiRouter.use('/prescriptions', prescriptionRoutes);
apiRouter.use('/billing', billingRoutes);
apiRouter.use('/inventory', inventoryRoutes);
apiRouter.use('/staff', staffRoutes);
apiRouter.use('/notifications', notificationRoutes);
apiRouter.use('/reports', reportRoutes);
apiRouter.use('/tenant', tenantRoutes);

/*
 * PUBLIC, and the only router here that is.
 *
 * Serves a subscription invoice PDF to the holder of a signed link, because
 * the recipient is clicking from an email and has no session. Authority is
 * the HMAC in the query string rather than a bearer token — see
 * `security/download-tokens.ts` for why that is acceptable for this one
 * document and for nothing else.
 */
apiRouter.use('/subscription-invoices', subscriptionDocumentRoutes);

/*
 * The vendor console, mounted only where the deployment asked for it.
 *
 * This is the one router whose routes can reach across tenant boundaries, so
 * it is not mounted at all unless BOTH DATABASE_PLATFORM_URL (a BYPASSRLS
 * connection) and JWT_PLATFORM_SECRET are configured. An installation that
 * has not deliberately turned cross-tenant access on gets a 404 here rather
 * than an authentication prompt in front of a privileged surface.
 */
if (platformConsoleEnabled) {
  apiRouter.use('/platform', platformRoutes);
  logger.warn('the platform console is ENABLED at /api/v1/platform');
} else {
  logger.info('the platform console is disabled (DATABASE_PLATFORM_URL / JWT_PLATFORM_SECRET unset)');
}
