'use client';

/**
 * My account.
 *
 * Changing a password is also a security event: the server revokes every
 * other session for this user, so a stolen token stops working at the moment
 * the password it was obtained with stops being valid. The screen says that
 * rather than letting someone discover it when their tablet signs itself out.
 *
 * "Sign out everywhere" is separate and deliberate — someone who has lost a
 * device wants that one button, and does not want to be made to change their
 * password first.
 */
import { useCallback, useState } from 'react';
import { PageHeader } from '@/components/layout/shell';
import { Alert, Badge, Button, Card, CardHeader } from '@/components/ui/primitives';
import { Field, FormDialog, useFormErrors } from '@/components/ui/forms';
import { useSession } from '@/lib/session';
import { useTenant } from '@/lib/tenant';
import { api, ApiError } from '@/lib/api';
import { humanise } from '@/lib/format';
import { IconShield } from '@/components/layout/icons';

export default function AccountPage() {
  const { user, signOut } = useSession();
  const { tenant } = useTenant();
  const form = useFormErrors();

  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [notice, setNotice] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);
  const [signingOutAll, setSigningOutAll] = useState(false);

  const changePassword = useCallback(async () => {
    form.reset();

    if (next !== confirm) {
      form.setMessage('The two new passwords do not match.');
      return;
    }

    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      setChanging(false);
      setCurrent('');
      setNext('');
      setConfirm('');
      setNotice({
        tone: 'good',
        text: 'Password changed. Every other session you had open has been signed out.',
      });
    } catch (caught) {
      form.capture(caught);
    }
  }, [current, next, confirm, form]);

  async function signOutEverywhere(): Promise<void> {
    setSigningOutAll(true);

    try {
      await api.post('/auth/logout-all', {});
      // This session is one of the ones just revoked, so the only honest thing
      // to do is end it here too rather than keep a dead token on screen.
      await signOut('You were signed out of every device.');
    } catch (caught) {
      setNotice({
        tone: 'critical',
        text: caught instanceof ApiError ? caught.message : 'Could not sign out the other sessions.',
      });
      setSigningOutAll(false);
    }
  }

  if (!user) return null;

  return (
    <>
      <PageHeader title="My account" subtitle={user.email} />

      {notice ? (
        <div className="mb-5">
          <Alert tone={notice.tone} title={notice.tone === 'good' ? 'Done' : 'Not done'}>
            {notice.text}
          </Alert>
        </div>
      ) : null}

      {user.mustChangePassword ? (
        <div className="mb-5">
          <Alert tone="warning" title="You are using a temporary password">
            Set your own before doing anything else. Until you do, anyone who saw the password you
            were given can sign in as you, and the audit trail will say it was you.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Who you are here" />
          <dl className="flex flex-col gap-3 text-[0.875rem]">
            {[
              ['Name', user.fullName],
              ['Email', user.email],
              ['Hospital', tenant?.display_name ?? user.tenantName],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3">
                <dt style={{ color: 'var(--ink-muted)' }}>{label}</dt>
                <dd className="text-right" style={{ color: 'var(--ink)' }}>
                  {value}
                </dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3">
              <dt style={{ color: 'var(--ink-muted)' }}>Roles</dt>
              <dd className="flex flex-wrap justify-end gap-1.5">
                {user.roles.map((role) => (
                  <Badge key={role} tone="info" dot>
                    {humanise(role)}
                  </Badge>
                ))}
              </dd>
            </div>
          </dl>

          <p className="mt-4 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
            Your role carries {user.permissions.length} permissions. They are granted by role, not
            per person, so a change to what a nurse may do applies to every nurse at once.
          </p>
        </Card>

        <Card>
          <CardHeader title="Security" subtitle="Both of these end sessions, including on other devices" />

          <div className="flex flex-col gap-4">
            <div>
              <p className="text-[0.875rem]" style={{ color: 'var(--ink-secondary)' }}>
                Changing your password also signs out every other session you have open, so a token
                taken from a device you no longer control stops working at the same moment.
              </p>
              <div className="mt-2.5">
                <Button
                  variant="primary"
                  onClick={() => {
                    form.reset();
                    setChanging(true);
                  }}
                >
                  Change password
                </Button>
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--line)', paddingTop: '1rem' }}>
              <p className="text-[0.875rem]" style={{ color: 'var(--ink-secondary)' }}>
                Lost a phone or left a ward machine signed in? End every session, including this
                one, without changing anything else.
              </p>
              <div className="mt-2.5">
                <Button
                  variant="danger"
                  icon={<IconShield className="h-4 w-4" />}
                  loading={signingOutAll}
                  onClick={() => void signOutEverywhere()}
                >
                  Sign out everywhere
                </Button>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Automatic sign-out"
            subtitle="Required by §164.312(a)(2)(iii), and enforced in two places"
          />
          <p className="text-[0.875rem]" style={{ color: 'var(--ink-secondary)' }}>
            The server revokes a session left idle for fifteen minutes. This interface clears itself
            on the same schedule and warns two minutes before, because a screen left showing a chart
            in an empty consulting room is the actual exposure — the server revoking the token does
            nothing about what is already on the glass.
          </p>
        </Card>

        <Card>
          <CardHeader title="Second factor" subtitle="Not yet available" />
          <Alert tone="info" title="Named rather than silently absent">
            The schema, the login challenge and the encrypted secret column exist, but TOTP
            verification is not wired up. It is listed as a gap in
            <code> docs/04-security-and-hipaa.md</code> rather than shown here as a switch that
            would not do anything.
          </Alert>
        </Card>
      </div>

      <FormDialog
        open={changing}
        onClose={() => setChanging(false)}
        title="Change your password"
        description="Every other session you have open will be signed out"
        submitLabel="Change it"
        message={form.message}
        disabled={!current || !next || next !== confirm}
        onSubmit={changePassword}
      >
        <Field
          name="currentPassword"
          label="Current password"
          type="password"
          required
          autoComplete="current-password"
          value={current}
          error={form.errors.currentPassword}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <Field
          name="newPassword"
          label="New password"
          type="password"
          required
          autoComplete="new-password"
          hint="Checked against the length and complexity the hospital configures, and against a list of breached passwords."
          value={next}
          error={form.errors.newPassword}
          onChange={(event) => setNext(event.target.value)}
        />
        <Field
          name="confirmPassword"
          label="New password again"
          type="password"
          required
          autoComplete="new-password"
          error={confirm.length > 0 && confirm !== next ? 'These do not match.' : undefined}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </FormDialog>
    </>
  );
}
