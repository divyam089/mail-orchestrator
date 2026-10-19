-- Step 7: API keys gain the same roles as users, optional scopes, and a rate limit.
-- Idempotency rows remember the first response for a send or draft POST.

ALTER TABLE api_keys
  ADD COLUMN role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'operator', 'viewer')),
  ADD COLUMN scopes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 600);

COMMENT ON COLUMN api_keys.role IS
  'admin, operator, or viewer. The same three roles as users. A key cannot outrank its role.';
COMMENT ON COLUMN api_keys.scopes IS
  'Empty means every scope the role allows. A non-empty list is the intersection with that role.';

CREATE TABLE api_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id uuid NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_idempotency_once UNIQUE (key_id, idempotency_key)
);

COMMENT ON TABLE api_idempotency IS
  'Replay of Idempotency-Key returns the original JSON. A different body with the same key is a conflict.';
