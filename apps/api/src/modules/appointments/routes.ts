import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';
import {
  appointmentIdParam,
  availabilitySchema,
  bookAppointmentSchema,
  cancelSchema,
  checkInSchema,
  listAppointmentsSchema,
  rescheduleSchema,
} from './schemas.js';

export const appointmentRoutes = Router();

appointmentRoutes.use(authenticate);

// Portal accounts hold portal:self_booking rather than appointment:write, so
// both grants open these routes and the service narrows what each may touch.
const canRead = requirePermission('appointment:read', 'portal:self_read');
const canWrite = requirePermission('appointment:write', 'portal:self_booking');

appointmentRoutes.get(
  '/availability',
  canWrite,
  validate({ query: availabilitySchema }),
  controller.availability,
);

appointmentRoutes.get('/', canRead, validate({ query: listAppointmentsSchema }), controller.list);

appointmentRoutes.post('/', canWrite, validate({ body: bookAppointmentSchema }), controller.book);

appointmentRoutes.post(
  '/:appointmentId/reschedule',
  canWrite,
  validate({ params: appointmentIdParam, body: rescheduleSchema }),
  controller.reschedule,
);

appointmentRoutes.post(
  '/:appointmentId/cancel',
  canWrite,
  validate({ params: appointmentIdParam, body: cancelSchema }),
  controller.cancel,
);

appointmentRoutes.post(
  '/:appointmentId/check-in',
  requirePermission('appointment:checkin'),
  validate({ params: appointmentIdParam, body: checkInSchema }),
  controller.checkIn,
);
