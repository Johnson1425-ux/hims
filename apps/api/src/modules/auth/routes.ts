import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { loginLimiter, passwordResetLimiter } from '../../middleware/rate-limit.js';
import * as controller from './controller.js';
import {
  changePasswordSchema,
  completePasswordResetSchema,
  loginSchema,
  refreshSchema,
  requestPasswordResetSchema,
} from './schemas.js';

export const authRoutes = Router();

// ---- Public -----------------------------------------------------------------
authRoutes.post('/login', loginLimiter, validate({ body: loginSchema }), controller.login);
authRoutes.post('/refresh', validate({ body: refreshSchema }), controller.refresh);

authRoutes.post(
  '/password-reset/request',
  passwordResetLimiter,
  validate({ body: requestPasswordResetSchema }),
  controller.requestPasswordReset,
);
authRoutes.post(
  '/password-reset/complete',
  passwordResetLimiter,
  validate({ body: completePasswordResetSchema }),
  controller.completePasswordReset,
);

// ---- Authenticated ----------------------------------------------------------
authRoutes.post('/logout', authenticate, controller.logout);
authRoutes.post('/logout-all', authenticate, controller.logoutAll);
authRoutes.get('/me', authenticate, controller.me);
authRoutes.post(
  '/change-password',
  authenticate,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);
