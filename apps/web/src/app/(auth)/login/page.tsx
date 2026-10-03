'use client';

/**
 * Sign-in.
 *
 * The split layout is not decoration: the left panel states, before anyone
 * types, that access is logged and restricted to a treatment relationship.
 * Staff who know their access is reviewed behave differently from staff who
 * find out afterwards, and that is a cheaper control than any technical one.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Alert, Button, Input } from '@/components/ui/primitives';
import { IconShield } from '@/components/layout/icons';

export default function LoginPage() {
  const { signIn, status } = useSession();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [showTenant, setShowTenant] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await signIn(email.trim(), password, tenantSlug.trim() || undefined);
      router.replace('/dashboard');
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      setError(apiError);

      // The same email can exist at two hospital groups, so the tenant field
      // appears only once it is actually needed.
      if (apiError?.code === 'UNAUTHENTICATED' && !showTenant && email.includes('@')) {
        setShowTenant(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      {/* ---- Assurance panel --------------------------------------------- */}
      <aside
        className="relative hidden flex-col justify-between overflow-hidden p-10 lg:flex"
        style={{ background: 'var(--surface-inverse)' }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)',
            backgroundSize: '22px 22px',
          }}
        />

        <div className="relative">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[0.9375rem] font-bold"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              H
            </span>
            <span className="text-[1rem] font-semibold" style={{ color: 'var(--ink-inverse)' }}>
              HIMS
            </span>
          </div>
        </div>

        <div className="relative max-w-md">
          <h2
            className="text-[1.75rem] leading-[1.25] font-semibold tracking-[-0.02em]"
            style={{ color: 'var(--ink-inverse)' }}
          >
            One record per patient. One trail for every person who opens it.
          </h2>
          <p className="mt-4 text-[0.9375rem] leading-relaxed" style={{ color: 'rgb(255 255 255 / 0.68)' }}>
            Patient information in this system is restricted to the people involved in that
            patient&rsquo;s care. Every chart you open is recorded against your name, including the
            reason it was permitted.
          </p>

          <ul className="mt-7 flex flex-col gap-3">
            {[
              'Access is limited to your care relationships',
              'Emergency access is available, and is reviewed',
              'Reads and writes are both logged, permanently',
            ].map((line) => (
              <li
                key={line}
                className="flex items-start gap-2.5 text-[0.875rem]"
                style={{ color: 'rgb(255 255 255 / 0.82)' }}
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-bold"
                  style={{ background: 'rgb(12 163 12 / 0.25)', color: '#5fd35f' }}
                >
                  ✓
                </span>
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[0.75rem]" style={{ color: 'rgb(255 255 255 / 0.45)' }}>
          Protected health information. Authorised use only.
        </p>
      </aside>

      {/* ---- Form --------------------------------------------------------- */}
      <main className="flex items-center justify-center px-5 py-12" style={{ background: 'var(--page)' }}>
        <div className="w-full max-w-[22rem]">
          <div className="mb-7 lg:hidden">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] text-[1rem] font-bold"
              style={{ background: 'var(--accent)', color: 'var(--ink-on-brand)' }}
            >
              H
            </span>
          </div>

          <h1 className="text-[1.5rem] font-semibold tracking-[-0.02em]" style={{ color: 'var(--ink)' }}>
            Sign in
          </h1>
          <p className="mt-1.5 text-[0.875rem]" style={{ color: 'var(--ink-muted)' }}>
            Use the account issued by your hospital administrator.
          </p>

          <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4" noValidate>
            {error ? (
              <Alert tone="critical" title="Could not sign you in">
                {error.message}
                {error.requestId ? (
                  <span className="mt-1 block text-[0.75rem] opacity-80">
                    Reference: {error.requestId.slice(0, 8)}
                  </span>
                ) : null}
              </Alert>
            ) : null}

            <Input
              label="Email address"
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@hospital.org"
            />

            <Input
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />

            {showTenant ? (
              <Input
                label="Hospital"
                name="tenantSlug"
                value={tenantSlug}
                onChange={(event) => setTenantSlug(event.target.value)}
                hint="Your account exists at more than one site. Enter the hospital's short name."
                placeholder="mercy"
              />
            ) : null}

            <Button type="submit" variant="primary" size="lg" loading={submitting} className="mt-1 w-full">
              Sign in
            </Button>

            <div className="flex items-center justify-between text-[0.8125rem]">
              <a href="/forgot-password" style={{ color: 'var(--accent)' }} className="hover:underline">
                Forgot your password?
              </a>
              {!showTenant ? (
                <button
                  type="button"
                  onClick={() => setShowTenant(true)}
                  style={{ color: 'var(--ink-muted)' }}
                  className="hover:underline"
                >
                  Choose hospital
                </button>
              ) : null}
            </div>
          </form>

          <div
            className="mt-8 flex items-start gap-2.5 rounded-[var(--radius-md)] p-3"
            style={{ background: 'var(--surface-sunken)', color: 'var(--ink-muted)' }}
          >
            <IconShield className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-[0.75rem] leading-relaxed">
              Sessions lock after 15 minutes of inactivity. Repeated failed attempts lock the
              account temporarily.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
