'use client';

/**
 * Forgotten password.
 *
 * The response is identical whether the address is registered or not. That is
 * not evasiveness: a reset form that says "no account with that email" is an
 * account-enumeration oracle, and in a hospital the accounts are staff, so the
 * leak is "who works here" — useful to anyone building a phishing list.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Card } from '@/components/ui/primitives';
import { Field, useFormErrors } from '@/components/ui/forms';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const form = useFormErrors();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    form.reset();

    try {
      await api.post('/auth/password-reset/request', { email });
      setSent(true);
    } catch {
      // Even a failure is reported as success, for the same reason the
      // success message is deliberately vague.
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-16">
      <Card>
        <h1 className="text-[1.5rem] font-semibold tracking-[-0.02em]" style={{ color: 'var(--ink)' }}>
          Reset your password
        </h1>

        {sent ? (
          <div className="mt-4 flex flex-col gap-4">
            <Alert tone="good" title="Check your email">
              If <strong>{email}</strong> belongs to an account here, a reset link is on its way. It
              is valid once, and for a short time.
            </Alert>
            <p className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
              We say "if" on purpose. Telling you whether an address is registered would tell anyone
              else the same thing, and these accounts are the people who work here.
            </p>
            <Link href="/login">
              <Button variant="secondary">Back to sign in</Button>
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
            <p className="text-[0.875rem]" style={{ color: 'var(--ink-secondary)' }}>
              Enter the email address you sign in with and we will send a single-use link.
            </p>

            {form.message ? <Alert tone="critical">{form.message}</Alert> : null}

            <Field
              name="email"
              label="Email"
              type="email"
              required
              autoFocus
              autoComplete="username"
              value={email}
              error={form.errors.email}
              onChange={(event) => setEmail(event.target.value)}
            />

            <div className="flex items-center justify-between gap-3">
              <Link href="/login" className="text-[0.8125rem]" style={{ color: 'var(--accent)' }}>
                Back to sign in
              </Link>
              <Button type="submit" variant="primary" loading={submitting} disabled={!email || submitting}>
                Send the link
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
