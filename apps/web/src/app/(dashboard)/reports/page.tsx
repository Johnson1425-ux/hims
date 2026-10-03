'use client';

import { ModuleScaffold } from '../_module-scaffold';

export default function ReportsPage() {
  return (
    <ModuleScaffold
      title="Reports"
      subtitle="Operational, financial and compliance reporting"
      summary="Every report runs in a READ ONLY transaction, so it cannot mutate a chart however it is written. Clinical, financial and operational reporting are permissioned separately. The accounting-of-disclosures report answers a patient's statutory right to know who opened their record."
      endpoints={[
        { method: 'GET', path: '/api/v1/reports/dashboard', note: 'operational metrics; money hidden without report:financial' },
        { method: 'GET', path: '/api/v1/reports/utilisation', note: 'throughput and no-show rate per clinician' },
        { method: 'GET', path: '/api/v1/reports/revenue', note: 'payer mix, collection rate and denial reasons' },
        { method: 'GET', path: '/api/v1/reports/patient-access-log/:id', note: 'accounting of disclosures (HIPAA §164.528)' },
        { method: 'GET', path: '/api/v1/reports/break-glass-review', note: 'emergency access awaiting privacy review' },
      ]}
    />
  );
}
