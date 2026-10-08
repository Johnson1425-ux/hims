'use client';

/**
 * Creating a hospital.
 *
 * The form is longer than a vendor would like and that is the right trade:
 * every field on it is something that cannot be changed later without
 * consequence, or something without which the hospital does not work on day
 * one.
 *
 * The result screen hands back the administrator's invitation link rather
 * than claiming an email was sent. There is no vendor-side mail template in
 * this system, and a confirmation that silently delivers nothing is worse
 * than no confirmation at all — the operator would close the dialog
 * believing the hospital had been handed over.
 */
import { useEffect, useState } from 'react';
import { ApiError, platformApi } from '@/lib/platform-api';
import { TimezoneSelect, detectTimezone } from '@/components/ui/timezone-select';
import { Dialog, Field, FieldSet, FormDialog, Select } from '@/components/ui/forms';
import { Alert, Button } from '@/components/ui/primitives';

const CURRENCIES = ['TZS', 'KES', 'UGX', 'USD', 'EUR', 'GBP'];
const TIERS = ['trial', 'standard', 'enterprise'];
const KINDS = ['hospital', 'clinic', 'lab', 'pharmacy', 'imaging'];

const asOptions = (values: string[]) =>
  values.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }));

interface Values {
  slug: string;
  legalName: string;
  displayName: string;
  facilityCode: string;
  timezone: string;
  locale: string;
  currency: string;
  subscriptionTier: string;
  facilityName: string;
  facilityKind: string;
  city: string;
  country: string;
  adminEmail: string;
  adminFullName: string;
  adminGivenName: string;
  adminFamilyName: string;
}

const EMPTY: Values = {
  slug: '',
  legalName: '',
  displayName: '',
  facilityCode: '',
  timezone: '',
  locale: 'en-TZ',
  currency: 'TZS',
  subscriptionTier: 'trial',
  facilityName: '',
  facilityKind: 'hospital',
  city: '',
  country: 'TZ',
  adminEmail: '',
  adminFullName: '',
  adminGivenName: '',
  adminFamilyName: '',
};

export function ProvisionDialog({
  open,
  onClose,
  onProvisioned,
}: {
  open: boolean;
  onClose: () => void;
  onProvisioned: () => void;
}) {
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; inviteUrl: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues({ ...EMPTY, timezone: detectTimezone() ?? 'Africa/Dar_es_Salaam' });
    setErrors({});
    setMessage(null);
    setDone(null);
    setCopied(false);
  }, [open]);

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  // The slug and code are derived from the display name until the operator
  // edits them, which is the common case and two fewer things to invent.
  const setDisplayName = (name: string) => {
    setValues((previous) => ({
      ...previous,
      displayName: name,
      legalName: previous.legalName === previous.displayName ? name : previous.legalName,
      facilityName:
        previous.facilityName === '' || previous.facilityName === `${previous.displayName} - Main`
          ? `${name} - Main`
          : previous.facilityName,
      slug: previous.slug === slugify(previous.displayName) ? slugify(name) : previous.slug,
    }));
  };

  const ready =
    values.slug.length >= 2 &&
    values.displayName.length >= 2 &&
    values.legalName.length >= 2 &&
    values.facilityCode.length >= 2 &&
    values.facilityName.length >= 2 &&
    values.timezone.length > 0 &&
    values.adminEmail.includes('@') &&
    values.adminGivenName.length >= 1 &&
    values.adminFamilyName.length >= 1;

  const submit = async () => {
    setErrors({});
    setMessage(null);

    try {
      const { data } = await platformApi.post<{
        tenant: { display_name: string };
        adminInviteUrl: string;
      }>('/tenants', {
        ...values,
        adminFullName:
          values.adminFullName.trim() ||
          `${values.adminGivenName} ${values.adminFamilyName}`.trim(),
        city: values.city || undefined,
      });

      setDone({ name: data.tenant.display_name, inviteUrl: data.adminInviteUrl });
      onProvisioned();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors(Object.fromEntries(caught.issues.map((i) => [i.field, i.message])));
        setMessage(caught.issues.length > 0 ? null : caught.message);
      } else {
        setMessage('Something went wrong. Please try again.');
      }
    }
  };

  /*
   * The handover screen is a separate Dialog rather than a branch inside the
   * form one, because it is not a form: there is nothing to submit, and the
   * only thing it must not do is let the operator leave without the link.
   */
  if (done) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        className="console-root"
        title={`${done.name} is live`}
        description="The hospital, its first site and its administrator account all exist."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(done.inviteUrl);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <Alert tone="warning" title="Copy this link now">
          It is valid for seven days, can be used once, and is not stored anywhere you can read
          it again. The administrator has no password until they follow it.
        </Alert>

        <p
          className="mt-4 rounded-[var(--radius-md)] px-3 py-2.5 font-mono text-[0.8125rem] break-all"
          style={{
            background: 'var(--surface-sunken)',
            color: 'var(--ink)',
            border: '1px solid var(--line)',
          }}
        >
          {done.inviteUrl}
        </p>
      </Dialog>
    );
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      className="console-root"
      title="Provision a hospital"
      description="Creates the tenant, its encryption key, its first site and its first administrator — all or nothing."
      submitLabel="Provision hospital"
      onSubmit={submit}
      message={message}
      disabled={!ready}
      width="46rem"
    >
      <FieldSet legend="The hospital">
        <Field
          name="displayName"
          label="Display name"
          value={values.displayName}
          error={errors.displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="KCMC Moshi"
        />
        <Field
          name="legalName"
          label="Legal name"
          value={values.legalName}
          error={errors.legalName}
          onChange={(event) => set('legalName', event.target.value)}
          hint="As it appears on invoices"
        />
        <Field
          name="slug"
          label="Slug"
          value={values.slug}
          error={errors.slug}
          onChange={(event) => set('slug', event.target.value.toLowerCase())}
          hint="Typed at sign-in when an email exists at two hospitals. Permanent."
        />
        <Field
          name="facilityCode"
          label="Facility code"
          value={values.facilityCode}
          error={errors.facilityCode}
          onChange={(event) => set('facilityCode', event.target.value.toUpperCase())}
          hint="Woven into every MRN — MRN-KCMC-000042. Permanent."
        />
        <TimezoneSelect
          name="provisionTimezone"
          value={values.timezone}
          error={errors.timezone}
          onChange={(v) => set('timezone', v)}
        />
        <Field
          name="locale"
          label="Locale"
          value={values.locale}
          error={errors.locale}
          onChange={(event) => set('locale', event.target.value)}
          hint="en-TZ, sw-TZ, en-KE…"
        />
        <Select
          name="currency"
          label="Billing currency"
          value={values.currency}
          options={CURRENCIES.map((value) => ({ value, label: value }))}
          onChange={(event) => set('currency', event.target.value)}
        />
        <Select
          name="subscriptionTier"
          label="Plan"
          value={values.subscriptionTier}
          options={asOptions(TIERS)}
          onChange={(event) => set('subscriptionTier', event.target.value)}
        />
      </FieldSet>

      <FieldSet
        legend="Its first site"
        description="More sites are added by the hospital, from their own settings screen."
      >
        <Field
          name="facilityName"
          label="Site name"
          value={values.facilityName}
          error={errors.facilityName}
          onChange={(event) => set('facilityName', event.target.value)}
        />
        <Select
          name="facilityKind"
          label="Kind"
          value={values.facilityKind}
          options={asOptions(KINDS)}
          onChange={(event) => set('facilityKind', event.target.value)}
        />
        <Field
          name="city"
          label="City"
          value={values.city}
          error={errors.city}
          onChange={(event) => set('city', event.target.value)}
        />
        <Field
          name="country"
          label="Country"
          value={values.country}
          error={errors.country}
          onChange={(event) => set('country', event.target.value.toUpperCase())}
          hint="Two-letter ISO code"
        />
      </FieldSet>

      <FieldSet
        legend="Its first administrator"
        description="They choose their own password from an invitation link, which you hand over at the end."
      >
        <Field
          name="adminEmail"
          label="Email"
          type="email"
          value={values.adminEmail}
          error={errors.adminEmail}
          onChange={(event) => set('adminEmail', event.target.value)}
        />
        <Field
          name="adminFullName"
          label="Full name"
          value={values.adminFullName}
          error={errors.adminFullName}
          onChange={(event) => set('adminFullName', event.target.value)}
          placeholder="Neema Mushi"
        />
        <Field
          name="adminGivenName"
          label="Given name"
          value={values.adminGivenName}
          error={errors.adminGivenName}
          onChange={(event) => set('adminGivenName', event.target.value)}
        />
        <Field
          name="adminFamilyName"
          label="Family name"
          value={values.adminFamilyName}
          error={errors.adminFamilyName}
          onChange={(event) => set('adminFamilyName', event.target.value)}
        />
      </FieldSet>
    </FormDialog>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
