'use client';

/**
 * Console sign-in.
 *
 * Says whose console this is and what it reaches, before anyone types. An
 * operator arriving here should never be in any doubt that they are leaving
 * the single-hospital world behind — the hospital login is at /login and
 * looks nothing like this.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError } from '@/lib/platform-api';
import { usePlatformSession } from '@/lib/platform-session';
import { ConsoleButton } from '@/components/platform/console-shell';

export default function PlatformLoginPage() {
  const { signIn, status } = usePlatformSession();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/platform');
  }, [status, router]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await signIn(email.trim(), password);
      router.replace('/platform');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Sign-in failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const field = {
    background: '#0b1220',
    color: '#e2e8f0',
    border: '1px solid #334155',
  } as const;

  return (
    <div className="console-root flex min-h-screen items-center justify-center p-5">
      <div className="w-full max-w-[26rem]">
        <div className="mb-6 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-[8px] text-[1rem] font-bold"
            style={{ background: '#f59e0b', color: '#0b1220' }}
          >
            V
          </span>
          <div>
            <h1 className="text-[1.125rem] font-semibold" style={{ color: '#f1f5f9' }}>
              Platform console
            </h1>
            <p className="text-[0.8125rem]" style={{ color: '#64748b' }}>
              Vendor operations across every hospital
            </p>
          </div>
        </div>

        <div
          className="mb-5 rounded-[8px] px-4 py-3 text-[0.8125rem]"
          style={{ background: '#78350f', color: '#fde68a' }}
        >
          This is not a hospital sign-in. Staff accounts do not work here, and console
          accounts do not work on a hospital. Everything done here is recorded against your
          name in the audit trail of each hospital it touches.
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {error ? (
            <div
              className="rounded-[8px] px-3 py-2.5 text-[0.8125rem]"
              style={{ background: '#450a0a', color: '#fecaca' }}
            >
              {error}
            </div>
          ) : null}

          <div>
            <label htmlFor="email" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
              Operator email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-10 w-full rounded-[6px] px-3 text-[0.875rem]"
              style={field}
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-10 w-full rounded-[6px] px-3 text-[0.875rem]"
              style={field}
            />
          </div>

          <ConsoleButton type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in to the console'}
          </ConsoleButton>
        </form>

        <p className="mt-6 text-center text-[0.8125rem]" style={{ color: '#475569' }}>
          Looking for a hospital?{' '}
          <Link href="/login" style={{ color: '#94a3b8', textDecoration: 'underline' }}>
            Staff sign-in
          </Link>
        </p>
      </div>
    </div>
  );
}
