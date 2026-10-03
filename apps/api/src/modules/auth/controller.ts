import type { NextFunction, Request, Response } from 'express';
import { UnauthenticatedError } from '../../utils/errors.js';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from '../../security/tokens.js';
import * as authService from './service.js';
import {
  changePasswordSchema,
  completePasswordResetSchema,
  loginSchema,
  requestPasswordResetSchema,
} from './schemas.js';
import { body } from '../../middleware/validate.js';

function requestMeta(req: Request): authService.LoginMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent')?.slice(0, 500) ?? null,
  };
}

/**
 * The refresh token goes out as an httpOnly cookie, never in the JSON body:
 * a token readable by JavaScript is a token stealable by XSS. The access token
 * is returned in the body because it is short-lived and the SPA has to attach
 * it as a bearer header.
 */
function issueSession(res: Response, session: authService.AuthenticatedSession): void {
  res.cookie(REFRESH_COOKIE_NAME, session.refreshToken, refreshCookieOptions());

  res.json({
    data: {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    },
  });
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await authService.login(body(req, loginSchema), requestMeta(req));
    issueSession(res, session);
  } catch (error) {
    next(error);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token =
      (req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined) ??
      (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined);

    if (!token) throw new UnauthenticatedError('Please sign in again.');

    const session = await authService.refresh(token, requestMeta(req));
    issueSession(res, session);
  } catch (error) {
    // A failed refresh must clear the stale cookie, or the client loops.
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    next(error);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const principal = req.principal;
    if (principal) {
      await authService.logout(principal.tenantId, principal.sessionId, principal.userId);
    }

    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function logoutAll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const principal = req.principal;
    if (!principal) throw new UnauthenticatedError();

    const revoked = await authService.logoutAllSessions(principal.tenantId, principal.userId);
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    res.json({ data: { sessionsRevoked: revoked } });
  } catch (error) {
    next(error);
  }
}

/** The SPA calls this on boot to rehydrate the signed-in user. */
export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const principal = req.principal;
    if (!principal) throw new UnauthenticatedError();

    res.json({
      data: {
        id: principal.userId,
        tenantId: principal.tenantId,
        roles: principal.roles,
        permissions: [...principal.permissions],
        staffProfileId: principal.staffProfileId,
        patientId: principal.patientId,
        facilityIds: principal.facilityIds,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const principal = req.principal;
    if (!principal) throw new UnauthenticatedError();

    const input = body(req, changePasswordSchema);
    await authService.changePassword(
      principal.tenantId,
      principal.userId,
      input.currentPassword,
      input.newPassword,
    );

    // Every session was revoked, including this one.
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    res.json({
      data: { message: 'Password updated. Please sign in again on each of your devices.' },
    });
  } catch (error) {
    next(error);
  }
}

export async function requestPasswordReset(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = body(req, requestPasswordResetSchema);
    await authService.requestPasswordReset(input.email, input.tenantSlug);

    // Always 202, whether or not the account exists: anything else is a
    // user-enumeration oracle.
    res.status(202).json({
      data: { message: 'If that address matches an account, a reset link is on its way.' },
    });
  } catch (error) {
    next(error);
  }
}

export async function completePasswordReset(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = body(req, completePasswordResetSchema);
    await authService.completePasswordReset(input.token, input.newPassword);
    res.json({ data: { message: 'Your password has been reset. You can now sign in.' } });
  } catch (error) {
    next(error);
  }
}
