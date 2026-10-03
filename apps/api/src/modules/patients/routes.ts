import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireStaffAccount } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { patientSearchLimiter } from '../../middleware/rate-limit.js';
import * as controller from './controller.js';
import {
  allergySchema,
  breakGlassSchema,
  createPatientSchema,
  patientIdParam,
  searchPatientsSchema,
  updatePatientSchema,
} from './schemas.js';

export const patientRoutes = Router();

patientRoutes.use(authenticate, requireStaffAccount());

patientRoutes.get(
  '/',
  patientSearchLimiter,
  requirePermission('patient:read'),
  validate({ query: searchPatientsSchema }),
  controller.search,
);

patientRoutes.post(
  '/',
  requirePermission('patient:write'),
  validate({ body: createPatientSchema }),
  controller.create,
);

patientRoutes.get(
  '/:patientId',
  requirePermission('patient:read'),
  validate({ params: patientIdParam }),
  controller.getOne,
);

patientRoutes.patch(
  '/:patientId',
  requirePermission('patient:write'),
  validate({ params: patientIdParam, body: updatePatientSchema }),
  controller.update,
);

patientRoutes.post(
  '/:patientId/allergies',
  // A nurse recording an allergy at triage needs this, so it sits behind the
  // clinical write permission rather than patient:write.
  requirePermission('vitals:write', 'encounter:write'),
  validate({ params: patientIdParam, body: allergySchema }),
  controller.addAllergy,
);

patientRoutes.post(
  '/break-glass',
  // Any clinician may invoke it; the control is the audit and the review, not
  // a narrower permission. Making it hard to reach would cost patient safety.
  requirePermission('patient:read'),
  validate({ body: breakGlassSchema }),
  controller.breakGlass,
);
