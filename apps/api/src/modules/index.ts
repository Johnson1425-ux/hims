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
