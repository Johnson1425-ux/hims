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
 */
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/layout/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import { useTenant } from '@/lib/tenant';
import { ApiError, api } from '@/lib/api';
import { formatMoney, humanise } from '@/lib/format';
import { IconSettings } from '@/components/layout/icons';

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

  // Re-seeded whenever the tenant reloads, so the form never shows a stale
  // value next to a saved one.
  useEffect(() => {
    if (!tenant) return;
    setDisplayName(tenant.display_name);
    setTimezone(tenant.timezone);
    setLocale(tenant.locale);
    setCurrency(tenant.currency);
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

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle={`${tenant.legal_name} · ${tenant.facility_code}`}
        actions={
          editable ? (
            <Button variant="primary" disabled={!dirty || saving} loading={saving} onClick={() => void save()}>
              Save changes
            </Button>
          ) : null
        }
      />

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

            <Input
              name="timezone"
              label="Timezone"
              value={timezone}
              disabled={!editable}
              hint="Appointment times are stored absolutely and rendered in this zone"
              onChange={(event) => setTimezone(event.target.value)}
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

        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader
              title="Facilities"
              subtitle="Sites this hospital operates; appointments and stock are held per facility"
            />
          </div>

          {(tenant.facilities ?? []).length === 0 ? (
            <EmptyState icon={<IconSettings />} title="No active facilities" />
          ) : (
            <div className="px-5 pb-1">
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Code</Th>
                    <Th>Kind</Th>
                    <Th align="right">Timezone</Th>
                  </tr>
                </thead>
                <tbody>
                  {(tenant.facilities ?? []).map((facility) => (
                    <Tr key={facility.id}>
                      <Td className="font-medium" style={{ color: 'var(--ink)' }}>
                        {facility.name}
                      </Td>
                      <Td className="tabular" style={{ color: 'var(--ink-muted)' }}>
                        {facility.code}
                      </Td>
                      <Td>
                        <Badge tone="neutral" dot>
                          {humanise(facility.kind)}
                        </Badge>
                      </Td>
                      <Td align="right" style={{ color: 'var(--ink-muted)' }}>
                        {facility.timezone}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>

        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader
              title="Departments"
              subtitle="Used for routing, rotas and the utilisation report"
            />
          </div>

          {(tenant.departments ?? []).length === 0 ? (
            <EmptyState icon={<IconSettings />} title="No active departments" />
          ) : (
            <div className="px-5 pb-1">
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th align="right">Code</Th>
                  </tr>
                </thead>
                <tbody>
                  {(tenant.departments ?? []).map((department) => (
                    <Tr key={department.id}>
                      <Td className="font-medium" style={{ color: 'var(--ink)' }}>
                        {department.name}
                      </Td>
                      <Td align="right" className="tabular" style={{ color: 'var(--ink-muted)' }}>
                        {department.code}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-5">
        <Card>
          <CardHeader title="Plan" subtitle="Not editable from here" />
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="info">{humanise(tenant.subscription_tier)}</Badge>
            <span className="tabular text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
              {tenant.slug} · {tenant.id}
            </span>
          </div>
        </Card>
      </div>
    </>
  );
}
