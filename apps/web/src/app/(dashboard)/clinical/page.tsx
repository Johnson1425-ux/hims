'use client';

import { ModuleScaffold } from '../_module-scaffold';

export default function ClinicalPage() {
  return (
    <ModuleScaffold
      title="Encounters"
      subtitle="Clinical documentation, vitals and amendments"
      summary="Encounter creation, SOAP documentation with per-section encryption, electronic signing, formal amendments and NEWS2 scoring are all implemented server-side. A signed note is locked by a database trigger, so corrections must be filed as amendments."
      endpoints={[
        { method: 'POST', path: '/api/v1/encounters', note: 'open an encounter; establishes a care relationship' },
        { method: 'PATCH', path: '/api/v1/encounters/:id', note: 'author the SOAP narrative (encrypted per section)' },
        { method: 'POST', path: '/api/v1/encounters/:id/sign', note: 'attest and lock; hashes the clinical content' },
        { method: 'POST', path: '/api/v1/encounters/:id/amendments', note: 'file a correction against a signed note' },
        { method: 'POST', path: '/api/v1/encounters/vitals', note: 'record observations; computes BMI and NEWS2, escalates at 5+' },
        { method: 'GET', path: '/api/v1/encounters/patient/:id', note: 'chart timeline, decrypted for the care team' },
      ]}
    />
  );
}
