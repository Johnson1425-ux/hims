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
  ConsoleBadge,
  ConsoleButton,
  ConsoleCard,
  ConsoleShell,
  ConsoleTable,
  ConsoleTd,
  ConsoleTh,
} from '@/components/platform/console-shell';

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
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const { data } = await platformApi.get<OperatorRow[]>('/operators', undefined, controller.signal);
        setRows(data);
        setStatus('ready');
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    })();
    return () => controller.abort();
  }, [token]);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);

    try {
      const { data } = await platformApi.post<{ inviteUrl: string }>('/operators', {
        email: email.trim(),
        fullName: fullName.trim(),
        isOwner,
      });
      setInviteUrl(data.inviteUrl);
      setInviting(false);
      setEmail('');
      setFullName('');
      setIsOwner(false);
      reload();
    } catch (caught) {
      setNotice(
        caught instanceof ApiError
          ? (caught.issues[0]?.message ?? caught.message)
          : 'The invitation could not be created.',
      );
    } finally {
      setBusy(false);
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

  if (status === 'loading') {
    return <p className="text-[0.875rem]" style={{ color: '#64748b' }}>Loading…</p>;
  }

  const field = { background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155' } as const;

  return (
    <>
      {notice ? (
        <div className="mb-5 rounded-[8px] px-4 py-3 text-[0.875rem]" style={{ background: '#450a0a', color: '#fecaca' }}>
          {notice}
        </div>
      ) : null}

      {inviteUrl ? (
        <div
          className="mb-5 rounded-[8px] px-4 py-3 text-[0.875rem]"
          style={{ background: '#0b1220', border: '1px solid #334155' }}
        >
          <p style={{ color: '#e2e8f0' }}>
            Invitation created. Send them this link — it is valid for three days, usable once,
            and not recoverable afterwards.
          </p>
          <p className="mt-2 break-all" style={{ color: '#fcd34d' }}>
            {inviteUrl}
          </p>
          <div className="mt-3 flex gap-2">
            <ConsoleButton onClick={() => void navigator.clipboard?.writeText(inviteUrl)}>
              Copy link
            </ConsoleButton>
            <ConsoleButton onClick={() => setInviteUrl(null)}>Dismiss</ConsoleButton>
          </div>
        </div>
      ) : null}

      <ConsoleCard
        title="Operators"
        subtitle="Everyone who can reach every hospital in this deployment"
        padded={false}
        action={
          me?.isOwner && !inviting ? (
            <ConsoleButton variant="primary" onClick={() => setInviting(true)}>
              Invite an operator
            </ConsoleButton>
          ) : null
        }
      >
        {inviting ? (
          <form onSubmit={invite} className="mb-4 px-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="opEmail" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                  Email
                </label>
                <input
                  id="opEmail"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="h-9 w-full rounded-[6px] px-3 text-[0.875rem]"
                  style={field}
                />
              </div>
              <div>
                <label htmlFor="opName" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                  Full name
                </label>
                <input
                  id="opName"
                  required
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  className="h-9 w-full rounded-[6px] px-3 text-[0.875rem]"
                  style={field}
                />
              </div>
            </div>

            <label className="mt-3 flex items-start gap-2 text-[0.875rem]" style={{ color: '#cbd5e1' }}>
              <input
                type="checkbox"
                checked={isOwner}
                onChange={(event) => setIsOwner(event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                Make them an owner
                <span className="block text-[0.75rem]" style={{ color: '#64748b' }}>
                  Owners can invite and suspend other operators, including you.
                </span>
              </span>
            </label>

            <div className="mt-3 flex gap-2">
              <ConsoleButton type="submit" variant="primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create invitation'}
              </ConsoleButton>
              <ConsoleButton onClick={() => setInviting(false)} disabled={busy}>
                Cancel
              </ConsoleButton>
            </div>
          </form>
        ) : null}

        <div className="px-5 pb-4">
          <ConsoleTable
            head={
              <>
                <ConsoleTh>Operator</ConsoleTh>
                <ConsoleTh>Status</ConsoleTh>
                <ConsoleTh>Role</ConsoleTh>
                <ConsoleTh align="right">Last signed in</ConsoleTh>
                {me?.isOwner ? <ConsoleTh align="right">Actions</ConsoleTh> : null}
              </>
            }
          >
            {rows.map((row) => (
              <tr key={row.id}>
                <ConsoleTd>
                  <span className="font-medium">{row.full_name}</span>
                  {row.id === me?.operatorId ? (
                    <span className="ml-2 text-[0.75rem]" style={{ color: '#64748b' }}>
                      (you)
                    </span>
                  ) : null}
                  <div className="mt-0.5 text-[0.75rem]" style={{ color: '#64748b' }}>
                    {row.email}
                  </div>
                </ConsoleTd>
                <ConsoleTd>
                  <ConsoleBadge value={row.status} />
                  {row.invite_pending ? (
                    <div className="mt-1 text-[0.75rem]" style={{ color: '#64748b' }}>
                      invitation outstanding
                    </div>
                  ) : null}
                </ConsoleTd>
                <ConsoleTd muted>{row.is_owner ? 'Owner' : 'Operator'}</ConsoleTd>
                <ConsoleTd align="right" muted>
                  {row.last_login_at ? new Date(row.last_login_at).toLocaleDateString() : 'never'}
                </ConsoleTd>
                {me?.isOwner ? (
                  <ConsoleTd align="right">
                    {row.status === 'suspended' ? (
                      <ConsoleButton onClick={() => void setOperatorStatus(row.id, 'active')}>
                        Reinstate
                      </ConsoleButton>
                    ) : row.status === 'active' ? (
                      <ConsoleButton
                        variant="danger"
                        onClick={() => void setOperatorStatus(row.id, 'suspended')}
                      >
                        Suspend
                      </ConsoleButton>
                    ) : (
                      <span className="text-[0.8125rem]" style={{ color: '#475569' }}>
                        —
                      </span>
                    )}
                  </ConsoleTd>
                ) : null}
              </tr>
            ))}
          </ConsoleTable>
        </div>
      </ConsoleCard>

      {!me?.isOwner ? (
        <p className="mt-4 text-[0.8125rem]" style={{ color: '#475569' }}>
          Only a console owner can invite or suspend operators.
        </p>
      ) : null}
    </>
  );
}
