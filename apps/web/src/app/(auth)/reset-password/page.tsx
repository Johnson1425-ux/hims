'use client';

/**
 * Set a new password from a reset link.
 *
 * The token arrives in the query string, which means it is in the browser's
 * history and possibly a referrer header — so it is single-use and short-lived
 * server-side, and this page never displays it.
 */
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Card } from '@/components/ui/primitives';
import { Field, useFormErrors } from '@/components/ui/forms';
import { api } from '@/lib/api';

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const form = useFormErrors();

  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    if (next !== confirm) {
      form.setMessage('The two passwords do not match.');
      return;
    }

    setSubmitting(true);
    form.reset();

    try {
      await api.post('/auth/password-reset/complete', { token, newPassword: next });
      setDone(true);
      window.setTimeout(() => router.push('/login'), 2500);
    } catch (caught) {
      form.capture(caught, ['newPassword', 'confirmPassword']);
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <Alert tone="critical" title="This link is incomplete">
        Open the link from your email exactly as it was sent. If it has expired, request another.
      </Alert>
    );
  }

  if (done) {
    return (
      <Alert tone="good" title="Password set">
        Taking you to the sign-in page. Every session that was open under the old password has been
        signed out.
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
      {form.message ? <Alert tone="critical">{form.message}</Alert> : null}

      <Field
        name="newPassword"
        label="New password"
        type="password"
        required
        autoFocus
        autoComplete="new-password"
        value={next}
        error={form.errors.newPassword}
        onChange={(event) => setNext(event.target.value)}
      />
      <Field
        name="confirmPassword"
        label="New password again"
        type="password"
        required
        autoComplete="new-password"
        error={confirm.length > 0 && confirm !== next ? 'These do not match.' : undefined}
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />

      <div className="flex items-center justify-between gap-3">
        <Link href="/login" className="text-[0.8125rem]" style={{ color: 'var(--accent)' }}>
          Back to sign in
        </Link>
        <Button type="submit" variant="primary" loading={submitting} disabled={!next || submitting}>
          Set the password
        </Button>
      </div>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-16">
      <Card>
        <h1 className="text-[1.5rem] font-semibold tracking-[-0.02em]" style={{ color: 'var(--ink)' }}>
          Set a new password
        </h1>
        <Suspense fallback={null}>
          <ResetForm />
        </Suspense>
      </Card>
    </div>
  );
}
