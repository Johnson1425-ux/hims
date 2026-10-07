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
import { ConsoleButton } from '@/components/platform/console-shell';

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

  const field = { background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155' } as const;

  if (!token) {
    return (
      <div
        className="rounded-[8px] px-4 py-3 text-[0.8125rem]"
        style={{ background: '#450a0a', color: '#fecaca' }}
      >
        This link is missing its token. Ask the console owner who invited you to send it again.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? (
        <div
          className="rounded-[8px] px-3 py-2.5 text-[0.8125rem]"
          style={{ background: '#450a0a', color: '#fecaca' }}
        >
          {error}
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div
          className="rounded-[8px] px-3 py-2.5 text-[0.8125rem]"
          style={{ background: '#450a0a', color: '#fecaca' }}
        >
          <p className="mb-1 font-medium">Choose a different password:</p>
          <ul className="list-disc pl-4">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <label htmlFor="password" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
          Choose a password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-10 w-full rounded-[6px] px-3 text-[0.875rem]"
          style={field}
        />
        <p className="mt-1.5 text-[0.75rem]" style={{ color: '#64748b' }}>
          Nobody else ever sees this, including whoever invited you — which is what makes a
          console action attributable to you.
        </p>
      </div>

      <div>
        <label htmlFor="confirm" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
          Confirm it
        </label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          className="h-10 w-full rounded-[6px] px-3 text-[0.875rem]"
          style={{ ...field, border: `1px solid ${mismatch ? '#991b1b' : '#334155'}` }}
        />
        {mismatch ? (
          <p className="mt-1.5 text-[0.75rem]" style={{ color: '#fca5a5' }}>
            These do not match.
          </p>
        ) : null}
      </div>

      <ConsoleButton
        type="submit"
        variant="primary"
        disabled={submitting || mismatch || password.length === 0}
      >
        {submitting ? 'Setting your password…' : 'Set password and sign in'}
      </ConsoleButton>
    </form>
  );
}

export default function AcceptInvitePage() {
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
              Join the platform console
            </h1>
            <p className="text-[0.8125rem]" style={{ color: '#64748b' }}>
              Vendor operations across every hospital
            </p>
          </div>
        </div>

        <Suspense
          fallback={
            <p className="text-[0.875rem]" style={{ color: '#64748b' }}>
              Loading…
            </p>
          }
        >
          <AcceptInvite />
        </Suspense>
      </div>
    </div>
  );
}
