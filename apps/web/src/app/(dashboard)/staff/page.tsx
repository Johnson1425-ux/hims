'use client';

import { ModuleScaffold } from '../_module-scaffold';

export default function StaffPage() {
  return (
    <ModuleScaffold
      title="Staff"
      subtitle="Directory, roles, credentials and rota"
      summary="Staff invitation (no administrator ever sets a colleague's password), role assignment with privilege-escalation guards, credential expiry tracking and provider availability are implemented. Rota changes close off old rules rather than deleting them, so existing bookings stay explicable."
      endpoints={[
        { method: 'POST', path: '/api/v1/staff', note: 'invite; refuses to grant a role above the inviter’s own' },
        { method: 'GET', path: '/api/v1/staff', note: 'directory, with licence-expiry flags' },
        { method: 'PUT', path: '/api/v1/staff/:id/availability', note: 'set the weekly working pattern' },
        { method: 'POST', path: '/api/v1/staff/:id/time-off', note: 'record leave; reports affected bookings' },
      ]}
    />
  );
}
