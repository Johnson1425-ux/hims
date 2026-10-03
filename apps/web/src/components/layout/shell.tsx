'use client';

/**
 * Application shell: sidebar, topbar, content region.
 *
 * Layout decisions worth stating, because they are what make this read as a
 * hospital system rather than a generic admin panel:
 *
 *  - The sidebar is PERMISSION-DRIVEN. A receptionist does not see a Pharmacy
 *    link they would only be refused at. The nav therefore reflects the user's
 *    actual role, which also means the screen is not a menu of things they
 *    cannot do.
 *  - Global patient search lives in the topbar on every screen and is bound to
 *    a keyboard shortcut, because "find this patient" is the single most
 *    frequent action in the building.
 *  - The content column is capped and centred, so a chart on a 32-inch display
 *    does not stretch a clinical note to 200 characters per line.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { Alert, Avatar, Badge, Button, cx } from '@/components/ui/primitives';
import { api, type PatientSummary } from '@/lib/api';
import { formatAge } from '@/lib/format';
import {
  IconBell,
  IconBox,
  IconCalendar,
  IconChart,
  IconClose,
  IconDashboard,
  IconLogout,
  IconMenu,
  IconMoon,
  IconPatients,
  IconPill,
  IconReceipt,
  IconSearch,
  IconSettings,
  IconShield,
  IconStaff,
  IconStethoscope,
  IconSun,
} from './icons';

interface NavItem {
  href: string;
  label: string;
  icon: (p: { className?: string }) => ReactNode;
  /** Any one of these permissions reveals the item. */
  permissions: string[];
  badge?: 'stockAlerts' | 'unsignedNotes';
}

const NAV_SECTIONS: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: 'Clinical',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: IconDashboard, permissions: ['patient:read', 'portal:self_read'] },
      { href: '/patients', label: 'Patients', icon: IconPatients, permissions: ['patient:read'] },
      { href: '/appointments', label: 'Appointments', icon: IconCalendar, permissions: ['appointment:read'] },
      { href: '/clinical', label: 'Encounters', icon: IconStethoscope, permissions: ['encounter:read'] },
    ],
  },
  {
    heading: 'Pharmacy',
    items: [
      { href: '/pharmacy', label: 'Dispensing', icon: IconPill, permissions: ['prescription:dispense', 'prescription:read'] },
      { href: '/inventory', label: 'Inventory', icon: IconBox, permissions: ['inventory:read'], badge: 'stockAlerts' },
    ],
  },
  {
    heading: 'Administration',
    items: [
      { href: '/billing', label: 'Billing', icon: IconReceipt, permissions: ['invoice:read'] },
      { href: '/staff', label: 'Staff', icon: IconStaff, permissions: ['staff:read'] },
      { href: '/reports', label: 'Reports', icon: IconChart, permissions: ['report:operational', 'report:financial', 'report:clinical'] },
      { href: '/settings', label: 'Settings', icon: IconSettings, permissions: ['tenant:settings'] },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const { user, status, signOut, idleWarning, extendSession, canAny } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  // Close the mobile drawer on navigation, so a tap-through does not leave it
  // covering the page it just opened.
  useEffect(() => setMobileNavOpen(false), [pathname]);

  const sections = useMemo(
    () =>
      NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter((item) => canAny(...item.permissions)),
      })).filter((section) => section.items.length > 0),
    [canAny],
  );

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: 'var(--page)' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="skeleton h-10 w-10 rounded-full" />
          <p className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
            Restoring your session…
          </p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen" style={{ background: 'var(--page)' }}>
      <a href="#main" className="skip-link no-print">
        Skip to main content
      </a>

      {/* ---- Sidebar ------------------------------------------------------ */}
      <aside
        className={cx(
          'no-print fixed inset-y-0 left-0 z-40 flex w-[15.5rem] flex-col transition-transform duration-200',
          'lg:translate-x-0',
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        style={{ background: 'var(--surface)', borderRight: '1px solid var(--line)' }}
      >
        <div className="flex h-14 items-center gap-2.5 px-4" style={{ borderBottom: '1px solid var(--line)' }}>
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[0.875rem] font-bold"
            style={{ background: 'var(--accent)', color: 'var(--ink-on-brand)' }}
          >
            H
          </span>
          <div className="min-w-0">
            {/* Hospital names run long ("St Elizabeth's Regional Medical
                Centre"). Two lines with a clamp beats an ellipsis that hides
                which site you are signed in to. */}
            <p
              className="text-[0.8125rem] leading-[1.15] font-semibold"
              style={{
                color: 'var(--ink)',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
              title={user.tenantName}
            >
              {user.tenantName}
            </p>
            <p className="truncate text-[0.6875rem] leading-tight" style={{ color: 'var(--ink-muted)' }}>
              Hospital Management System
            </p>
          </div>
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="ml-auto lg:hidden"
            aria-label="Close navigation"
            style={{ color: 'var(--ink-muted)' }}
          >
            <IconClose />
          </button>
        </div>

        <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-2 py-3">
          {sections.map((section) => (
            <div key={section.heading} className="mb-4">
              <p
                className="mb-1 px-2.5 text-[0.6875rem] font-semibold tracking-[0.06em] uppercase"
                style={{ color: 'var(--ink-muted)' }}
              >
                {section.heading}
              </p>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const Icon = item.icon;

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cx(
                          'flex items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2',
                          'text-[0.875rem] transition-colors duration-100',
                        )}
                        style={
                          active
                            ? { background: 'var(--accent-soft)', color: 'var(--info-ink)', fontWeight: 600 }
                            : { color: 'var(--ink-secondary)' }
                        }
                      >
                        <Icon className="shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="px-3 pb-3">
          <div
            className="flex items-center gap-2.5 rounded-[var(--radius-md)] p-2.5"
            style={{ background: 'var(--surface-sunken)' }}
          >
            <Avatar name={user.fullName} size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.8125rem] font-medium" style={{ color: 'var(--ink)' }}>
                {user.fullName}
              </p>
              <p className="truncate text-[0.6875rem] capitalize" style={{ color: 'var(--ink-muted)' }}>
                {user.roles.map((r) => r.replace(/_/g, ' ')).join(', ')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              aria-label="Sign out"
              title="Sign out"
              className="shrink-0 rounded-[var(--radius-sm)] p-1.5 transition-colors hover:[background:var(--surface-hover)]"
              style={{ color: 'var(--ink-muted)' }}
            >
              <IconLogout />
            </button>
          </div>
        </div>
      </aside>

      {mobileNavOpen ? (
        <div
          className="fixed inset-0 z-30 lg:hidden"
          style={{ background: 'rgb(13 17 23 / 0.5)' }}
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      {/* ---- Main column -------------------------------------------------- */}
      <div className="lg:pl-[15.5rem]">
        <TopBar onOpenNav={() => setMobileNavOpen(true)} />

        {idleWarning ? (
          <div className="no-print px-4 pt-4 lg:px-8">
            <Alert
              tone="warning"
              title="You will be signed out shortly"
              action={
                <Button size="sm" variant="secondary" onClick={extendSession}>
                  Stay signed in
                </Button>
              }
            >
              This session locks automatically after 15 minutes of inactivity to protect patient
              information.
            </Alert>
          </div>
        ) : null}

        <main id="main" className="px-4 py-6 lg:px-8">
          <div className="mx-auto max-w-[88rem]">{children}</div>
        </main>
      </div>
    </div>
  );
}

/* ===========================================================================
 * Topbar with global patient search
 * ======================================================================== */

function TopBar({ onOpenNav }: { onOpenNav: () => void }): ReactNode {
  const { theme, resolved, setTheme } = useTheme();
  const { canAny } = useSession();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const canSearch = canAny('patient:read');

  // "/" focuses search from anywhere — the shortcut staff learn on day one.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

      if (event.key === '/' && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Debounced, and aborts the previous request: typing an MRN fires one search
  // per keystroke otherwise, and every one of them is an audited PHI read.
  useEffect(() => {
    if (!canSearch || query.trim().length < 2) {
      setResults([]);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await api.get<PatientSummary[]>(
          '/patients',
          { q: query.trim(), pageSize: 8 },
          controller.signal,
        );
        setResults(data);
        setOpen(true);
      } catch {
        // An aborted or failed search leaves the previous results alone.
      } finally {
        setSearching(false);
      }
    }, 280);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, canSearch]);

  return (
    <header
      className="no-print sticky top-0 z-20 flex h-14 items-center gap-3 px-4 lg:px-8"
      style={{
        background: 'color-mix(in srgb, var(--surface) 88%, transparent)',
        backdropFilter: 'blur(8px)',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <button
        type="button"
        onClick={onOpenNav}
        className="lg:hidden"
        aria-label="Open navigation"
        style={{ color: 'var(--ink-secondary)' }}
      >
        <IconMenu />
      </button>

      {canSearch ? (
        <div className="relative max-w-md flex-1">
          <label htmlFor="global-search" className="sr-only">
            Search patients by name or medical record number
          </label>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
            style={{ color: 'var(--ink-muted)' }}
          >
            <IconSearch />
          </span>
          <input
            ref={inputRef}
            id="global-search"
            type="search"
            value={query}
            placeholder="Search patients…"
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls="global-search-results"
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            className="h-9 w-full rounded-[var(--radius-md)] pr-14 pl-9 text-[0.875rem]"
            style={{
              background: 'var(--surface-sunken)',
              color: 'var(--ink)',
              border: '1px solid transparent',
            }}
          />
          <kbd
            aria-hidden="true"
            className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[0.6875rem]"
            style={{ background: 'var(--surface)', color: 'var(--ink-muted)', border: '1px solid var(--line)' }}
          >
            /
          </kbd>

          {open && results.length > 0 ? (
            <ul
              id="global-search-results"
              role="listbox"
              className="absolute top-full left-0 z-30 mt-1.5 w-full overflow-hidden rounded-[var(--radius-md)] py-1"
              style={{
                background: 'var(--surface-raised)',
                border: '1px solid var(--line)',
                boxShadow: 'var(--shadow-lg)',
              }}
            >
              {results.map((patient) => (
                <li key={patient.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      router.push(`/patients/${patient.id}`);
                      setQuery('');
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:[background:var(--surface-hover)]"
                  >
                    <Avatar name={patient.fullName} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.875rem] font-medium" style={{ color: 'var(--ink)' }}>
                        {patient.fullName}
                      </span>
                      <span className="tabular block truncate text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                        {patient.mrn} · {formatAge(patient.dateOfBirth, patient.age)} ·{' '}
                        {patient.sexAtBirth}
                      </span>
                    </span>
                    {patient.vipFlag ? <Badge tone="info">Restricted</Badge> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {searching ? (
            <span className="sr-only" role="status">
              Searching
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} appearance`}
          title={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} appearance`}
          className="rounded-[var(--radius-md)] p-2 transition-colors hover:[background:var(--surface-hover)]"
          style={{ color: 'var(--ink-secondary)' }}
        >
          {resolved === 'dark' ? <IconSun /> : <IconMoon />}
        </button>

        <Link
          href="/dashboard"
          aria-label="Notifications"
          title="Notifications"
          className="rounded-[var(--radius-md)] p-2 transition-colors hover:[background:var(--surface-hover)]"
          style={{ color: 'var(--ink-secondary)' }}
        >
          <IconBell />
        </Link>

        <span
          className="ml-1 hidden items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-[0.6875rem] font-medium sm:flex"
          style={{ background: 'var(--good-soft)', color: 'var(--good-ink)' }}
          title="All access to patient information is logged"
        >
          <IconShield className="h-3.5 w-3.5" />
          Audited
        </span>
      </div>
    </header>
  );
}

/* ===========================================================================
 * Page header, used by every screen for a consistent title block
 * ======================================================================== */

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumbs,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
}): ReactNode {
  return (
    <div className="mb-6">
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex items-center gap-1.5 text-[0.8125rem]">
            {breadcrumbs.map((crumb, index) => (
              <li key={crumb.label} className="flex items-center gap-1.5">
                {index > 0 ? (
                  <span aria-hidden="true" style={{ color: 'var(--ink-muted)' }}>
                    /
                  </span>
                ) : null}
                {crumb.href ? (
                  <Link href={crumb.href} style={{ color: 'var(--ink-muted)' }} className="hover:underline">
                    {crumb.label}
                  </Link>
                ) : (
                  <span style={{ color: 'var(--ink-secondary)' }}>{crumb.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[1.375rem] font-semibold tracking-[-0.02em]" style={{ color: 'var(--ink)' }}>
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-1 text-[0.875rem]" style={{ color: 'var(--ink-muted)' }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
