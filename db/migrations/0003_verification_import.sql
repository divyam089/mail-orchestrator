-- Step 3: owner policy for MX-only acceptance, a hold list, and import outcomes.

ALTER TABLE app_settings
  ADD COLUMN treat_mx_pass_as_valid boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app_settings.treat_mx_pass_as_valid IS
  'Default false. When true, and the verification provider is still TODO, an address that passes syntax and MX and is not a role or disposable domain is stored as valid. When false, that address stays unknown and is held.';

ALTER TABLE import_rows DROP CONSTRAINT import_rows_outcome_check;

ALTER TABLE import_rows
  ADD CONSTRAINT import_rows_outcome_check
  CHECK (outcome IN (
    'created',
    'duplicate',
    'duplicate_in_file',
    'already_in_system',
    'invalid',
    'suppressed'
  ));

ALTER TABLE import_rows
  ADD COLUMN detail text;

CREATE TABLE verification_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  verification_status text NOT NULL CHECK (verification_status IN ('unknown', 'risky')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text
);

CREATE UNIQUE INDEX verification_holds_one_pending
  ON verification_holds (contact_id, campaign_id) NULLS NOT DISTINCT
  WHERE status = 'pending';

CREATE INDEX verification_holds_contact_idx ON verification_holds (contact_id, created_at DESC);

COMMENT ON TABLE verification_holds IS
  'risky and unknown contacts wait here. Only an approve action marks the contact valid and may enroll them. Approve and reject are written to audit_log.';
