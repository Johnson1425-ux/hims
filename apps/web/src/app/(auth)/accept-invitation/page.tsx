'use client';

/**
 * Accepting an invitation to a hospital.
 *
 * THIS PAGE DID NOT EXIST. Both places that invite somebody into a hospital
 * — provisioning, which mints the first administrator, and `POST /staff`,
 * which invites everyone after them — build a link to `/accept-invitation`,
 * and the route was never created. Every invitation this system has ever
 * issued landed on a 404, including the one handed to an operator at the end
 * of provisioning a new customer.
 *
 * The API side was always there: `POST /auth/password-reset/complete` takes
 * both purposes, and for an invitation it also flips the account from
 * `invited` to `active`. Only the page was missing.
 *
 * It is NOT the same screen as /reset-password, which is why it is not a
 * redirect. "Set a new password" is the wrong sentence for someone who has
 * never had one, and "every session under the old password has been signed
 * out" is the wrong reassurance for an account that has never been used.
 */
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Card } from '@/components/ui/primitives';
import { Field, useFormErrors } from '@/components/ui/forms';
import { api } from '@/lib/api';

function AcceptForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const form = useFormErrors();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    if (password !== confirm) {
      form.setMessage('The two passwords do not match.');
      return;
    }

    setSubmitting(true);
    form.reset();

    try {
      // The same endpoint the reset flow uses. It reads the token's purpose
      // and, for an invitation, activates the account as well as setting the
      // password.
      await api.post('/auth/password-reset/complete', { token, newPassword: password });
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
        Open the link from your invitation exactly as it was sent — the whole thing, including
        everything after the question mark. If it has expired, ask whoever invited you for a new
        one.
      </Alert>
    );
  }

  if (done) {
    return (
      <Alert tone="good" title="Your account is ready">
        Taking you to the sign-in page. Use your work email address and the password you just
        chose.
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
      {form.message ? <Alert tone="critical">{form.message}</Alert> : null}

      <Field
        name="newPassword"
        label="Choose a password"
        type="password"
        required
        autoFocus
        autoComplete="new-password"
        value={password}
        error={form.errors.newPassword}
        onChange={(event) => setPassword(event.target.value)}
        hint="Nobody else ever sees this, including whoever invited you."
      />
      <Field
        name="confirmPassword"
        label="Type it again"
        type="password"
        required
        autoComplete="new-password"
        error={confirm.length > 0 && confirm !== password ? 'These do not match.' : undefined}
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />

      <div className="flex items-center justify-between gap-3">
        <Link href="/login" className="text-[0.8125rem]" style={{ color: 'var(--accent)' }}>
          Already set it up? Sign in
        </Link>
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={!password || submitting}
        >
          Set password
        </Button>
      </div>
    </form>
  );
}

export default function AcceptInvitationPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-16">
      <Card>
        <h1
          className="text-[1.5rem] font-semibold tracking-[-0.02em]"
          style={{ color: 'var(--ink)' }}
        >
          Set up your account
        </h1>
        <p className="mt-1 text-[0.875rem]" style={{ color: 'var(--ink-muted)' }}>
          An account has been created for you. Choose a password and it is ready to use.
        </p>
        <Suspense fallback={null}>
          <AcceptForm />
        </Suspense>
      </Card>
    </div>
  );
}
