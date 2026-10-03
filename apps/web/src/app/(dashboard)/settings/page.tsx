'use client';

import { ModuleScaffold } from '../_module-scaffold';

export default function SettingsPage() {
  return (
    <ModuleScaffold
      title="Settings"
      subtitle="Hospital configuration, facilities and departments"
      summary="Tenant configuration, facilities, departments and branding are readable by any signed-in member of staff (the interface needs them to render) and writable with tenant:settings. JSON settings are merged rather than replaced, so a partial update cannot wipe keys it did not send."
      endpoints={[
        { method: 'GET', path: '/api/v1/tenant', note: 'hospital profile, facilities and departments' },
        { method: 'PATCH', path: '/api/v1/tenant', note: 'update configuration and branding (merged)' },
      ]}
    />
  );
}
