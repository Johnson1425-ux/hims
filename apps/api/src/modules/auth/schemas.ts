import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.').max(320),
  password: z.string().min(1, 'Enter your password.').max(256),
  /**
   * Required when the same email exists at more than one hospital, which is
   * common for locums and consultants holding several appointments.
   */
  tenantSlug: z.string().min(1).max(64).optional(),
  mfaCode: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.').optional(),
});

export const refreshSchema = z.object({
  // Normally read from the httpOnly cookie; accepted in the body for native
  // clients that cannot hold cookies.
  refreshToken: z.string().min(16).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export const requestPasswordResetSchema = z.object({
  email: z.string().email().max(320),
  tenantSlug: z.string().min(1).max(64).optional(),
});

export const completePasswordResetSchema = z.object({
  token: z.string().min(16).max(256),
  newPassword: z.string().min(1).max(256),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
