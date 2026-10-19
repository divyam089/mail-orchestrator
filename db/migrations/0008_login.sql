-- Invite-only sign-in. The raw session id is only in an httpOnly cookie.
-- Magic-link tokens and passwords are stored as hashes.

ALTER TABLE users
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'removed')),
  ADD COLUMN password_hash text,
  ADD COLUMN google_sub text,
  ADD COLUMN last_sign_in_at timestamptz;

ALTER TABLE app_settings
  ADD COLUMN restrict_login_domains boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app_settings.restrict_login_domains IS
  'When true, sign-in and invites are limited to the five Figcel domains.';

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

COMMENT ON TABLE sessions IS
  '12-hour sessions. Sign out everywhere sets revoked_at on every row for that user.';

CREATE TABLE login_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN login_tokens.token_hash IS 'SHA-256 of a magic-link token. The raw token is never stored.';
