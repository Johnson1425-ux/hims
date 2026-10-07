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
import { ConsoleButton } from './console-shell';

const CURRENCIES = ['TZS', 'KES', 'UGX', 'USD', 'EUR', 'GBP'];
const TIERS = ['trial', 'standard', 'enterprise'];
const KINDS = ['hospital', 'clinic', 'lab', 'pharmacy', 'imaging'];

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

const fieldStyle = (invalid: boolean) => ({
  background: '#0b1220',
  color: '#e2e8f0',
  border: `1px solid ${invalid ? '#991b1b' : '#334155'}`,
});

function Field({
  name,
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  type = 'text',
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-[6px] px-3 text-[0.875rem]"
        style={fieldStyle(Boolean(error))}
      />
      {error ? (
        <p className="mt-1 text-[0.75rem]" style={{ color: '#fca5a5' }}>
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-[0.75rem]" style={{ color: '#64748b' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Picker({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
        {label}
      </label>
      <select
        id={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-[6px] px-3 text-[0.875rem] capitalize"
        style={fieldStyle(false)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

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
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ name: string; inviteUrl: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues({ ...EMPTY, timezone: detectTimezone() ?? 'Africa/Dar_es_Salaam' });
    setErrors({});
    setMessage(null);
    setDone(null);
  }, [open]);

  if (!open) return null;

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
      slug:
        previous.slug === slugify(previous.displayName) ? slugify(name) : previous.slug,
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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
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
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ background: 'rgba(2, 6, 23, 0.8)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Provision a hospital"
        className="w-full max-w-[46rem] rounded-[10px]"
        style={{ background: '#111827', border: '1px solid #1f2937' }}
      >
        {done ? (
          <div className="p-6">
            <h2 className="text-[1.125rem] font-semibold" style={{ color: '#f1f5f9' }}>
              {done.name} is live
            </h2>
            <p className="mt-2 text-[0.875rem]" style={{ color: '#94a3b8' }}>
              The hospital, its first site and its administrator account all exist. The
              administrator has no password yet — send them this link so they can choose one.
            </p>

            <div
              className="mt-4 rounded-[8px] px-3 py-2.5 text-[0.8125rem] break-all"
              style={{ background: '#0b1220', color: '#fcd34d', border: '1px solid #334155' }}
            >
              {done.inviteUrl}
            </div>

            <p className="mt-3 text-[0.8125rem]" style={{ color: '#64748b' }}>
              It is valid for seven days and can be used once. It is not stored anywhere you can
              read it again, so copy it now.
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <ConsoleButton
                onClick={() => {
                  void navigator.clipboard?.writeText(done.inviteUrl);
                }}
              >
                Copy link
              </ConsoleButton>
              <ConsoleButton variant="primary" onClick={onClose}>
                Done
              </ConsoleButton>
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="px-6 pt-5 pb-2">
              <h2 className="text-[1.125rem] font-semibold" style={{ color: '#f1f5f9' }}>
                Provision a hospital
              </h2>
              <p className="mt-1 text-[0.8125rem]" style={{ color: '#64748b' }}>
                Creates the tenant, its encryption key, its first site and its first
                administrator — all or nothing.
              </p>
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-6 py-3">
              {message ? (
                <div
                  className="mb-4 rounded-[8px] px-3 py-2.5 text-[0.8125rem]"
                  style={{ background: '#450a0a', color: '#fecaca' }}
                >
                  {message}
                </div>
              ) : null}

              <p className="mb-3 text-[0.75rem] font-medium tracking-[0.03em] uppercase" style={{ color: '#64748b' }}>
                The hospital
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  name="displayName"
                  label="Display name"
                  value={values.displayName}
                  error={errors.displayName}
                  onChange={setDisplayName}
                  placeholder="KCMC Moshi"
                />
                <Field
                  name="legalName"
                  label="Legal name"
                  value={values.legalName}
                  error={errors.legalName}
                  onChange={(v) => set('legalName', v)}
                  hint="As it appears on invoices"
                />
                <Field
                  name="slug"
                  label="Slug"
                  value={values.slug}
                  error={errors.slug}
                  onChange={(v) => set('slug', v.toLowerCase())}
                  hint="Typed at sign-in when an email exists at two hospitals. Permanent."
                />
                <Field
                  name="facilityCode"
                  label="Facility code"
                  value={values.facilityCode}
                  error={errors.facilityCode}
                  onChange={(v) => set('facilityCode', v.toUpperCase())}
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
                  onChange={(v) => set('locale', v)}
                  hint="en-TZ, sw-TZ, en-KE…"
                />
                <Picker
                  name="currency"
                  label="Billing currency"
                  value={values.currency}
                  options={CURRENCIES}
                  onChange={(v) => set('currency', v)}
                />
                <Picker
                  name="subscriptionTier"
                  label="Plan"
                  value={values.subscriptionTier}
                  options={TIERS}
                  onChange={(v) => set('subscriptionTier', v)}
                />
              </div>

              <p
                className="mt-6 mb-3 text-[0.75rem] font-medium tracking-[0.03em] uppercase"
                style={{ color: '#64748b' }}
              >
                Its first site
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  name="facilityName"
                  label="Site name"
                  value={values.facilityName}
                  error={errors.facilityName}
                  onChange={(v) => set('facilityName', v)}
                  hint="More sites are added from the hospital's own settings"
                />
                <Picker
                  name="facilityKind"
                  label="Kind"
                  value={values.facilityKind}
                  options={KINDS}
                  onChange={(v) => set('facilityKind', v)}
                />
                <Field
                  name="city"
                  label="City"
                  value={values.city}
                  error={errors.city}
                  onChange={(v) => set('city', v)}
                />
                <Field
                  name="country"
                  label="Country"
                  value={values.country}
                  error={errors.country}
                  onChange={(v) => set('country', v.toUpperCase())}
                  hint="Two-letter ISO code"
                />
              </div>

              <p
                className="mt-6 mb-3 text-[0.75rem] font-medium tracking-[0.03em] uppercase"
                style={{ color: '#64748b' }}
              >
                Its first administrator
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  name="adminEmail"
                  label="Email"
                  type="email"
                  value={values.adminEmail}
                  error={errors.adminEmail}
                  onChange={(v) => set('adminEmail', v)}
                  hint="They choose their own password from an invitation link"
                />
                <Field
                  name="adminFullName"
                  label="Full name"
                  value={values.adminFullName}
                  error={errors.adminFullName}
                  onChange={(v) => set('adminFullName', v)}
                  placeholder="Neema Mushi"
                />
                <Field
                  name="adminGivenName"
                  label="Given name"
                  value={values.adminGivenName}
                  error={errors.adminGivenName}
                  onChange={(v) => set('adminGivenName', v)}
                />
                <Field
                  name="adminFamilyName"
                  label="Family name"
                  value={values.adminFamilyName}
                  error={errors.adminFamilyName}
                  onChange={(v) => set('adminFamilyName', v)}
                />
              </div>
            </div>

            <div
              className="flex items-center justify-end gap-2 px-6 py-4"
              style={{ borderTop: '1px solid #1f2937' }}
            >
              <ConsoleButton onClick={onClose} disabled={submitting}>
                Cancel
              </ConsoleButton>
              <ConsoleButton type="submit" variant="primary" disabled={!ready || submitting}>
                {submitting ? 'Provisioning…' : 'Provision hospital'}
              </ConsoleButton>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
