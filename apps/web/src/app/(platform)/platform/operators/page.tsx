'use client';

/**
 * Who can use this console.
 *
 * Inviting and suspending operators is restricted to owners. Changing who
 * holds cross-tenant access is a different kind of act from doing support
 * work with it, and the API enforces that regardless of what this page
 * renders — the buttons are hidden for a non-owner, and the endpoint still
 * refuses them.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, platformApi, type OperatorRow } from '@/lib/platform-api';
import { usePlatformSession } from '@/lib/platform-session';
import {
  Alert,
  Avatar,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui/primitives';
import { Checkbox, Field, FormDialog } from '@/components/ui/forms';
import { ConsoleShell, PageHeader, StatusBadge } from '@/components/platform/console-shell';
import { IconPlus } from '@/components/layout/icons';

export default function OperatorsPage() {
  return (
    <ConsoleShell>
      <Operators />
    </ConsoleShell>
  );
}

function Operators() {
  const { operator: me } = usePlatformSession();
  const [rows, setRows] = useState<OperatorRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [isOwner, setIsOwner] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const { data } = await platformApi.get<OperatorRow[]>(
          '/operators',
          undefined,
          controller.signal,
        );
        setRows(data);
        setStatus('ready');
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    })();
    return () => controller.abort();
  }, [token]);

  const openInvite = () => {
    setEmail('');
    setFullName('');
    setIsOwner(false);
    setInviteMessage(null);
    setInviting(true);
  };

  const invite = async () => {
    setInviteMessage(null);

    try {
      const { data } = await platformApi.post<{ inviteUrl: string }>('/operators', {
        email: email.trim(),
        fullName: fullName.trim(),
        isOwner,
      });
      setInviteUrl(data.inviteUrl);
      setCopied(false);
      setInviting(false);
      reload();
    } catch (caught) {
      setInviteMessage(
        caught instanceof ApiError
          ? (caught.issues[0]?.message ?? caught.message)
          : 'The invitation could not be created.',
      );
    }
  };

  const setOperatorStatus = async (id: string, next: 'active' | 'suspended') => {
    setNotice(null);
    try {
      await platformApi.patch(`/operators/${id}`, { status: next });
      reload();
    } catch (caught) {
      setNotice(caught instanceof ApiError ? caught.message : 'That change could not be made.');
    }
  };

  /*
   * The server refuses to suspend the last active owner — there would be
   * nobody left who could undo it. The client can see the same thing from
   * the list it is already holding, so the button says so up front rather
   * than failing after the click.
   */
  const otherActiveOwners = rows.filter(
    (r) => r.is_owner && r.status === 'active' && r.id !== me?.operatorId,
  ).length;

  if (status === 'loading') {
    return (
      <>
        <PageHeader title="Operators" />
        <Card>
          <Skeleton className="w-full" height={180} />
        </Card>
      </>
    );
  }

  if (status === 'error') {
    return (
      <>
        <PageHeader title="Operators" />
        <Alert tone="critical" title="The operator list could not be loaded">
          Try again, or check that your console session is still valid.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Operators"
        subtitle="Everyone who can reach every hospital in this deployment"
        action={
          me?.isOwner ? (
            <Button variant="primary" icon={<IconPlus />} onClick={openInvite}>
              Invite an operator
            </Button>
          ) : null
        }
      />

      {notice ? (
        <div className="mb-5">
          <Alert tone="critical">{notice}</Alert>
        </div>
      ) : null}

      {/*
        Shown once, outside the dialog, because the operator has to act on it:
        the link is not stored anywhere it can be read again, so a dialog that
        closed itself would lose it.
      */}
      {inviteUrl ? (
        <div className="mb-5">
          <Alert
            tone="good"
            title="Invitation created"
            action={
              <Button variant="ghost" size="sm" onClick={() => setInviteUrl(null)}>
                Dismiss
              </Button>
            }
          >
            <p>
              Send them this link. It is valid for three days, usable once, and not recoverable
              afterwards.
            </p>
            <p
              className="mt-2 rounded-[var(--radius-sm)] px-2.5 py-2 font-mono text-[0.75rem] break-all"
              style={{ background: 'var(--surface)', color: 'var(--ink)' }}
            >
              {inviteUrl}
            </p>
            <Button
              className="mt-2"
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(inviteUrl);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </Alert>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="Console accounts"
          subtitle={
            me?.isOwner
              ? 'Owners can invite and suspend other operators, including each other'
              : 'Only a console owner can invite or suspend operators'
          }
        />

        <Table className="min-w-[44rem]">
          <thead>
            <tr>
              <Th>Operator</Th>
              <Th>Status</Th>
              <Th>Role</Th>
              <Th align="right">Last signed in</Th>
              {me?.isOwner ? <Th align="right">Actions</Th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <Td colSpan={me?.isOwner ? 5 : 4}>
                  <EmptyState
                    title="No operators"
                    description="This cannot normally happen — you are signed in as one."
                  />
                </Td>
              </tr>
            ) : (
              rows.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={row.full_name} size={32} />
                      <div className="min-w-0">
                        <p className="text-[0.875rem] font-medium" style={{ color: 'var(--ink)' }}>
                          {row.full_name}
                          {row.id === me?.operatorId ? (
                            <span
                              className="ml-2 text-[0.75rem] font-normal"
                              style={{ color: 'var(--ink-muted)' }}
                            >
                              (you)
                            </span>
                          ) : null}
                        </p>
                        <p className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                          {row.email}
                        </p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <StatusBadge value={row.status} />
                    {row.invite_pending ? (
                      <div className="mt-1 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                        invitation outstanding
                      </div>
                    ) : null}
                  </Td>
                  <Td style={{ color: 'var(--ink-secondary)' }}>
                    {row.is_owner ? 'Owner' : 'Operator'}
                  </Td>
                  <Td align="right" style={{ color: 'var(--ink-secondary)' }}>
                    {row.last_login_at ? new Date(row.last_login_at).toLocaleDateString() : 'never'}
                  </Td>
                  {me?.isOwner ? (
                    <Td align="right">
                      {row.status === 'suspended' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void setOperatorStatus(row.id, 'active')}
                        >
                          Reinstate
                        </Button>
                      ) : row.status === 'active' ? (
                        (() => {
                          const lastOwner = row.is_owner && otherActiveOwners === 0;
                          return (
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={lastOwner}
                              title={
                                lastOwner
                                  ? 'The last active console owner cannot be suspended. Make someone else an owner first.'
                                  : undefined
                              }
                              onClick={() => void setOperatorStatus(row.id, 'suspended')}
                            >
                              Suspend
                            </Button>
                          );
                        })()
                      ) : (
                        <span className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                          —
                        </span>
                      )}
                    </Td>
                  ) : null}
                </Tr>
              ))
            )}
          </tbody>
        </Table>
      </Card>

      <FormDialog
        open={inviting}
        onClose={() => setInviting(false)}
        className="console-root"
        title="Invite an operator"
        description="Creates an account with no password. They choose one from a link you send them."
        submitLabel="Create invitation"
        onSubmit={invite}
        message={inviteMessage}
        disabled={!email.includes('@') || fullName.trim().length < 2}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="opEmail"
            label="Email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Field
            name="opName"
            label="Full name"
            required
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </div>

        <Checkbox
          name="isOwner"
          label="Make them an owner"
          hint="Owners can invite and suspend other operators, including you."
          checked={isOwner}
          onChange={(event) => setIsOwner(event.target.checked)}
        />
      </FormDialog>
    </>
  );
}
