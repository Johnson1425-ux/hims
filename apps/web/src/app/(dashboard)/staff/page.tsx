'use client';

/**
 * Staff directory.
 *
 * Licence expiry is the column this screen exists for. A clinician whose
 * registration lapses cannot lawfully prescribe, and the way that is usually
 * discovered is mid-clinic, when the prescription is refused. Sixty days is
 * the server's warning window, and anything inside it is sorted to the top
 * regardless of alphabet.
 *
 * Roles are shown, never edited here. Granting a role is a privilege-
 * escalation decision the server guards — it refuses to grant a role above the
 * granter's own — and a directory row is the wrong place to make one.
 */
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/layout/shell';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
  type Tone,
} from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import { useTenant } from '@/lib/tenant';
import { api, ApiError, type RoleKey, type StaffMember } from '@/lib/api';
import { formatDate, formatRelative, humanise, pluralise } from '@/lib/format';
import { IconStaff, IconSearch, IconPlus } from '@/components/layout/icons';

/** Clinical roles read differently from administrative ones, so they look it. */
const ROLE_TONE: Partial<Record<RoleKey, Tone>> = {
  hospital_admin: 'serious',
  doctor: 'info',
  nurse: 'good',
  pharmacist: 'info',
  lab_technician: 'neutral',
  receptionist: 'neutral',
  billing_clerk: 'neutral',
  platform_admin: 'critical',
};

function licenceState(member: StaffMember): { tone: Tone; label: string } | null {
  if (!member.license_expires_on) return null;

  const days = Math.round(
    (new Date(member.license_expires_on).getTime() - Date.now()) / 86_400_000,
  );

  if (days < 0) return { tone: 'critical', label: `Lapsed ${Math.abs(days)}d ago` };
  if (days <= 30) return { tone: 'critical', label: `Expires in ${days}d` };
  if (days <= 60) return { tone: 'warning', label: `Expires in ${days}d` };
  return { tone: 'good', label: formatDate(member.license_expires_on) };
}

export default function StaffPage() {
  const { can } = useSession();
  const { tenant } = useTenant();
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);

      try {
        const { data } = await api.get<StaffMember[]>(
          '/staff',
          {
            q: query.trim() || undefined,
            role: role || undefined,
            departmentId: departmentId || undefined,
            includeInactive: includeInactive ? 'true' : undefined,
            pageSize: 100,
          },
          signal,
        );

        // A lapsing licence outranks the alphabet: it is the one thing on this
        // screen with a deadline attached.
        setMembers(
          [...data].sort((a, b) => {
            const weight = (m: StaffMember) =>
              m.license_expires_on === null ? 2 : m.licence_expiring_soon ? 0 : 1;
            return weight(a) - weight(b) || a.family_name.localeCompare(b.family_name);
          }),
        );
      } catch (caught) {
        if (caught instanceof ApiError) setError(caught.message);
      } finally {
        setLoading(false);
      }
    },
    [query, role, departmentId, includeInactive],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [load]);

  const lapsing = members.filter((m) => m.licence_expiring_soon);
  const providers = members.filter((m) => m.is_provider);
  const pendingInvites = members.filter((m) => m.account_status === 'invited');

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle="Directory, roles, credentials and account state"
        actions={
          can('staff:write') ? (
            <Button variant="primary" icon={<IconPlus className="h-4 w-4" />}>
              Invite a colleague
            </Button>
          ) : null
        }
      />

      {lapsing.length > 0 ? (
        <div className="mb-5">
          <Alert tone="warning" title={`${pluralise(lapsing.length, 'licence')} expiring within 60 days`}>
            {lapsing.map((m) => m.display_name).join(', ')} — a clinician cannot prescribe on a
            lapsed registration, and the prescription is refused at the point of care rather than
            at the point of expiry.
          </Alert>
        </div>
      ) : null}

      <section aria-label="Staff summary" className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="On the directory" value={members.length} emphasis />
        <StatTile label="Clinicians" value={providers.length} hint="Can be booked and can prescribe" />
        <StatTile
          label="Licences expiring"
          value={lapsing.length}
          tone={lapsing.length > 0 ? 'warning' : 'good'}
          hint="Within 60 days"
        />
        <StatTile
          label="Invitations open"
          value={pendingInvites.length}
          tone={pendingInvites.length > 0 ? 'info' : 'neutral'}
          hint="Yet to set their own password"
        />
      </section>

      <Card padded={false}>
        <div
          className="flex flex-wrap items-end gap-3 p-4"
          style={{ borderBottom: '1px solid var(--line)' }}
        >
          <div className="min-w-[14rem] flex-1">
            <Input
              name="staff-search"
              label="Find a colleague"
              placeholder="Name"
              leading={<IconSearch className="h-4 w-4" />}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div>
            <label
              htmlFor="role-filter"
              className="mb-1.5 block text-[0.8125rem] font-medium"
              style={{ color: 'var(--ink-secondary)' }}
            >
              Role
            </label>
            <select
              id="role-filter"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              className="h-9.5 rounded-[var(--radius-md)] px-3 text-[0.875rem]"
              style={{
                background: 'var(--surface)',
                color: 'var(--ink)',
                border: '1px solid var(--line-strong)',
              }}
            >
              <option value="">Every role</option>
              {(
                [
                  'hospital_admin',
                  'doctor',
                  'nurse',
                  'pharmacist',
                  'lab_technician',
                  'receptionist',
                  'billing_clerk',
                ] as RoleKey[]
              ).map((key) => (
                <option key={key} value={key}>
                  {humanise(key)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="dept-filter"
              className="mb-1.5 block text-[0.8125rem] font-medium"
              style={{ color: 'var(--ink-secondary)' }}
            >
              Department
            </label>
            <select
              id="dept-filter"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
              className="h-9.5 rounded-[var(--radius-md)] px-3 text-[0.875rem]"
              style={{
                background: 'var(--surface)',
                color: 'var(--ink)',
                border: '1px solid var(--line-strong)',
              }}
            >
              <option value="">Every department</option>
              {(tenant?.departments ?? []).map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </div>

          <label
            className="flex items-center gap-2 pb-2 text-[0.8125rem]"
            style={{ color: 'var(--ink-secondary)' }}
          >
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
              className="h-4 w-4"
            />
            Include former staff
          </label>
        </div>

        {error ? (
          <div className="p-4">
            <p className="text-[0.875rem]" style={{ color: 'var(--critical-ink)' }}>
              {error}
            </p>
          </div>
        ) : loading && members.length === 0 ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={48} />
            ))}
          </div>
        ) : members.length === 0 ? (
          <EmptyState icon={<IconStaff />} title="Nobody matches these filters" />
        ) : (
          <div className="px-5 pb-1">
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Roles</Th>
                  <Th>Department</Th>
                  <Th width="11rem">Licence</Th>
                  <Th align="right">Slot</Th>
                  <Th align="right" width="10rem">
                    Account
                  </Th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const licence = licenceState(member);

                  return (
                    <Tr key={member.id}>
                      <Td>
                        <span className="flex items-center gap-2.5">
                          <Avatar name={member.display_name} />
                          <span>
                            <span className="block font-medium" style={{ color: 'var(--ink)' }}>
                              {member.display_name}
                            </span>
                            <span className="tabular text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                              {member.staff_number}
                              {member.email ? ` · ${member.email}` : ''}
                            </span>
                          </span>
                        </span>
                      </Td>
                      <Td>
                        <span className="flex flex-wrap gap-1.5">
                          {(member.roles ?? []).map((key) => (
                            <Badge key={key} tone={ROLE_TONE[key] ?? 'neutral'} dot>
                              {humanise(key)}
                            </Badge>
                          ))}
                          {(member.roles ?? []).length === 0 ? (
                            <span className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                              No role assigned
                            </span>
                          ) : null}
                        </span>
                        {member.specialties && member.specialties.length > 0 ? (
                          <span className="mt-0.5 block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                            {member.specialties.join(', ')}
                          </span>
                        ) : null}
                      </Td>
                      <Td style={{ color: 'var(--ink-muted)' }}>
                        {member.department_name ?? '—'}
                        {member.facility_name ? (
                          <span className="block text-[0.75rem]">{member.facility_name}</span>
                        ) : null}
                      </Td>
                      <Td>
                        {licence ? (
                          <Badge tone={licence.tone}>{licence.label}</Badge>
                        ) : member.is_provider ? (
                          <Badge tone="critical">None on file</Badge>
                        ) : (
                          <span className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                            Not required
                          </span>
                        )}
                      </Td>
                      <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                        {member.is_provider ? `${member.default_slot_minutes}m` : '—'}
                      </Td>
                      <Td align="right">
                        <Badge
                          tone={
                            !member.is_active
                              ? 'neutral'
                              : member.account_status === 'active'
                                ? 'good'
                                : member.account_status === 'invited'
                                  ? 'info'
                                  : 'warning'
                          }
                        >
                          {!member.is_active ? 'Former staff' : humanise(member.account_status ?? 'no account')}
                        </Badge>
                        {member.last_login_at ? (
                          <span className="mt-0.5 block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                            Seen {formatRelative(member.last_login_at)}
                          </span>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
