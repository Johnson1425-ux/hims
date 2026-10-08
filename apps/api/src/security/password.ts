/**
 * Password hashing and policy.
 *
 * Argon2id, not bcrypt: it resists both GPU and side-channel attack, and is the
 * current OWASP recommendation. Parameters follow OWASP's 2024 guidance
 * (19 MiB memory, 2 iterations, parallelism 1), which costs roughly 50 ms per
 * verification on server hardware — slow enough to make offline cracking
 * expensive, fast enough for a login screen.
 */
import argon2 from 'argon2';
import { env } from '../config/env.js';
import { ValidationError } from '../utils/errors.js';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed hash,
 * so a corrupt row cannot be distinguished from a wrong password by timing or
 * by response shape.
 */
export async function verifyPassword(hash: string | null, plaintext: string): Promise<boolean> {
  if (!hash) {
    // No password set (invited but never activated). Still burn comparable time
    // so account existence does not leak through response latency.
    await argon2.hash(plaintext, ARGON2_OPTIONS);
    return false;
  }

  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

/** True when the stored hash was produced with weaker parameters than current. */
export function needsRehash(hash: string): boolean {
  const memoryMatch = /m=(\d+)/.exec(hash);
  const timeMatch = /t=(\d+)/.exec(hash);

  if (!hash.startsWith('$argon2id$')) return true;
  if (memoryMatch?.[1] && Number(memoryMatch[1]) < ARGON2_OPTIONS.memoryCost!) return true;
  if (timeMatch?.[1] && Number(timeMatch[1]) < ARGON2_OPTIONS.timeCost!) return true;

  return false;
}

/**
 * The 20 passwords that actually show up in healthcare credential dumps.
 * A real deployment checks against the Have I Been Pwned range API; this list
 * is the offline floor so the check is never simply absent.
 */
const BANNED_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456', '12345678', '123456789',
  'qwerty', 'qwerty123', 'letmein', 'welcome', 'welcome1', 'admin', 'admin123',
  'hospital', 'hospital1', 'nurse123', 'doctor123', 'changeme', 'passw0rd',
  'p@ssw0rd',
]);

export interface PasswordPolicyResult {
  ok: boolean;
  issues: string[];
  /** 0-4, suitable for a strength meter in the UI. */
  score: number;
}

/**
 * Policy check.
 *
 * Length is weighted far above character-class rules, which is what NIST
 * SP 800-63B actually recommends: "P@ssw0rd!" satisfies every classic
 * complexity rule and is in every cracking dictionary.
 */
export function checkPasswordPolicy(
  password: string,
  context: { email?: string; fullName?: string } = {},
): PasswordPolicyResult {
  const issues: string[] = [];
  const min = env.PASSWORD_MIN_LENGTH;

  if (password.length < min) {
    issues.push(`Use at least ${min} characters.`);
  }
  if (password.length > 256) {
    issues.push('Keep it under 256 characters.');
  }
  if (BANNED_PASSWORDS.has(password.toLowerCase())) {
    issues.push('That password is among the most commonly breached. Choose another.');
  }
  if (/^(.)\1+$/.test(password)) {
    issues.push('A single repeated character is not a password.');
  }
  if (/^(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer)/i.test(password)) {
    issues.push('Avoid starting with a keyboard or number sequence.');
  }

  // A password containing the user's own name or email local-part is guessable
  // by anyone holding the staff directory.
  const localPart = context.email?.split('@')[0];
  if (localPart && localPart.length > 3 && password.toLowerCase().includes(localPart.toLowerCase())) {
    issues.push('Do not include your email address in your password.');
  }
  if (context.fullName) {
    for (const part of context.fullName.split(/\s+/)) {
      if (part.length > 3 && password.toLowerCase().includes(part.toLowerCase())) {
        issues.push('Do not include your name in your password.');
        break;
      }
    }
  }

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const lengthScore = password.length >= 20 ? 3 : password.length >= 16 ? 2 : password.length >= min ? 1 : 0;
  const score = Math.max(0, Math.min(4, lengthScore + (classes >= 3 ? 1 : 0) - (issues.length > 0 ? 2 : 0)));

  return { ok: issues.length === 0, issues, score };
}

/**
 * `field` NAMES THE REQUEST BODY FIELD THE PASSWORD ARRIVED IN, and it is not
 * decoration. The browser attaches a field issue to the input of the same
 * name; an issue naming a field the form does not render attaches to nothing
 * and is shown nowhere, so the user presses the button and watches nothing
 * happen.
 *
 * That is exactly what this did. Two of the three callers take the password
 * as `newPassword` — change-password and password-reset/complete, which is
 * also how an invitation is accepted — and both reported every policy
 * failure against `password`. "Do not include your name in your password"
 * was computed, returned, and silently dropped.
 */
export function assertPasswordPolicy(
  password: string,
  context: { email?: string; fullName?: string; field?: string } = {},
): void {
  const result = checkPasswordPolicy(password, context);
  if (!result.ok) {
    throw new ValidationError(
      result.issues.map((message) => ({ field: context.field ?? 'password', message })),
      'That password does not meet the security policy.',
    );
  }
}
