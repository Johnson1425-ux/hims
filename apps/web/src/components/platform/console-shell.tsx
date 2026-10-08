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
 * The difference used to be a pinned dark palette, which was the wrong
 * instrument: it made the console the one surface in the product that
 * ignored the viewer's theme, and "dark" is a preference people hold, not a
 * warning they read. The cue now rides on the ACCENT — `.console-root`
 * remaps the interactive accent onto a vendor amber that no hospital screen
 * uses, so every primary button, current nav item and focus ring in here is
 * a colour the clinical side never shows — plus a hatched standing banner
 * saying every action is attributed. That survives both themes, and it is
 * carried by the parts of the screen an operator actually looks at.
 *
 * Everything below the chrome is the product's own primitives. A second,
 * lower-quality component set for the vendor's own screens was never worth
 * maintaining: the console inherited none of the keyboard handling, none of
 * the status-plus-glyph rule, and none of the theming.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { usePlatformSession } from '@/lib/platform-session';
import { useTheme } from '@/lib/theme';
import { Badge, cx, type Tone } from '@/components/ui/primitives';
import {
  IconDashboard,
  IconLogout,
  IconMoon,
  IconReceipt,
  IconShield,
  IconStaff,
  IconSun,
} from '@/components/layout/icons';

const NAV = [
  { href: '/platform', label: 'Hospitals', icon: IconDashboard, exact: true },
  { href: '/platform/billing', label: 'Billing', icon: IconReceipt },
  { href: '/platform/operators', label: 'Operators', icon: IconStaff },
  { href: '/platform/audit', label: 'Audit', icon: IconShield },
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
        <div className="flex flex-col items-center gap-3">
          <div className="skeleton h-10 w-10 rounded-full" />
          <p className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
            {status === 'loading' ? 'Checking your console session…' : 'Redirecting to sign in…'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="console-root min-h-screen">
      <a href="#main" className="skip-link no-print">
        Skip to main content
      </a>

      <header
        className="no-print sticky top-0 z-20"
        style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)' }}
      >
        <div className="mx-auto flex h-14 max-w-[88rem] items-center gap-4 px-4 lg:px-8">
          <Link href="/platform" className="flex shrink-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)]"
              style={{ background: 'var(--vendor)', color: 'var(--vendor-on)' }}
            >
              <IconShield />
            </span>
            <span className="hidden sm:block">
              <span
                className="block text-[0.8125rem] leading-tight font-semibold"
                style={{ color: 'var(--ink)' }}
              >
                Platform console
              </span>
              <span
                className="block text-[0.6875rem] leading-tight"
                style={{ color: 'var(--ink-muted)' }}
              >
                Vendor operations
              </span>
            </span>
          </Link>

          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />

            <span
              aria-hidden="true"
              className="mx-1 hidden h-5 w-px sm:block"
              style={{ background: 'var(--line)' }}
            />

            <div className="hidden text-right sm:block">
              <p className="text-[0.8125rem] leading-tight font-medium" style={{ color: 'var(--ink)' }}>
                {operator.fullName}
              </p>
              <p className="text-[0.6875rem] leading-tight" style={{ color: 'var(--ink-muted)' }}>
                {operator.isOwner ? 'Console owner' : 'Operator'}
              </p>
            </div>

            <button
              type="button"
              onClick={() => void signOut()}
              aria-label="Sign out of the console"
              title="Sign out"
              className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:[background:var(--surface-hover)]"
              style={{ color: 'var(--ink-muted)' }}
            >
              <IconLogout />
            </button>
          </div>
        </div>

        {/*
          A scrolling row rather than a drawer: four destinations do not earn
          a hamburger, and a row that is always visible is one tap from
          anywhere instead of two.
        */}
        <nav
          aria-label="Console sections"
          className="mx-auto max-w-[88rem] overflow-x-auto px-4 lg:px-8"
        >
          <ul className="flex items-center gap-1 pb-2">
            {NAV.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              const Icon = item.icon;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5',
                      'text-[0.875rem] whitespace-nowrap transition-colors duration-100',
                      !active && 'hover:[background:var(--surface-hover)]',
                    )}
                    style={
                      active
                        ? {
                            background: 'var(--vendor-soft)',
                            color: 'var(--vendor-ink)',
                            fontWeight: 600,
                          }
                        : { color: 'var(--ink-secondary)' }
                    }
                  >
                    <Icon className="shrink-0" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/*
          Stated on every page rather than once at sign-in. An operator who
          has been in the console for an hour has long stopped thinking about
          it, and that is exactly when it matters.
        */}
        <div
          className="console-watermark flex items-center justify-center gap-2 px-4 py-1.5 text-center text-[0.75rem]"
          style={{ color: 'var(--vendor-ink)', borderTop: '1px solid var(--line)' }}
        >
          <span aria-hidden="true" className="shrink-0">
            <IconShield />
          </span>
          <span>
            Actions here cross hospital boundaries and are recorded against{' '}
            <strong>{operator.email}</strong> in each hospital’s own audit trail
          </span>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[88rem] px-4 py-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}

function ThemeToggle(): ReactNode {
  const { resolved, setTheme } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:[background:var(--surface-hover)]"
      style={{ color: 'var(--ink-muted)' }}
    >
      {resolved === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}

/* ===========================================================================
 * Brand mark
 *
 * The lockup the two unauthenticated screens lead with. Both had their own
 * copy of it, and they had drifted.
 * ======================================================================== */

export function ConsoleBrandMark({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}): ReactNode {
  return (
    <div className="mb-6 flex items-center gap-3">
      <span
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
        style={{ background: 'var(--vendor)', color: 'var(--vendor-on)' }}
      >
        <IconShield />
      </span>
      <div className="min-w-0">
        <h1 className="text-[1.125rem] font-semibold" style={{ color: 'var(--ink)' }}>
          {title}
        </h1>
        <p className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
          {subtitle}
        </p>
      </div>
    </div>
  );
}

/* ===========================================================================
 * Page header
 *
 * Every console screen leads with the same three things, and they were
 * assembled slightly differently on each one.
 * ======================================================================== */

export function PageHeader({
  title,
  subtitle,
  badges,
  action,
  back,
}: {
  title: string;
  subtitle?: ReactNode;
  badges?: ReactNode;
  action?: ReactNode;
  back?: { href: string; label: string };
}): ReactNode {
  return (
    <div className="mb-5">
      {back ? (
        <Link
          href={back.href}
          className="mb-2 inline-flex items-center gap-1 text-[0.8125rem] hover:underline"
          style={{ color: 'var(--ink-muted)' }}
        >
          <span aria-hidden="true">←</span> {back.label}
        </Link>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1
              className="text-[1.375rem] font-semibold tracking-[-0.02em]"
              style={{ color: 'var(--ink)' }}
            >
              {title}
            </h1>
            {badges}
          </div>
          {subtitle ? (
            <p className="mt-1 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

/* ===========================================================================
 * Status badge
 *
 * The console's own vocabulary — tenant lifecycle, subscription state,
 * invoice state, plan tier — mapped onto the product's six tones, so each one
 * arrives with the glyph and label the shared `Badge` guarantees rather than
 * relying on its colour.
 *
 * A plan TIER is not a status, so those are plain dots: `enterprise` is not
 * better or worse than `standard`, and a tick beside one of them would say
 * otherwise.
 * ======================================================================== */

const STATUS_TONES: Record<string, { tone: Tone; dot?: boolean; label?: string }> = {
  // Tenant lifecycle
  active: { tone: 'good' },
  provisioning: { tone: 'info' },
  suspended: { tone: 'serious' },
  archived: { tone: 'neutral', dot: true },

  // Operator lifecycle
  invited: { tone: 'info' },

  // Subscription state
  trialing: { tone: 'info', label: 'trial' },
  cancelled: { tone: 'neutral', dot: true },

  // Invoice state. `overdue` is amber rather than red: it is a conversation
  // to have with a customer, not an incident.
  issued: { tone: 'neutral', dot: true },
  partially_paid: { tone: 'info' },
  paid: { tone: 'good' },
  overdue: { tone: 'warning' },
  void: { tone: 'neutral', dot: true },

  // Plan tiers
  trial: { tone: 'neutral', dot: true },
  standard: { tone: 'neutral', dot: true },
  enterprise: { tone: 'info', dot: true },
};

export function StatusBadge({ value }: { value: string }): ReactNode {
  const token = STATUS_TONES[value] ?? { tone: 'neutral' as Tone, dot: true };

  return (
    <Badge tone={token.tone} dot={token.dot}>
      <span className="capitalize">{(token.label ?? value).replace(/_/g, ' ')}</span>
    </Badge>
  );
}
