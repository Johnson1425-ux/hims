'use client';

/**
 * The console's chrome.
 *
 * IT LOOKS DIFFERENT ON PURPOSE. Everything else in this product is a
 * hospital's own system, scoped to one tenant and styled to feel like
 * theirs. This is the vendor's, it can reach every hospital in the
 * deployment, and an operator who cannot tell at a glance which of the two
 * they are looking at will eventually act in the wrong one.
 *
 * So: a fixed dark chrome that ignores the light/dark preference, an amber
 * accent used nowhere else in the product, and a standing line in the header
 * saying every action here is recorded against the operator's name. The
 * warning is not decoration either — it is the cheapest control available
 * for a surface whose misuse looks exactly like ordinary use.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { usePlatformSession } from '@/lib/platform-session';

const NAV = [
  { href: '/platform', label: 'Hospitals', exact: true },
  { href: '/platform/operators', label: 'Operators' },
  { href: '/platform/audit', label: 'Audit' },
];

export function ConsoleShell({ children }: { children: ReactNode }): ReactNode {
  const { operator, status, signOut } = usePlatformSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/platform/login');
  }, [status, router]);

  if (status !== 'authenticated' || !operator) {
    return (
      <div className="console-root flex min-h-screen items-center justify-center">
        <p className="text-[0.875rem]" style={{ color: '#94a3b8' }}>
          {status === 'loading' ? 'Checking your console session…' : 'Redirecting to sign in…'}
        </p>
      </div>
    );
  }

  return (
    <div className="console-root min-h-screen">
      <header style={{ borderBottom: '1px solid #1e293b', background: '#0b1220' }}>
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
          <Link href="/platform" className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[0.8125rem] font-bold"
              style={{ background: '#f59e0b', color: '#0b1220' }}
            >
              V
            </span>
            <span className="text-[0.9375rem] font-semibold" style={{ color: '#e2e8f0' }}>
              Platform console
            </span>
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-[6px] px-3 py-1.5 text-[0.8125rem] font-medium"
                  style={{
                    background: active ? '#1e293b' : 'transparent',
                    color: active ? '#f8fafc' : '#94a3b8',
                  }}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="text-right">
              <p className="text-[0.8125rem] font-medium" style={{ color: '#e2e8f0' }}>
                {operator.fullName}
              </p>
              <p className="text-[0.75rem]" style={{ color: '#64748b' }}>
                {operator.isOwner ? 'Console owner' : 'Operator'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-[6px] px-3 py-1.5 text-[0.8125rem]"
              style={{ border: '1px solid #334155', color: '#cbd5e1' }}
            >
              Sign out
            </button>
          </div>
        </div>

        {/*
          Stated on every page rather than once at sign-in. An operator who
          has been in the console for an hour has long stopped thinking about
          it, and that is exactly when it matters.
        */}
        <div
          className="px-5 py-1.5 text-center text-[0.75rem]"
          style={{ background: '#78350f', color: '#fde68a' }}
        >
          Vendor console · actions here cross hospital boundaries and are recorded against{' '}
          <strong>{operator.email}</strong> in each hospital’s own audit trail
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-5 py-6">{children}</main>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Small presentational pieces, scoped to the console's palette
 * ------------------------------------------------------------------------- */

export function ConsoleCard({
  title,
  subtitle,
  action,
  children,
  padded = true,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}): ReactNode {
  return (
    <section
      className="rounded-[10px]"
      style={{ background: '#111827', border: '1px solid #1f2937' }}
    >
      {title ? (
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h2 className="text-[0.9375rem] font-semibold" style={{ color: '#f1f5f9' }}>
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-0.5 text-[0.8125rem]" style={{ color: '#64748b' }}>
                {subtitle}
              </p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className={padded ? 'px-5 pt-0 pb-5' : ''}>{children}</div>
    </section>
  );
}

const STATUS_COLOURS: Record<string, { bg: string; fg: string }> = {
  active: { bg: '#064e3b', fg: '#6ee7b7' },
  provisioning: { bg: '#1e3a5f', fg: '#93c5fd' },
  suspended: { bg: '#7c2d12', fg: '#fdba74' },
  archived: { bg: '#334155', fg: '#cbd5e1' },
  invited: { bg: '#1e3a5f', fg: '#93c5fd' },
  trial: { bg: '#3b2f14', fg: '#fcd34d' },
  standard: { bg: '#1e293b', fg: '#cbd5e1' },
  enterprise: { bg: '#312e81', fg: '#c7d2fe' },
};

export function ConsoleBadge({ value }: { value: string }): ReactNode {
  const tone = STATUS_COLOURS[value] ?? { bg: '#1e293b', fg: '#cbd5e1' };
  return (
    <span
      className="inline-flex items-center rounded-[5px] px-2 py-0.5 text-[0.75rem] font-medium whitespace-nowrap capitalize"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {value.replace(/_/g, ' ')}
    </span>
  );
}

export function ConsoleButton({
  children,
  variant = 'secondary',
  ...rest
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
} & React.ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  const styles = {
    primary: { background: '#f59e0b', color: '#0b1220', border: '1px solid transparent' },
    secondary: { background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155' },
    danger: { background: '#7f1d1d', color: '#fecaca', border: '1px solid #991b1b' },
  }[variant];

  return (
    <button
      type="button"
      {...rest}
      className="inline-flex h-8 items-center justify-center rounded-[6px] px-3 text-[0.8125rem] font-medium disabled:cursor-not-allowed disabled:opacity-50"
      style={styles}
    >
      {children}
    </button>
  );
}

export function ConsoleStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'warning';
}): ReactNode {
  return (
    <div className="rounded-[10px] px-4 py-3" style={{ background: '#111827', border: '1px solid #1f2937' }}>
      <p className="text-[0.75rem] tracking-[0.03em] uppercase" style={{ color: '#64748b' }}>
        {label}
      </p>
      <p
        className="mt-1 text-[1.5rem] font-semibold tabular-nums"
        style={{ color: tone === 'warning' && Number(value) > 0 ? '#fbbf24' : '#f1f5f9' }}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-[0.75rem]" style={{ color: '#64748b' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function ConsoleTable({ head, children }: { head: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[0.875rem]">
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function ConsoleTh({
  children,
  align = 'left',
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
}): ReactNode {
  return (
    <th
      scope="col"
      className="px-3 py-2 text-[0.75rem] font-medium tracking-[0.03em] whitespace-nowrap uppercase"
      style={{ textAlign: align, color: '#64748b', borderBottom: '1px solid #1f2937' }}
    >
      {children}
    </th>
  );
}

export function ConsoleTd({
  children,
  align = 'left',
  muted,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  muted?: boolean;
}): ReactNode {
  return (
    <td
      className="px-3 py-2.5 align-middle"
      style={{ textAlign: align, color: muted ? '#94a3b8' : '#e2e8f0', borderBottom: '1px solid #1f2937' }}
    >
      {children}
    </td>
  );
}
