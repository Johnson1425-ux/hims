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
import { Alert, Button, Card } from '@/components/ui/primitives';
import { Field } from '@/components/ui/forms';
import { ConsoleBrandMark } from '@/components/platform/console-shell';

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

  return (
    <div className="console-root flex min-h-screen items-center justify-center p-5">
      <div className="w-full max-w-[26rem]">
        <ConsoleBrandMark
          title="Platform console"
          subtitle="Vendor operations across every hospital"
        />

        <div className="mb-5">
          <Alert tone="warning" title="This is not a hospital sign-in">
            Staff accounts do not work here, and console accounts do not work on a hospital.
            Everything done here is recorded against your name in the audit trail of each
            hospital it touches.
          </Alert>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {error ? <Alert tone="critical">{error}</Alert> : null}

            <Field
              name="email"
              label="Operator email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />

            <Field
              name="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />

            <Button type="submit" variant="primary" size="lg" loading={submitting}>
              {submitting ? 'Signing in…' : 'Sign in to the console'}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
          Looking for a hospital?{' '}
          <Link href="/login" className="underline" style={{ color: 'var(--ink-secondary)' }}>
            Staff sign-in
          </Link>
        </p>
      </div>
    </div>
  );
}
