'use client';

/**
 * Hospital settings.
 *
 * The currency field is the consequential one on this screen, and it is not
 * cosmetic: it decides both the symbol and the SCALE. Amounts are stored as
 * integer minor units, and how many of those make a unit is a property of the
 * currency — one for the Tanzanian shilling, a hundred for the dollar. Changing
 * it therefore reinterprets every amount already recorded, which is why the
 * field says so rather than sitting quietly in a form.
 *
 * Settings and branding are merged server-side rather than replaced, so a form
 * that only knows about four fields cannot wipe a fifth it never loaded.
 *
 * The timezone is a DROPDOWN rather than a text field. It was free text, which
 * looked harmless and was not: the value is the key by which stored instants
 * become the times printed on a clinic list, so a typo saved cleanly and then
 * broke the appointment board. The list comes from the browser's own zone
 * database — see `TimezoneSelect`.
 *
 * SPLIT INTO TABS because it had grown into four unrelated jobs on one
 * scroll: who the hospital is, what sites it has, what it pays, and a pair
 * of identifiers for support. Nobody arrives here wanting all four, and the
 * one people came for was below the fold.
 *
 * The tab lives in the URL hash, so `/settings#subscription` is a link an
 * invoice email or a support reply can send someone straight to.
 *
 * `<SubscriptionCard>` is the hospital's side of the vendor's billing — what
 * it pays for the software, which is a different ledger from the Billing
 * screen (what its patients owe it) and is deliberately read-only here.
 *
 * Facilities and departments live in `<OrgStructure>`, which owns their
 * loading and editing. They are not read from `useTenant()` here: that holds
 * the active-only lists the pickers elsewhere depend on, and administration
 * needs the closed rows in order to offer "reopen".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/layout/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  Skeleton,
  TabPanel,
  Tabs,
} from '@/components/ui/primitives';
import { TimezoneSelect } from '@/components/ui/timezone-select';
import { OrgStructure } from '@/components/settings/org-structure';
import { SubscriptionCard } from '@/components/settings/subscription-card';
import { useSession } from '@/lib/session';
import { useTenant } from '@/lib/tenant';
import { ApiError, api, type TenantProfile } from '@/lib/api';
import { formatMoney, humanise } from '@/lib/format';

/** Currencies this deployment is set up for, with their scale made explicit. */
const CURRENCIES = [
  { code: 'TZS', label: 'Tanzanian shilling (TSh)', minorUnits: 'whole shillings' },
  { code: 'KES', label: 'Kenyan shilling (KSh)', minorUnits: 'cents' },
  { code: 'UGX', label: 'Ugandan shilling (USh)', minorUnits: 'whole shillings' },
  { code: 'USD', label: 'US dollar ($)', minorUnits: 'cents' },
  { code: 'EUR', label: 'Euro (€)', minorUnits: 'cents' },
  { code: 'GBP', label: 'Pound sterling (£)', minorUnits: 'pence' },
];

const LOCALES = [
  { code: 'en-TZ', label: 'English (Tanzania)' },
  { code: 'sw-TZ', label: 'Kiswahili (Tanzania)' },
  { code: 'en-KE', label: 'English (Kenya)' },
  { code: 'en-GB', label: 'English (United Kingdom)' },
  { code: 'en-US', label: 'English (United States)' },
];

const TAB_VALUES = ['hospital', 'organisation', 'subscription'] as const;
type SettingsTab = (typeof TAB_VALUES)[number];

export default function SettingsPage() {
  const { can } = useSession();
  const { tenant, status, error: loadError, reload } = useTenant();
  const editable = can('tenant:settings');

  const [displayName, setDisplayName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [locale, setLocale] = useState('');
  const [currency, setCurrency] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);

  /*
   * The open tab, mirrored into the URL hash.
   *
   * Read on mount rather than during render: the server has no hash — it is
   * never sent in the request — so reading it in the initial state would
   * make the first client render disagree with the server's and trip
   * hydration. Starting on 'hospital' and correcting in an effect is the
   * honest version of that.
   */
  const [tab, setTab] = useState<SettingsTab>('hospital');

  useEffect(() => {
    const apply = () => {
      const fromHash = window.location.hash.replace('#', '');
      if (TAB_VALUES.includes(fromHash as SettingsTab)) setTab(fromHash as SettingsTab);
    };

    apply();

    // Also on `hashchange`, because a URL that differs only in its fragment
    // is a same-document navigation: the browser does not reload and this
    // component does not remount. Without this, a `/settings#subscription`
    // link followed by someone ALREADY on the settings page would change the
    // address bar and nothing else.
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  const openTab = useCallback((next: SettingsTab) => {
    setTab(next);
    // replaceState, not a push: flipping tabs should not fill the back button
    // with places the user never meant to visit.
    window.history.replaceState(null, '', `#${next}`);
  }, []);

  /**
   * Seed the form from the server, but only where the SERVER's answer has
   * changed since it was last seen.
   *
   * Re-seeding unconditionally was fine when this screen only ever reloaded
   * the tenant after its own save. It stopped being fine once adding a
   * facility also reloaded it — the new site has to reach the pickers on the
   * booking and stock screens, which read the same cache — because a half-typed
   * display name would be thrown away by an action taken in a different card.
   *
   * Comparing against the previous SERVER value rather than against the input
   * is what distinguishes the two cases: a reload that did not touch these
   * four fields leaves the user's typing alone, while one that did (a
   * colleague's change, or this screen's own save) still wins.
   */
  const lastSeen = useRef<TenantProfile | null>(null);

  useEffect(() => {
    if (!tenant) return;
    const previous = lastSeen.current;
    lastSeen.current = tenant;

    if (!previous || previous.id !== tenant.id) {
      setDisplayName(tenant.display_name);
      setTimezone(tenant.timezone);
      setLocale(tenant.locale);
      setCurrency(tenant.currency);
      return;
    }

    if (previous.display_name !== tenant.display_name) setDisplayName(tenant.display_name);
    if (previous.timezone !== tenant.timezone) setTimezone(tenant.timezone);
    if (previous.locale !== tenant.locale) setLocale(tenant.locale);
    if (previous.currency !== tenant.currency) setCurrency(tenant.currency);
  }, [tenant]);

  const dirty =
    tenant !== null &&
    (displayName !== tenant.display_name ||
      timezone !== tenant.timezone ||
      locale !== tenant.locale ||
      currency !== tenant.currency);

  const currencyChanging = tenant !== null && currency !== tenant.currency;

  const save = useCallback(async () => {
    if (!tenant) return;

    setSaving(true);
    setNotice(null);

    try {
      await api.patch('/tenant', {
        displayName: displayName !== tenant.display_name ? displayName : undefined,
        timezone: timezone !== tenant.timezone ? timezone : undefined,
        locale: locale !== tenant.locale ? locale : undefined,
        currency: currency !== tenant.currency ? currency : undefined,
      });

      setNotice({ tone: 'good', text: 'Saved.' });
      reload();
    } catch (caught) {
      setNotice({
        tone: 'critical',
        text: caught instanceof ApiError ? caught.message : 'The change could not be saved.',
      });
    } finally {
      setSaving(false);
    }
  }, [tenant, displayName, timezone, locale, currency, reload]);

  if (status === 'loading') {
    return (
      <>
        <PageHeader title="Settings" subtitle="Hospital profile, facilities and departments" />
        <div className="flex flex-col gap-3">
          <Skeleton height={220} />
          <Skeleton height={180} />
        </div>
      </>
    );
  }

  if (status === 'error' || !tenant) {
    return (
      <>
        <PageHeader title="Settings" subtitle="Hospital profile, facilities and departments" />
        <Card>
          <Alert tone="critical" title="Settings could not be loaded">
            {loadError ?? 'Please try again.'}
          </Alert>
        </Card>
      </>
    );
  }

  const selectedCurrency = CURRENCIES.find((c) => c.code === currency);

  const tabs = [
    {
      value: 'hospital' as const,
      label: 'Hospital',
      hint: 'Name, timezone, locale and billing currency',
      // A dot rather than a word: switching away with unsaved edits keeps
      // them in state and hides the Save button, so the tab has to say so.
      badge: dirty ? (
        <span
          aria-label="unsaved changes"
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: 'var(--warning)' }}
        />
      ) : undefined,
    },
    {
      value: 'organisation' as const,
      label: 'Sites & departments',
      hint: 'Where this hospital operates and how it is divided up',
    },
    // Only for an administrator: what a hospital pays its software vendor is
    // not something a clinician needs on screen.
    ...(editable
      ? [
          {
            value: 'subscription' as const,
            label: 'Your subscription',
            hint: 'What this hospital pays for the software',
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle={`${tenant.legal_name} · ${tenant.facility_code}`}
        actions={
          // Only on the tab it belongs to. A save button in the header of a
          // tabbed page is a promise it cannot keep on the other tabs.
          editable && tab === 'hospital' ? (
            <Button variant="primary" disabled={!dirty || saving} loading={saving} onClick={() => void save()}>
              Save changes
            </Button>
          ) : null
        }
      />

      <div className="mb-5">
        <Tabs tabs={tabs} value={tab} onChange={openTab} label="Settings section" idPrefix="settings" />
      </div>

      {!editable ? (
        <div className="mb-5">
          <Alert tone="info" title="Read only">
            Your role can see the hospital configuration — the interface needs the facility and
            department lists to render — but changing it requires the <code>tenant:settings</code>{' '}
            permission.
          </Alert>
        </div>
      ) : null}

      {notice ? (
        <div className="mb-5">
          <Alert tone={notice.tone} title={notice.tone === 'good' ? 'Settings updated' : 'Not saved'}>
            {notice.text}
          </Alert>
        </div>
      ) : null}

      {tab === 'hospital' ? (
        <TabPanel idPrefix="settings" value="hospital">
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Hospital" subtitle="How this hospital is identified across the system" />

              <div className="flex flex-col gap-4">
                <Input
                  name="displayName"
                  label="Display name"
                  value={displayName}
                  disabled={!editable}
                  hint="Shown in the header, on invoices and in notifications"
                  onChange={(event) => setDisplayName(event.target.value)}
                />

                <TimezoneSelect
                  name="timezone"
                  value={timezone}
                  disabled={!editable}
                  hint="Appointment times are stored absolutely and rendered in this zone. A site in a different zone can override it."
                  onChange={setTimezone}
                />

                <div>
                  <label
                    htmlFor="locale"
                    className="mb-1.5 block text-[0.8125rem] font-medium"
                    style={{ color: 'var(--ink-secondary)' }}
                  >
                    Locale
                  </label>
                  <select
                    id="locale"
                    value={locale}
                    disabled={!editable}
                    onChange={(event) => setLocale(event.target.value)}
                    className="h-9.5 w-full rounded-[var(--radius-md)] px-3 text-[0.875rem]"
                    style={{
                      background: 'var(--surface)',
                      color: 'var(--ink)',
                      border: '1px solid var(--line-strong)',
                    }}
                  >
                    {LOCALES.map((option) => (
                      <option key={option.code} value={option.code}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                    Decides date and number formatting, and whether a currency shows its local symbol
                    or its bare ISO code.
                  </p>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Currency" subtitle="The symbol and the scale, which are the same decision" />

              <div className="flex flex-col gap-4">
                <div>
                  <label
                    htmlFor="currency"
                    className="mb-1.5 block text-[0.8125rem] font-medium"
                    style={{ color: 'var(--ink-secondary)' }}
                  >
                    Billing currency
                  </label>
                  <select
                    id="currency"
                    value={currency}
                    disabled={!editable}
                    onChange={(event) => setCurrency(event.target.value)}
                    className="h-9.5 w-full rounded-[var(--radius-md)] px-3 text-[0.875rem]"
                    style={{
                      background: 'var(--surface)',
                      color: 'var(--ink)',
                      border: '1px solid var(--line-strong)',
                    }}
                  >
                    {CURRENCIES.map((option) => (
                      <option key={option.code} value={option.code}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div
                  className="rounded-[var(--radius-md)] p-3"
                  style={{ background: 'var(--surface-sunken)' }}
                >
                  <p className="text-[0.8125rem]" style={{ color: 'var(--ink-secondary)' }}>
                    Amounts are held as whole numbers of the smallest unit —{' '}
                    <strong>{selectedCurrency?.minorUnits ?? 'minor units'}</strong> for{' '}
                    {currency || 'this currency'} — so money never passes through a decimal.
                  </p>
                  <p className="mt-2 text-[0.8125rem]" style={{ color: 'var(--ink-secondary)' }}>
                    A consultation at the catalogue price renders as{' '}
                    <strong className="tabular">{formatMoney(20_000, currency || undefined)}</strong>.
                  </p>
                </div>

                {currencyChanging ? (
                  <Alert tone="warning" title="This reinterprets existing amounts">
                    Changing from {tenant.currency} to {currency} does not convert anything. Every
                    invoice, payment and price already recorded keeps its stored number and is simply
                    read in the new currency — and because the scale differs between currencies, the
                    displayed value can move by a factor of a hundred. Change this on a hospital that
                    has already billed only alongside a deliberate migration of the amounts.
                  </Alert>
                ) : null}
              </div>
            </Card>
          </div>

          <div className="mt-5">
            <Card>
              <CardHeader title="Identifiers" subtitle="Quote these when contacting support" />
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="info">{humanise(tenant.subscription_tier)}</Badge>
                <span className="tabular text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                  {tenant.slug} · {tenant.id}
                </span>
              </div>
            </Card>
          </div>
        </TabPanel>
      ) : null}

      {tab === 'organisation' ? (
        <TabPanel idPrefix="settings" value="organisation">
          <OrgStructure
            editable={editable}
            tenantTimezone={tenant.timezone}
            // The app-wide tenant cache holds the active-only facility and
            // department lists that the booking, registration and stock
            // pickers read, so a change here has to invalidate it.
            onChanged={reload}
          />
        </TabPanel>
      ) : null}

      {tab === 'subscription' && editable ? (
        <TabPanel idPrefix="settings" value="subscription">
          <SubscriptionCard />
        </TabPanel>
      ) : null}
    </>
  );
}
