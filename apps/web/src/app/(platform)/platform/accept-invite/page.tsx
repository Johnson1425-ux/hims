'use client';

/**
 * Setting a password from an invitation link.
 *
 * Signs the operator straight in afterwards: the server already returns a
 * session from this endpoint, and making someone re-type a password they
 * invented thirty seconds ago teaches them nothing.
 */
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, platformApi, type Operator } from '@/lib/platform-api';
import { usePlatformSession } from '@/lib/platform-session';
import { Alert, Button, Card, Skeleton } from '@/components/ui/primitives';
import { Field } from '@/components/ui/forms';
import { ConsoleBrandMark } from '@/components/platform/console-shell';

function AcceptInvite() {
  const params = useSearchParams();
  const router = useRouter();
  const { adopt } = usePlatformSession();

  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIssues([]);
    setSubmitting(true);

    try {
      const { data } = await platformApi.post<{
        accessToken: string;
        operator: Omit<Operator, 'sessionId'>;
      }>('/auth/accept-invite', { token, password });

      adopt(data.accessToken, { ...data.operator, sessionId: '' });
      router.replace('/platform');
    } catch (caught) {
      if (caught instanceof ApiError) {
        // Policy failures come back as field issues and are the whole point
        // of this screen, so they are listed rather than flattened into one
        // line that says "invalid".
        setIssues(caught.issues.map((i) => i.message));
        setError(caught.issues.length > 0 ? null : caught.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <Alert tone="critical" title="This link is missing its token">
        Ask the console owner who invited you to send it again.
      </Alert>
    );
  }

  return (
    <Card>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error ? <Alert tone="critical">{error}</Alert> : null}

        {issues.length > 0 ? (
          <Alert tone="critical" title="Choose a different password">
            <ul className="mt-1 list-disc pl-4">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <Field
          name="password"
          label="Choose a password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint="Nobody else ever sees this, including whoever invited you — which is what makes a console action attributable to you."
        />

        <Field
          name="confirm"
          label="Confirm it"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          error={mismatch ? 'These do not match.' : undefined}
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={submitting}
          disabled={submitting || mismatch || password.length === 0}
        >
          {submitting ? 'Setting your password…' : 'Set password and sign in'}
        </Button>
      </form>
    </Card>
  );
}

export default function AcceptInvitePage() {
  return (
    <div className="console-root flex min-h-screen items-center justify-center p-5">
      <div className="w-full max-w-[26rem]">
        <ConsoleBrandMark
          title="Join the platform console"
          subtitle="Vendor operations across every hospital"
        />

        <Suspense
          fallback={
            <Card>
              <Skeleton className="w-full" height={120} />
            </Card>
          }
        >
          <AcceptInvite />
        </Suspense>
      </div>
    </div>
  );
}
