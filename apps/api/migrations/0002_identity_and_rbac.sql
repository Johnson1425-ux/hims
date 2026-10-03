-- =============================================================================
-- 0002  Identity, authentication and Role-Based Access Control
-- -----------------------------------------------------------------------------
-- Permissions are stored as `resource:action` strings and granted to roles;
-- users hold one or more roles. The API resolves a user's effective permission
-- set at login, stamps it into the access token, and re-verifies it per request
-- against the database when the token is older than the permission cache TTL.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Users: every human or service principal that can authenticate.
-- A user belongs to exactly one tenant. `tenant_id IS NULL` marks a platform
-- operator (support engineer) whose access is brokered by break-glass grants.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid REFERENCES tenants(id) ON DELETE CASCADE,
  email                 citext NOT NULL,
  -- Argon2id digest. Never a bare hash of the password.
  password_hash         text,
  full_name             text NOT NULL,
  -- Phone is a direct identifier -> AES-256-GCM ciphertext + HMAC blind index.
  phone_encrypted       bytea,
  phone_blind_index     bytea,
  avatar_url            text,
  status                text NOT NULL DEFAULT 'invited'
                          CHECK (status IN ('invited','active','suspended','deactivated')),
  must_change_password  boolean NOT NULL DEFAULT false,
  mfa_enabled           boolean NOT NULL DEFAULT false,
  mfa_secret_encrypted  bytea,
  mfa_recovery_codes    bytea,
  failed_login_count    integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  password_changed_at   timestamptz,
  last_login_at         timestamptz,
  last_login_ip         inet,
  -- HIPAA §164.312(a)(2)(i): unique user identification + automatic logoff.
  terms_accepted_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
SELECT hims_util.attach_touch_trigger('users');

-- Email is unique per tenant, so the same clinician can hold accounts at two
-- hospital groups. Platform operators (NULL tenant) are globally unique.
CREATE UNIQUE INDEX uq_users_tenant_email
  ON users (tenant_id, email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_users_platform_email
  ON users (email) WHERE tenant_id IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_users_phone_blind_index ON users (phone_blind_index)
  WHERE phone_blind_index IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Roles and permissions
-- -----------------------------------------------------------------------------
-- System roles (tenant_id IS NULL) ship with the product and are immutable.
-- Tenants may clone one into a custom role to fine-tune a permission set.
CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name         text NOT NULL,
  description  text,
  is_system    boolean NOT NULL DEFAULT false,
  -- Lower rank = more authority. Used to stop a user escalating past themselves.
  rank         integer NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('roles');
CREATE UNIQUE INDEX uq_roles_system_key ON roles (key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX uq_roles_tenant_key  ON roles (tenant_id, key) WHERE tenant_id IS NOT NULL;

CREATE TABLE permissions (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z_]+:[a-z_.]+$'),
  resource    text NOT NULL,
  action      text NOT NULL,
  description text NOT NULL,
  -- PHI-touching permissions are audited at ACCESS level, not just WRITE.
  touches_phi boolean NOT NULL DEFAULT false
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

-- A grant with facility_id NULL means "every facility in the tenant". PK columns
-- are implicitly NOT NULL, so this table uses a surrogate key plus two partial
-- unique indexes to keep both the scoped and the global grant unambiguous.
CREATE TABLE user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  -- Optional narrowing: this grant applies only inside one facility.
  facility_id uuid REFERENCES facilities(id) ON DELETE CASCADE,
  granted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);
CREATE UNIQUE INDEX uq_user_roles_scoped
  ON user_roles (user_id, role_id, facility_id) WHERE facility_id IS NOT NULL;
CREATE UNIQUE INDEX uq_user_roles_global
  ON user_roles (user_id, role_id) WHERE facility_id IS NULL;
CREATE INDEX idx_user_roles_user ON user_roles (user_id);

-- -----------------------------------------------------------------------------
-- Sessions: one row per issued refresh token, so a device can be revoked.
-- -----------------------------------------------------------------------------
CREATE TABLE auth_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id          uuid REFERENCES tenants(id) ON DELETE CASCADE,
  -- SHA-256 of the refresh token. A database leak cannot mint sessions.
  refresh_token_hash bytea NOT NULL UNIQUE,
  -- Rotation lineage: replaying a rotated token revokes the whole family.
  parent_session_id  uuid REFERENCES auth_sessions(id) ON DELETE SET NULL,
  user_agent         text,
  ip_address         inet,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text,
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions (expires_at) WHERE revoked_at IS NULL;

-- Single-use, short-lived tokens for invitations, resets and email verification.
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('password_reset','invitation','email_verify','mfa_challenge')),
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_tokens_user_purpose ON auth_tokens (user_id, purpose) WHERE consumed_at IS NULL;

-- -----------------------------------------------------------------------------
-- Seed the permission catalogue
-- -----------------------------------------------------------------------------
INSERT INTO permissions (key, resource, action, description, touches_phi) VALUES
  ('patient:read',         'patient',      'read',         'View patient demographics and chart summary', true),
  ('patient:write',        'patient',      'write',        'Register and update patient records',         true),
  ('patient:delete',       'patient',      'delete',       'Archive a patient record',                    true),
  ('patient:export',       'patient',      'export',       'Export patient data (right of access)',       true),
  ('patient:merge',        'patient',      'merge',        'Merge duplicate patient records',             true),
  ('appointment:read',     'appointment',  'read',         'View appointment calendars',                  true),
  ('appointment:write',    'appointment',  'write',        'Book, reschedule and cancel appointments',    true),
  ('appointment:checkin',  'appointment',  'checkin',      'Check patients in and out at the front desk', true),
  ('schedule:manage',      'schedule',     'manage',       'Define provider availability and blackouts',  false),
  ('encounter:read',       'encounter',    'read',         'Read clinical notes and encounter history',   true),
  ('encounter:write',      'encounter',    'write',        'Author and amend clinical documentation',     true),
  ('encounter:sign',       'encounter',    'sign',         'Legally sign and lock an encounter note',     true),
  ('vitals:write',         'vitals',       'write',        'Record vital signs and intake observations',  true),
  ('prescription:read',    'prescription', 'read',         'View prescriptions and medication history',   true),
  ('prescription:write',   'prescription', 'write',        'Issue and amend prescriptions',               true),
  ('prescription:dispense','prescription', 'dispense',     'Dispense medication against a prescription',  true),
  ('lab_order:read',       'lab_order',    'read',         'View laboratory and imaging orders',          true),
  ('lab_order:write',      'lab_order',    'write',        'Place laboratory and imaging orders',         true),
  ('lab_result:write',     'lab_result',   'write',        'Upload and verify diagnostic results',        true),
  ('invoice:read',         'invoice',      'read',         'View invoices and payment status',            true),
  ('invoice:write',        'invoice',      'write',        'Create and adjust invoices',                  true),
  ('payment:write',        'payment',      'write',        'Record payments and refunds',                 true),
  ('claim:read',           'claim',        'read',         'View insurance claims',                       true),
  ('claim:write',          'claim',        'write',        'Submit and reconcile insurance claims',       true),
  ('inventory:read',       'inventory',    'read',         'View stock levels and medication catalogue',  false),
  ('inventory:write',      'inventory',    'write',        'Adjust stock, receive goods, record wastage', false),
  ('inventory:purchase',   'inventory',    'purchase',     'Raise and approve purchase orders',           false),
  ('staff:read',           'staff',        'read',         'View staff directory and credentials',        false),
  ('staff:write',          'staff',        'write',        'Invite, edit and deactivate staff accounts',  false),
  ('role:manage',          'role',         'manage',       'Create custom roles and assign permissions',  false),
  ('report:clinical',      'report',       'clinical',     'Run clinical and quality reports',            true),
  ('report:financial',     'report',       'financial',    'Run revenue and payer-mix reports',           false),
  ('report:operational',   'report',       'operational',  'Run utilisation and throughput reports',      false),
  ('audit:read',           'audit',        'read',         'Read the tamper-evident audit trail',         true),
  ('tenant:settings',      'tenant',       'settings',     'Change hospital-wide configuration',          false),
  ('portal:self_read',     'portal',       'self_read',    'Read only your own chart (patient portal)',   true),
  ('portal:self_booking',  'portal',       'self_booking', 'Book your own appointments',                  true);

-- System roles. `rank` prevents a Receptionist from granting Admin.
INSERT INTO roles (tenant_id, key, name, description, is_system, rank) VALUES
  (NULL, 'platform_admin', 'Platform Administrator', 'Vendor-side operator; access requires a break-glass grant', true, 0),
  (NULL, 'hospital_admin', 'Hospital Administrator', 'Full administrative control within one tenant',             true, 10),
  (NULL, 'doctor',         'Physician',              'Clinical authority: diagnose, document, prescribe',         true, 20),
  (NULL, 'nurse',          'Nurse',                  'Vitals, triage, care notes, medication administration',     true, 30),
  (NULL, 'pharmacist',     'Pharmacist',             'Dispensing and pharmacy stock control',                     true, 35),
  (NULL, 'lab_technician', 'Laboratory Technician',  'Processes diagnostic orders and uploads results',            true, 40),
  (NULL, 'receptionist',   'Receptionist',           'Front desk: registration, scheduling, check-in',            true, 50),
  (NULL, 'billing_clerk',  'Billing Officer',        'Invoicing, payments and insurance claims',                  true, 55),
  (NULL, 'patient',        'Patient',                'Self-service portal access to their own record',            true, 90);

-- Grant matrix. Deliberately explicit: least privilege beats convenience.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.tenant_id IS NULL AND r.key = 'hospital_admin'
  AND p.key NOT IN ('portal:self_read','portal:self_booking','encounter:sign','prescription:write');

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r CROSS JOIN unnest(ARRAY[
  'patient:read','patient:write','patient:export',
  'appointment:read','appointment:write',
  'encounter:read','encounter:write','encounter:sign','vitals:write',
  'prescription:read','prescription:write',
  'lab_order:read','lab_order:write',
  'invoice:read','report:clinical','inventory:read','staff:read'
]) AS k WHERE r.tenant_id IS NULL AND r.key = 'doctor';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r CROSS JOIN unnest(ARRAY[
  'patient:read','patient:write',
  'appointment:read','appointment:write','appointment:checkin',
  'encounter:read','encounter:write','vitals:write',
  'prescription:read','lab_order:read','lab_order:write',
  'inventory:read','inventory:write','staff:read',
  -- Ward staff run the board: waiting counts and throughput are theirs.
  -- Revenue stays behind report:financial, which they do not hold.
  'report:operational'
]) AS k WHERE r.tenant_id IS NULL AND r.key = 'nurse';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r CROSS JOIN unnest(ARRAY[
  'patient:read','appointment:read',
  'prescription:read','prescription:dispense',
  'inventory:read','inventory:write','inventory:purchase',
  'invoice:read','report:operational'
]) AS k WHERE r.tenant_id IS NULL AND r.key = 'pharmacist';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r CROSS JOIN unnest(ARRAY[
  'patient:read','lab_order:read','lab_result:write','inventory:read','inventory:write'
]) AS k WHERE r.tenant_id IS NULL AND r.key = 'lab_technician';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r CROSS JOIN unnest(ARRAY[
  'patient:read','patient:write',
  'appointment:read','appointment:write','appointment:checkin','schedule:manage',
  'invoice:read','payment:write','report:operational','staff:read'
]) AS k WHERE r.tenant_id IS NULL AND r.key = 'receptionist';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r CROSS JOIN unnest(ARRAY[
  'patient:read','appointment:read',
  'invoice:read','invoice:write','payment:write',
  'claim:read','claim:write','report:financial'
]) AS k WHERE r.tenant_id IS NULL AND r.key = 'billing_clerk';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r CROSS JOIN unnest(ARRAY[
  'portal:self_read','portal:self_booking'
]) AS k WHERE r.tenant_id IS NULL AND r.key = 'patient';
