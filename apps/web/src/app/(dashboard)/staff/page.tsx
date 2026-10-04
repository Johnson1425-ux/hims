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
import {
  Checkbox,
  Field,
  FieldSet,
  FormDialog,
  Select,
  TextArea,
  useFormErrors,
} from '@/components/ui/forms';
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
  const [notice, setNotice] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);

  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({
    email: '',
    givenName: '',
    familyName: '',
    title: '',
    phone: '',
    role: 'nurse',
    employmentType: 'permanent',
    isProvider: false,
    specialties: '',
    primaryDepartmentId: '',
    licenseNumber: '',
    licenseAuthority: '',
    licenseExpiresOn: '',
    defaultSlotMinutes: '20',
  });

  const [rotaFor, setRotaFor] = useState<StaffMember | null>(null);
  const [rota, setRota] = useState<Array<{ dayOfWeek: number; startTime: string; endTime: string; slotMinutes: string; capacity: string }>>([]);

  const [leaveFor, setLeaveFor] = useState<StaffMember | null>(null);
  const [leave, setLeave] = useState({ startsAt: '', endsAt: '', reason: 'leave', notes: '' });

  const inviteForm = useFormErrors();
  const rotaForm = useFormErrors();
  const leaveForm = useFormErrors();

  /**
   * Invitation, never a password.
   *
   * The account is created in `invited` state with a single-use token and the
   * invitee chooses their own credential. An administrator who never knows a
   * colleague's password cannot act as them, which is what keeps the audit
   * trail attributable to a person rather than to a role.
   */
  async function sendInvite(): Promise<void> {
    inviteForm.reset();

    try {
      await api.post('/staff', {
        email: invite.email,
        fullName: `${invite.title} ${invite.givenName} ${invite.familyName}`.trim(),
        givenName: invite.givenName,
        familyName: invite.familyName,
        title: invite.title || undefined,
        phone: invite.phone || undefined,
        roles: [invite.role],
        employmentType: invite.employmentType,
        isProvider: invite.isProvider,
        specialties: invite.specialties
          ? invite.specialties.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
        primaryDepartmentId: invite.primaryDepartmentId || undefined,
        licenseNumber: invite.licenseNumber || undefined,
        licenseAuthority: invite.licenseAuthority || undefined,
        licenseExpiresOn: invite.licenseExpiresOn || undefined,
        defaultSlotMinutes: Number(invite.defaultSlotMinutes) || 20,
      });

      setInviting(false);
      setNotice({ tone: 'good', text: `Invitation sent to ${invite.email}. They set their own password.` });
      setInvite((current) => ({ ...current, email: '', givenName: '', familyName: '', licenseNumber: '' }));
      await load();
    } catch (caught) {
      inviteForm.capture(caught);
    }
  }

  /**
   * Saving a rota closes off the previous rules rather than deleting them, so
   * an appointment booked under last month's pattern stays explicable.
   */
  async function saveRota(): Promise<void> {
    if (!rotaFor) return;
    rotaForm.reset();

    try {
      await api.put(`/staff/${rotaFor.id}/availability`, {
        rules: rota.map((rule) => ({
          dayOfWeek: rule.dayOfWeek,
          startTime: rule.startTime,
          endTime: rule.endTime,
          slotMinutes: Number(rule.slotMinutes),
          capacity: Number(rule.capacity),
          availabilityKind: 'clinic',
        })),
      });

      setRotaFor(null);
      setNotice({ tone: 'good', text: `Working pattern saved for ${rotaFor.display_name}.` });
    } catch (caught) {
      rotaForm.capture(caught);
    }
  }

  async function recordLeave(): Promise<void> {
    if (!leaveFor) return;
    leaveForm.reset();

    try {
      const { data } = await api.post<{ appointmentsNeedingRebooking: number }>(
        `/staff/${leaveFor.id}/time-off`,
        {
          startsAt: new Date(leave.startsAt).toISOString(),
          endsAt: new Date(leave.endsAt).toISOString(),
          effect: 'unavailable',
          reason: leave.reason,
          notes: leave.notes || undefined,
        },
      );

      const affected = data.appointmentsNeedingRebooking;
      setLeaveFor(null);
      setNotice({
        tone: affected > 0 ? 'critical' : 'good',
        text:
          affected > 0
            ? `Leave recorded — but ${pluralise(affected, 'appointment')} already booked in that window need rebooking. Somebody has to call those patients.`
            : `Leave recorded for ${leaveFor.display_name}.`,
      });
      setLeave({ startsAt: '', endsAt: '', reason: 'leave', notes: '' });
    } catch (caught) {
      leaveForm.capture(caught);
    }
  }

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
            <Button
              variant="primary"
              icon={<IconPlus className="h-4 w-4" />}
              onClick={() => {
                inviteForm.reset();
                setInviting(true);
              }}
            >
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

      {notice ? (
        <div className="mb-5">
          <Alert tone={notice.tone} title={notice.tone === 'good' ? 'Done' : 'Needs attention'}>
            {notice.text}
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
                  {can('schedule:manage') ? (
                    <Th align="right" width="11rem">
                      <span className="sr-only">Schedule</span>
                    </Th>
                  ) : null}
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
                      {can('schedule:manage') ? (
                        <Td align="right">
                          <span className="flex flex-wrap justify-end gap-1.5">
                            {member.is_provider ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  rotaForm.reset();
                                  setRota([
                                    { dayOfWeek: 1, startTime: '08:00', endTime: '16:00', slotMinutes: String(member.default_slot_minutes), capacity: '1' },
                                  ]);
                                  setRotaFor(member);
                                }}
                              >
                                Rota
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                leaveForm.reset();
                                setLeave({ startsAt: '', endsAt: '', reason: 'leave', notes: '' });
                                setLeaveFor(member);
                              }}
                            >
                              Leave
                            </Button>
                          </span>
                        </Td>
                      ) : null}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      <FormDialog
        open={inviting}
        onClose={() => setInviting(false)}
        title="Invite a colleague"
        description="They receive a single-use link and choose their own password — no administrator ever sets one"
        submitLabel="Send the invitation"
        message={inviteForm.message}
        width="44rem"
        disabled={!invite.email || !invite.givenName || !invite.familyName}
        onSubmit={sendInvite}
      >
        <FieldSet legend="Who" columns={2}>
          <Field
            name="givenName"
            label="First name"
            required
            value={invite.givenName}
            error={inviteForm.errors.givenName}
            onChange={(e) => setInvite((i) => ({ ...i, givenName: e.target.value }))}
          />
          <Field
            name="familyName"
            label="Family name"
            required
            value={invite.familyName}
            error={inviteForm.errors.familyName}
            onChange={(e) => setInvite((i) => ({ ...i, familyName: e.target.value }))}
          />
          <Field
            name="title"
            label="Title"
            placeholder="Dr., RN, PharmD"
            value={invite.title}
            error={inviteForm.errors.title}
            onChange={(e) => setInvite((i) => ({ ...i, title: e.target.value }))}
          />
          <Field
            name="email"
            label="Work email"
            type="email"
            required
            hint="Where the invitation goes"
            value={invite.email}
            error={inviteForm.errors.email}
            onChange={(e) => setInvite((i) => ({ ...i, email: e.target.value }))}
          />
          <Field
            name="phone"
            label="Phone"
            type="tel"
            value={invite.phone}
            error={inviteForm.errors.phone}
            onChange={(e) => setInvite((i) => ({ ...i, phone: e.target.value }))}
          />
          <Select
            name="employmentType"
            label="Employment"
            options={['permanent', 'contract', 'locum', 'resident', 'volunteer'].map((v) => ({
              value: v,
              label: humanise(v),
            }))}
            value={invite.employmentType}
            error={inviteForm.errors.employmentType}
            onChange={(e) => setInvite((i) => ({ ...i, employmentType: e.target.value }))}
          />
        </FieldSet>

        <FieldSet
          legend="Role"
          description="The server refuses to grant a role above your own authority, so the list shows what you may delegate."
          columns={2}
        >
          <Select
            name="role"
            label="Role"
            required
            options={(
              ['hospital_admin', 'doctor', 'nurse', 'pharmacist', 'lab_technician', 'receptionist', 'billing_clerk'] as RoleKey[]
            ).map((key) => ({ value: key, label: humanise(key) }))}
            value={invite.role}
            error={inviteForm.errors.roles}
            onChange={(e) => {
              const role = e.target.value;
              setInvite((i) => ({
                ...i,
                role,
                // A clinician is bookable and prescribes; the licence fields
                // below become required at that point, server-side.
                isProvider: role === 'doctor' || i.isProvider,
              }));
            }}
          />
          <Select
            name="primaryDepartmentId"
            label="Department"
            placeholder="Not set"
            options={(tenant?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))}
            value={invite.primaryDepartmentId}
            error={inviteForm.errors.primaryDepartmentId}
            onChange={(e) => setInvite((i) => ({ ...i, primaryDepartmentId: e.target.value }))}
          />
          <div className="sm:col-span-2">
            <Checkbox
              name="isProvider"
              label="Can be booked and can prescribe"
              hint="A clinician profile needs a professional licence number — the server refuses one without it, so it is not caught at the first prescription."
              checked={invite.isProvider}
              onChange={(e) => setInvite((i) => ({ ...i, isProvider: e.target.checked }))}
            />
          </div>
        </FieldSet>

        {invite.isProvider ? (
          <FieldSet legend="Registration" columns={3}>
            <Field
              name="licenseNumber"
              label="Licence number"
              required
              value={invite.licenseNumber}
              error={inviteForm.errors.licenseNumber}
              onChange={(e) => setInvite((i) => ({ ...i, licenseNumber: e.target.value }))}
            />
            <Field
              name="licenseAuthority"
              label="Issued by"
              placeholder="Medical Council of Tanganyika"
              value={invite.licenseAuthority}
              error={inviteForm.errors.licenseAuthority}
              onChange={(e) => setInvite((i) => ({ ...i, licenseAuthority: e.target.value }))}
            />
            <Field
              name="licenseExpiresOn"
              label="Expires"
              type="date"
              hint="Chased at sixty days"
              value={invite.licenseExpiresOn}
              error={inviteForm.errors.licenseExpiresOn}
              onChange={(e) => setInvite((i) => ({ ...i, licenseExpiresOn: e.target.value }))}
            />
            <Field
              name="specialties"
              label="Specialties"
              placeholder="Internal medicine, cardiology"
              hint="Comma separated"
              value={invite.specialties}
              error={inviteForm.errors.specialties}
              onChange={(e) => setInvite((i) => ({ ...i, specialties: e.target.value }))}
            />
            <Field
              name="defaultSlotMinutes"
              label="Default slot (minutes)"
              type="number"
              min={5}
              max={240}
              value={invite.defaultSlotMinutes}
              error={inviteForm.errors.defaultSlotMinutes}
              onChange={(e) => setInvite((i) => ({ ...i, defaultSlotMinutes: e.target.value }))}
            />
          </FieldSet>
        ) : null}
      </FormDialog>

      <FormDialog
        open={rotaFor !== null}
        onClose={() => setRotaFor(null)}
        title="Working pattern"
        description={
          rotaFor
            ? `${rotaFor.display_name} — availability is computed from these rules, so a slot the rota does not cover is never offered`
            : undefined
        }
        submitLabel="Save the pattern"
        message={rotaForm.message}
        width="44rem"
        disabled={rota.length === 0}
        onSubmit={saveRota}
      >
        <Alert tone="info" title="Replacing, not deleting">
          Saving closes off the previous rules rather than removing them, so an appointment booked
          under last month's pattern stays explicable.
        </Alert>

        <div className="flex flex-col gap-3">
          {rota.map((rule, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto_auto_auto]">
              <Select
                name={`day-${index}`}
                label={index === 0 ? 'Day' : undefined}
                options={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                  (day, value) => ({ value: String(value), label: day }),
                )}
                value={String(rule.dayOfWeek)}
                onChange={(e) =>
                  setRota((current) =>
                    current.map((r, i) => (i === index ? { ...r, dayOfWeek: Number(e.target.value) } : r)),
                  )
                }
              />
              <Field
                name={`start-${index}`}
                label={index === 0 ? 'From' : undefined}
                type="time"
                value={rule.startTime}
                onChange={(e) =>
                  setRota((current) => current.map((r, i) => (i === index ? { ...r, startTime: e.target.value } : r)))
                }
              />
              <Field
                name={`end-${index}`}
                label={index === 0 ? 'To' : undefined}
                type="time"
                value={rule.endTime}
                onChange={(e) =>
                  setRota((current) => current.map((r, i) => (i === index ? { ...r, endTime: e.target.value } : r)))
                }
              />
              <Field
                name={`slot-${index}`}
                label={index === 0 ? 'Slot' : undefined}
                type="number"
                min={5}
                value={rule.slotMinutes}
                onChange={(e) =>
                  setRota((current) => current.map((r, i) => (i === index ? { ...r, slotMinutes: e.target.value } : r)))
                }
              />
              <Field
                name={`capacity-${index}`}
                label={index === 0 ? 'Seats' : undefined}
                type="number"
                min={1}
                value={rule.capacity}
                onChange={(e) =>
                  setRota((current) => current.map((r, i) => (i === index ? { ...r, capacity: e.target.value } : r)))
                }
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={index === 0 ? 'mb-1 self-end' : 'self-end'}
                onClick={() => setRota((current) => current.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          ))}

          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setRota((current) => [
                  ...current,
                  { dayOfWeek: 1, startTime: '08:00', endTime: '16:00', slotMinutes: '20', capacity: '1' },
                ])
              }
            >
              Add a day
            </Button>
          </div>
        </div>
      </FormDialog>

      <FormDialog
        open={leaveFor !== null}
        onClose={() => setLeaveFor(null)}
        title="Record time off"
        description={leaveFor ? leaveFor.display_name : undefined}
        submitLabel="Record it"
        message={leaveForm.message}
        disabled={!leave.startsAt || !leave.endsAt}
        onSubmit={recordLeave}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="startsAt"
            label="From"
            type="datetime-local"
            required
            value={leave.startsAt}
            error={leaveForm.errors.startsAt}
            onChange={(e) => setLeave((l) => ({ ...l, startsAt: e.target.value }))}
          />
          <Field
            name="endsAt"
            label="To"
            type="datetime-local"
            required
            value={leave.endsAt}
            error={leaveForm.errors.endsAt}
            onChange={(e) => setLeave((l) => ({ ...l, endsAt: e.target.value }))}
          />
        </div>
        <Select
          name="reason"
          label="Reason"
          options={['leave', 'sick', 'training', 'conference', 'surgery', 'public_holiday', 'other'].map((v) => ({
            value: v,
            label: humanise(v),
          }))}
          value={leave.reason}
          error={leaveForm.errors.reason}
          onChange={(e) => setLeave((l) => ({ ...l, reason: e.target.value }))}
        />
        <TextArea
          name="leaveNotes"
          label="Notes"
          rows={2}
          value={leave.notes}
          error={leaveForm.errors.notes}
          onChange={(e) => setLeave((l) => ({ ...l, notes: e.target.value }))}
        />
        <Alert tone="info" title="Appointments already booked are reported back">
          Any booking inside the window is counted and shown, rather than silently orphaned —
          somebody has to call those patients.
        </Alert>
      </FormDialog>
    </>
  );
}
