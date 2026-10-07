'use client';

/**
 * Facilities and departments: the hospital's own shape, made editable.
 *
 * Before this existed the settings screen rendered both as read-only tables
 * and the only thing that ever created one was the database seed — so a
 * hospital that opened a second site had no way to say so.
 *
 * NOTHING HERE DELETES, and that is the central decision rather than a missing
 * feature. A facility is the foreign key on appointments, encounters, invoices
 * and stock locations; a department on rotas, orders and the utilisation
 * report. Removing one would either take clinical history with it or quietly
 * null out the site a consultation happened in, and "which hospital was this"
 * is not a question a medical record may stop answering. So a site CLOSES: it
 * stops being offered for new work and keeps explaining the old. The copy
 * says so, because "Close" next to a list of rows reads like "Delete" unless
 * something tells the user otherwise.
 *
 * The lists are loaded here rather than taken from `useTenant()`, which holds
 * the active-only arrays that feed pickers across the app. Administration
 * needs the closed rows too.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
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
import { Checkbox, Field, FieldSet, FormDialog, Select, TextArea, useFormErrors } from '@/components/ui/forms';
import { TimezoneSelect, cityOf, detectTimezone } from '@/components/ui/timezone-select';
import { IconSettings } from '@/components/layout/icons';
import { api, type DepartmentRecord, type FacilityRecord } from '@/lib/api';
import { humanise } from '@/lib/format';

const FACILITY_KINDS = [
  { value: 'hospital', label: 'Hospital' },
  { value: 'clinic', label: 'Clinic' },
  { value: 'lab', label: 'Laboratory' },
  { value: 'pharmacy', label: 'Pharmacy' },
  { value: 'imaging', label: 'Imaging centre' },
];

/* ---------------------------------------------------------------------------
 * Loading both lists
 * ------------------------------------------------------------------------- */

interface OrgState {
  facilities: FacilityRecord[];
  departments: DepartmentRecord[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  reload: () => void;
}

/**
 * Both lists, always fetched together.
 *
 * They are coupled: a department form needs the facility list to offer a site,
 * and closing a site changes what the department table should say. Fetching
 * them separately would let the two disagree on screen.
 *
 * `includeInactive` is always true here. The alternative — refetching when the
 * user ticks "show closed" — would mean a spinner for a filter the browser can
 * apply instantly, and the whole list is a few dozen rows.
 */
function useOrgStructure(): OrgState {
  const [facilities, setFacilities] = useState<FacilityRecord[]>([]);
  const [departments, setDepartments] = useState<DepartmentRecord[]>([]);
  const [status, setStatus] = useState<OrgState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const [f, d] = await Promise.all([
          api.get<FacilityRecord[]>('/tenant/facilities', { includeInactive: true }, controller.signal),
          api.get<DepartmentRecord[]>('/tenant/departments', { includeInactive: true }, controller.signal),
        ]);

        setFacilities(f.data);
        setDepartments(d.data);
        setStatus('ready');
        setError(null);
      } catch {
        if (controller.signal.aborted) return;
        setStatus('error');
        setError('The facility and department lists could not be loaded.');
      }
    })();

    return () => controller.abort();
  }, [token]);

  return { facilities, departments, status, error, reload };
}

/* ---------------------------------------------------------------------------
 * Facility form
 * ------------------------------------------------------------------------- */

interface FacilityForm {
  name: string;
  code: string;
  kind: string;
  timezone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string;
}

const emptyFacility = (country: string, timezone: string): FacilityForm => ({
  name: '',
  code: '',
  kind: 'clinic',
  timezone,
  addressLine1: '',
  addressLine2: '',
  city: '',
  region: '',
  postalCode: '',
  country,
  phone: '',
});

const facilityToForm = (facility: FacilityRecord): FacilityForm => ({
  name: facility.name,
  code: facility.code,
  kind: facility.kind,
  timezone: facility.timezone ?? '',
  addressLine1: facility.address_line1 ?? '',
  addressLine2: facility.address_line2 ?? '',
  city: facility.city ?? '',
  region: facility.region ?? '',
  postalCode: facility.postal_code ?? '',
  country: facility.country,
  phone: facility.phone ?? '',
});

/**
 * An empty text field means "clear this", which is `null` on the wire — not
 * `""`, and not omitted. Omitting it would mean "leave it alone", so a user who
 * deleted an address would watch it come back.
 */
const nullable = (value: string) => (value.trim() === '' ? null : value.trim());

function facilityPayload(form: FacilityForm) {
  return {
    name: form.name.trim(),
    code: form.code.trim(),
    kind: form.kind,
    timezone: nullable(form.timezone),
    addressLine1: nullable(form.addressLine1),
    addressLine2: nullable(form.addressLine2),
    city: nullable(form.city),
    region: nullable(form.region),
    postalCode: nullable(form.postalCode),
    country: form.country.trim(),
    phone: nullable(form.phone),
  };
}

function FacilityDialog({
  open,
  facility,
  defaults,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Absent means "create". */
  facility: FacilityRecord | null;
  defaults: { country: string; timezone: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const form = useFormErrors();
  const [values, setValues] = useState<FacilityForm>(() => emptyFacility(defaults.country, ''));

  // Re-seeded each time the dialog opens, so editing one site and then
  // adding another does not inherit the first one's address.
  useEffect(() => {
    if (!open) return;
    form.reset();
    setValues(facility ? facilityToForm(facility) : emptyFacility(defaults.country, ''));
  }, [open, facility, defaults.country]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof FacilityForm>(key: K, value: FacilityForm[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  const submit = async () => {
    form.reset();

    try {
      if (facility) {
        await api.patch(`/tenant/facilities/${facility.id}`, facilityPayload(values));
      } else {
        await api.post('/tenant/facilities', facilityPayload(values));
      }
      onSaved();
      onClose();
    } catch (caught) {
      form.capture(caught);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={facility ? `Edit ${facility.name}` : 'Add a site'}
      description={
        facility
          ? 'Codes appear in references already issued, so change one only deliberately'
          : 'A site holds its own appointments, stock and staff assignments'
      }
      submitLabel={facility ? 'Save site' : 'Add site'}
      width="42rem"
      message={form.message}
      disabled={values.name.trim().length < 2 || values.code.trim().length < 2}
      onSubmit={submit}
    >
      <FieldSet legend="Identity" columns={2}>
        <Field
          name="name"
          label="Name"
          required
          value={values.name}
          error={form.errors.name}
          hint="Shown wherever a site has to be chosen"
          onChange={(event) => set('name', event.target.value)}
        />
        <Field
          name="code"
          label="Code"
          required
          value={values.code}
          error={form.errors.code}
          hint="Two to sixteen characters. Stored upper case."
          onChange={(event) => set('code', event.target.value)}
        />
        <Select
          name="kind"
          label="Kind"
          value={values.kind}
          error={form.errors.kind}
          options={FACILITY_KINDS}
          onChange={(event) => set('kind', event.target.value)}
        />
        <TimezoneSelect
          name="facilityTimezone"
          label="Timezone"
          value={values.timezone}
          error={form.errors.timezone}
          placeholder={`Same as the hospital (${cityOf(defaults.timezone)})`}
          hint="Set this only for a site in a different zone — appointment times there are rendered in it"
          onChange={(value) => set('timezone', value)}
        />
      </FieldSet>

      <FieldSet legend="Where it is" description="Printed on invoices and used on referral letters." columns={2}>
        <Field
          name="addressLine1"
          label="Address"
          value={values.addressLine1}
          error={form.errors.addressLine1}
          onChange={(event) => set('addressLine1', event.target.value)}
        />
        <Field
          name="addressLine2"
          label="Address line 2"
          value={values.addressLine2}
          error={form.errors.addressLine2}
          onChange={(event) => set('addressLine2', event.target.value)}
        />
        <Field
          name="city"
          label="City"
          value={values.city}
          error={form.errors.city}
          onChange={(event) => set('city', event.target.value)}
        />
        <Field
          name="region"
          label="Region"
          value={values.region}
          error={form.errors.region}
          onChange={(event) => set('region', event.target.value)}
        />
        <Field
          name="postalCode"
          label="Postal code"
          value={values.postalCode}
          error={form.errors.postalCode}
          onChange={(event) => set('postalCode', event.target.value)}
        />
        <Field
          name="country"
          label="Country"
          value={values.country}
          error={form.errors.country}
          hint="Two-letter ISO code, e.g. TZ"
          maxLength={2}
          onChange={(event) => set('country', event.target.value.toUpperCase())}
        />
        <Field
          name="phone"
          label="Phone"
          value={values.phone}
          error={form.errors.phone}
          onChange={(event) => set('phone', event.target.value)}
        />
      </FieldSet>
    </FormDialog>
  );
}

/* ---------------------------------------------------------------------------
 * Department form
 * ------------------------------------------------------------------------- */

function DepartmentDialog({
  open,
  department,
  facilities,
  onClose,
  onSaved,
}: {
  open: boolean;
  department: DepartmentRecord | null;
  facilities: FacilityRecord[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const form = useFormErrors();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!open) return;
    form.reset();
    setName(department?.name ?? '');
    setCode(department?.code ?? '');
    setFacilityId(department?.facility_id ?? '');
    setDescription(department?.description ?? '');
  }, [open, department]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Only OPEN sites are offered, plus whichever site this department already
   * points at even if that one has closed — otherwise editing the name of a
   * department at a closed site would silently move it to "whole hospital".
   */
  const siteOptions = useMemo(() => {
    const options = facilities
      .filter((facility) => facility.is_active || facility.id === department?.facility_id)
      .map((facility) => ({
        value: facility.id,
        label: facility.is_active ? facility.name : `${facility.name} (closed)`,
      }));

    return options;
  }, [facilities, department?.facility_id]);

  const submit = async () => {
    form.reset();

    const payload = {
      name: name.trim(),
      code: code.trim(),
      facilityId: facilityId === '' ? null : facilityId,
      description: nullable(description),
    };

    try {
      if (department) {
        await api.patch(`/tenant/departments/${department.id}`, payload);
      } else {
        await api.post('/tenant/departments', payload);
      }
      onSaved();
      onClose();
    } catch (caught) {
      form.capture(caught);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={department ? `Edit ${department.name}` : 'Add a department'}
      description="Departments route appointments, group rotas and split the utilisation report"
      submitLabel={department ? 'Save department' : 'Add department'}
      message={form.message}
      disabled={name.trim().length < 2 || code.trim().length < 2}
      onSubmit={submit}
    >
      <Field
        name="departmentName"
        label="Name"
        required
        value={name}
        error={form.errors.name}
        onChange={(event) => setName(event.target.value)}
      />
      <Field
        name="departmentCode"
        label="Code"
        required
        value={code}
        error={form.errors.code}
        hint="Two to sixteen characters. Stored upper case."
        onChange={(event) => setCode(event.target.value)}
      />
      <Select
        name="facilityId"
        label="Site"
        value={facilityId}
        error={form.errors.facilityId}
        placeholder="The whole hospital"
        options={siteOptions}
        hint="Leave unset for a department that is not tied to one site, such as medical records"
        onChange={(event) => setFacilityId(event.target.value)}
      />
      <TextArea
        name="description"
        label="Description"
        rows={3}
        value={description}
        error={form.errors.description}
        onChange={(event) => setDescription(event.target.value)}
      />
    </FormDialog>
  );
}

/* ---------------------------------------------------------------------------
 * Close / reopen
 * ------------------------------------------------------------------------- */

interface Closing {
  kind: 'facility' | 'department';
  id: string;
  name: string;
  /** Rows that point at this one and will be left dangling or orphaned. */
  attached: number;
}

function CloseDialog({
  target,
  onClose,
  onDone,
}: {
  target: Closing | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const form = useFormErrors();

  useEffect(() => {
    if (target) form.reset();
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!target) return;
    form.reset();

    try {
      const path = target.kind === 'facility' ? 'facilities' : 'departments';
      await api.patch(`/tenant/${path}/${target.id}`, { isActive: false });
      onDone();
      onClose();
    } catch (caught) {
      form.capture(caught);
    }
  };

  const isFacility = target?.kind === 'facility';

  return (
    <FormDialog
      open={target !== null}
      onClose={onClose}
      title={isFacility ? `Close ${target?.name}?` : `Close ${target?.name}?`}
      submitLabel={isFacility ? 'Close this site' : 'Close this department'}
      submitTone="danger"
      message={form.message}
      onSubmit={submit}
    >
      <Alert tone="info" title="Nothing is deleted">
        {isFacility
          ? 'Appointments, encounters, invoices and stock recorded at this site keep pointing at it, so the history stays readable. It simply stops being offered for new work, and you can reopen it at any time.'
          : 'Encounters, orders and invoices already filed against this department keep pointing at it. It stops being offered for new work, and you can reopen it at any time.'}
      </Alert>

      {target && target.attached > 0 ? (
        <Alert tone="warning" title={isFacility ? 'This site still has departments' : 'Staff are assigned here'}>
          {isFacility
            ? `${target.attached} open ${target.attached === 1 ? 'department is' : 'departments are'} attached to this site. They stay open and keep pointing at a closed site, which looks odd in the rota — close or move them too.`
            : `${target.attached} ${target.attached === 1 ? 'person has' : 'people have'} this as their primary department. Their profile keeps the link; reassign them from the staff screen.`}
        </Alert>
      ) : null}
    </FormDialog>
  );
}

/* ---------------------------------------------------------------------------
 * The two cards
 * ------------------------------------------------------------------------- */

/** A closed row is dimmed rather than hidden, so the table reads at a glance. */
const closedRowClass = (isActive: boolean) => (isActive ? undefined : 'opacity-60');

export function OrgStructure({
  editable,
  tenantTimezone,
  onChanged,
}: {
  editable: boolean;
  /** Shown as what an unset facility timezone resolves to. */
  tenantTimezone: string;
  /** Called after any successful write, so the app-wide tenant cache reloads. */
  onChanged: () => void;
}) {
  const org = useOrgStructure();

  const [showClosedSites, setShowClosedSites] = useState(false);
  const [showClosedDepartments, setShowClosedDepartments] = useState(false);

  const [facilityDialog, setFacilityDialog] = useState<{ open: boolean; facility: FacilityRecord | null }>({
    open: false,
    facility: null,
  });
  const [departmentDialog, setDepartmentDialog] = useState<{
    open: boolean;
    department: DepartmentRecord | null;
  }>({ open: false, department: null });
  const [closing, setClosing] = useState<Closing | null>(null);

  const saved = useCallback(() => {
    org.reload();
    onChanged();
  }, [org, onChanged]);

  const reopen = useCallback(
    async (kind: 'facility' | 'department', id: string) => {
      const path = kind === 'facility' ? 'facilities' : 'departments';
      await api.patch(`/tenant/${path}/${id}`, { isActive: true });
      saved();
    },
    [saved],
  );

  const visibleFacilities = org.facilities.filter((f) => showClosedSites || f.is_active);
  const visibleDepartments = org.departments.filter((d) => showClosedDepartments || d.is_active);

  const closedSiteCount = org.facilities.filter((f) => !f.is_active).length;
  const closedDepartmentCount = org.departments.filter((d) => !d.is_active).length;
  const openSiteCount = org.facilities.length - closedSiteCount;

  /** A new site is most likely in the same country and zone as an existing one. */
  const facilityDefaults = useMemo(() => {
    const reference = org.facilities.find((f) => f.is_active) ?? org.facilities[0];
    return {
      country: reference?.country ?? 'TZ',
      timezone: tenantTimezone || detectTimezone() || 'UTC',
    };
  }, [org.facilities, tenantTimezone]);

  if (org.status === 'loading') {
    return (
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton height={260} />
        <Skeleton height={260} />
      </div>
    );
  }

  if (org.status === 'error') {
    return (
      <Card>
        <Alert tone="critical" title="Facilities and departments could not be loaded">
          {org.error ?? 'Please try again.'}
        </Alert>
      </Card>
    );
  }

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        {/* ---- Facilities ------------------------------------------------- */}
        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader
              title="Facilities"
              subtitle="Sites this hospital operates. Appointments, stock and staff assignments are held per site."
              action={
                editable ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setFacilityDialog({ open: true, facility: null })}
                  >
                    Add site
                  </Button>
                ) : null
              }
            />

            {closedSiteCount > 0 ? (
              <div className="mb-3">
                <Checkbox
                  name="showClosedSites"
                  label={`Show ${closedSiteCount} closed ${closedSiteCount === 1 ? 'site' : 'sites'}`}
                  checked={showClosedSites}
                  onChange={(event) => setShowClosedSites(event.target.checked)}
                />
              </div>
            ) : null}
          </div>

          {visibleFacilities.length === 0 ? (
            <EmptyState
              icon={<IconSettings />}
              title="No sites yet"
              description={
                editable
                  ? 'Add the main hospital building first. Registration, booking and stock all need a site to point at.'
                  : 'A hospital administrator has not added one yet.'
              }
            />
          ) : (
            <div className="px-5 pb-1">
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Kind</Th>
                    <Th>Timezone</Th>
                    {editable ? <Th align="right">Actions</Th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visibleFacilities.map((facility) => (
                    <Tr key={facility.id} className={closedRowClass(facility.is_active)}>
                      <Td className="font-medium" style={{ color: 'var(--ink)' }}>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span>{facility.name}</span>
                          {!facility.is_active ? <Badge tone="neutral">Closed</Badge> : null}
                        </div>
                        <div className="mt-0.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                          <span className="tabular">{facility.code}</span>
                          {facility.city ? ` · ${facility.city}` : ''}
                          {Number(facility.active_department_count) > 0
                            ? ` · ${facility.active_department_count} dept`
                            : ''}
                        </div>
                      </Td>
                      <Td>
                        <Badge tone="neutral" dot>
                          {humanise(facility.kind)}
                        </Badge>
                      </Td>
                      {/* The city alone, with the IANA name on hover: the column
                          is narrow and "Africa/" is the same on every row. */}
                      <Td style={{ color: 'var(--ink-muted)' }}>
                        {facility.timezone ? (
                          <span title={facility.timezone}>{cityOf(facility.timezone)}</span>
                        ) : (
                          <span title={`Follows the hospital setting (${tenantTimezone})`}>
                            {cityOf(tenantTimezone)}
                            <span className="block text-[0.75rem]">follows hospital</span>
                          </span>
                        )}
                      </Td>
                      {editable ? (
                        <Td align="right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setFacilityDialog({ open: true, facility })}
                            >
                              Edit
                            </Button>
                            {facility.is_active ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={openSiteCount <= 1}
                                title={
                                  openSiteCount <= 1
                                    ? 'The only open site cannot be closed — add another first'
                                    : undefined
                                }
                                onClick={() =>
                                  setClosing({
                                    kind: 'facility',
                                    id: facility.id,
                                    name: facility.name,
                                    attached: Number(facility.active_department_count),
                                  })
                                }
                              >
                                Close
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void reopen('facility', facility.id)}
                              >
                                Reopen
                              </Button>
                            )}
                          </div>
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>

        {/* ---- Departments ------------------------------------------------ */}
        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader
              title="Departments"
              subtitle="Used for routing, rotas and the utilisation report."
              action={
                editable ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={org.facilities.length === 0}
                    title={org.facilities.length === 0 ? 'Add a site first' : undefined}
                    onClick={() => setDepartmentDialog({ open: true, department: null })}
                  >
                    Add department
                  </Button>
                ) : null
              }
            />

            {closedDepartmentCount > 0 ? (
              <div className="mb-3">
                <Checkbox
                  name="showClosedDepartments"
                  label={`Show ${closedDepartmentCount} closed`}
                  checked={showClosedDepartments}
                  onChange={(event) => setShowClosedDepartments(event.target.checked)}
                />
              </div>
            ) : null}
          </div>

          {visibleDepartments.length === 0 ? (
            <EmptyState
              icon={<IconSettings />}
              title="No departments yet"
              description={
                editable
                  ? 'Add the ones that take appointments first — they are what the booking screen routes to.'
                  : 'A hospital administrator has not added one yet.'
              }
            />
          ) : (
            <div className="px-5 pb-1">
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Code</Th>
                    <Th>Site</Th>
                    {editable ? <Th align="right">Actions</Th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visibleDepartments.map((department) => (
                    <Tr key={department.id} className={closedRowClass(department.is_active)}>
                      <Td className="font-medium" style={{ color: 'var(--ink)' }}>
                        <div className="flex items-center gap-2">
                          <span>{department.name}</span>
                          {!department.is_active ? <Badge tone="neutral">Closed</Badge> : null}
                        </div>
                        {Number(department.staff_count) > 0 ? (
                          <div className="mt-0.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                            {department.staff_count} staff
                          </div>
                        ) : null}
                      </Td>
                      <Td className="tabular" style={{ color: 'var(--ink-muted)' }}>
                        {department.code}
                      </Td>
                      <Td style={{ color: 'var(--ink-muted)' }}>
                        {department.facility_name ?? 'Whole hospital'}
                        {department.facility_name && department.facility_is_active === false
                          ? ' (closed)'
                          : ''}
                      </Td>
                      {editable ? (
                        <Td align="right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDepartmentDialog({ open: true, department })}
                            >
                              Edit
                            </Button>
                            {department.is_active ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setClosing({
                                    kind: 'department',
                                    id: department.id,
                                    name: department.name,
                                    attached: Number(department.staff_count),
                                  })
                                }
                              >
                                Close
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void reopen('department', department.id)}
                              >
                                Reopen
                              </Button>
                            )}
                          </div>
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      <FacilityDialog
        open={facilityDialog.open}
        facility={facilityDialog.facility}
        defaults={facilityDefaults}
        onClose={() => setFacilityDialog({ open: false, facility: null })}
        onSaved={saved}
      />

      <DepartmentDialog
        open={departmentDialog.open}
        department={departmentDialog.department}
        facilities={org.facilities}
        onClose={() => setDepartmentDialog({ open: false, department: null })}
        onSaved={saved}
      />

      <CloseDialog target={closing} onClose={() => setClosing(null)} onDone={saved} />
    </>
  );
}
