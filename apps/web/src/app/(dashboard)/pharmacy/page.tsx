'use client';

import { ModuleScaffold } from '../_module-scaffold';

export default function PharmacyPage() {
  return (
    <ModuleScaffold
      title="Dispensing"
      subtitle="Prescription queue, safety screening and dispensing"
      summary="Prescribing with allergy and interaction screening, blocking warnings that require a documented override, controlled-substance authority checks, and FEFO batch picking on dispense are implemented and tested. Stock moves only through the append-only ledger."
      endpoints={[
        { method: 'POST', path: '/api/v1/prescriptions/screen', note: 'dry-run the safety checks before committing' },
        { method: 'POST', path: '/api/v1/prescriptions', note: 'issue and sign; refuses blocking warnings without an override' },
        { method: 'GET', path: '/api/v1/prescriptions/queue', note: 'pharmacy worklist, controlled drugs first' },
        { method: 'POST', path: '/api/v1/inventory/dispense', note: 'dispense with first-expiry-first-out batch selection' },
        { method: 'GET', path: '/api/v1/prescriptions/patient/:id', note: 'medication history with refill counts' },
      ]}
    />
  );
}
