-- Figcel Outreach schema.
-- Invariants enforced here, not only in the app:
--   * one contact per normalize_email() address
--   * one enrollment per (campaign, contact)
--   * one prospect send per (contact, campaign, step), including reserved and failed rows
--   * caps cannot exceed 27 per inbox or 405 per day; ramp steps cannot either
--   * approval_mode defaults to review (OFF)
--   * open/click tracking defaults to off
--   * seed tests can only be recorded as seed_test_only
-- A crash after a send row is inserted cannot insert that step again.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Email identity. Keep in lockstep with src/lib/email/normalize.ts.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION literal_email(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  s text;
  local_part text;
  domain_part text;
  at_pos int;
BEGIN
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;
  s := regexp_replace(raw, E'^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$', '', 'g');
  IF s = '' THEN
    RETURN NULL;
  END IF;
  IF s ~ '<[^<>]+>[[:space:]]*$' THEN
    s := regexp_replace(substring(s FROM '<([^<>]+)>[[:space:]]*$'), E'^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$', '', 'g');
  END IF;
  IF s IS NULL OR s = '' OR s ~ '[^[:ascii:]]' THEN
    RETURN NULL;
  END IF;
  s := lower(s);
  IF right(s, 1) = '.' THEN
    s := left(s, length(s) - 1);
  END IF;
  IF s = '' OR length(s) > 254 OR s ~ '[[:space:]]' THEN
    RETURN NULL;
  END IF;
  IF length(s) - length(replace(s, '@', '')) <> 1 THEN
    RETURN NULL;
  END IF;
  at_pos := position('@' IN s);
  local_part := substring(s FROM 1 FOR at_pos - 1);
  domain_part := substring(s FROM at_pos + 1);
  IF local_part = '' OR domain_part = ''
     OR length(local_part) > 64 OR length(domain_part) > 253 THEN
    RETURN NULL;
  END IF;
  IF local_part !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+$' THEN
    RETURN NULL;
  END IF;
  IF domain_part !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' THEN
    RETURN NULL;
  END IF;
  IF domain_part !~ '\.[a-z]{2,}$' THEN
    RETURN NULL;
  END IF;
  RETURN local_part || '@' || domain_part;
END;
$fn$;

CREATE OR REPLACE FUNCTION normalize_email(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  lit text;
  local_part text;
  domain_part text;
  plus_pos int;
BEGIN
  lit := literal_email(raw);
  IF lit IS NULL THEN
    RETURN NULL;
  END IF;
  local_part := split_part(lit, '@', 1);
  domain_part := split_part(lit, '@', 2);
  IF domain_part IN ('gmail.com', 'googlemail.com') THEN
    plus_pos := position('+' IN local_part);
    IF plus_pos > 0 THEN
      local_part := substring(local_part FROM 1 FOR plus_pos - 1);
    END IF;
    local_part := replace(local_part, '.', '');
    IF local_part = '' OR local_part !~ '^[a-z0-9]+$' THEN
      RETURN NULL;
    END IF;
    RETURN local_part || '@gmail.com';
  END IF;
  IF local_part ~ '^\.' OR local_part ~ '\.$' OR position('..' IN local_part) > 0 THEN
    RETURN NULL;
  END IF;
  RETURN lit;
END;
$fn$;

COMMENT ON FUNCTION normalize_email(text) IS
  'Global contact key: trim, lowercase, and Gmail dot/+tag folding for gmail.com and googlemail.com only.';

-- ---------------------------------------------------------------------------
-- Settings. Singleton. Defaults are the safe position.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  elem jsonb;
  n int;
  i int;
  per int;
BEGIN
  IF NEW.max_per_inbox > 27 OR NEW.max_total > 405 THEN
    RAISE EXCEPTION 'caps cannot exceed 27 per inbox and 405 total' USING ERRCODE = '23514';
  END IF;
  IF NEW.new_per_inbox_per_day > NEW.max_per_inbox THEN
    RAISE EXCEPTION 'new_per_inbox_per_day cannot exceed max_per_inbox' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW.ramp) <> 'array' OR jsonb_array_length(NEW.ramp) < 1 THEN
    RAISE EXCEPTION 'ramp must be a non-empty array of [days, per_inbox]' USING ERRCODE = '23514';
  END IF;
  n := jsonb_array_length(NEW.ramp);
  FOR i IN 0 .. n - 1 LOOP
    elem := NEW.ramp -> i;
    IF jsonb_typeof(elem) <> 'array' OR jsonb_array_length(elem) <> 2 THEN
      RAISE EXCEPTION 'ramp step % must be [days, per_inbox]', i USING ERRCODE = '23514';
    END IF;
    IF jsonb_typeof(elem -> 1) <> 'number' THEN
      RAISE EXCEPTION 'ramp per_inbox must be a number' USING ERRCODE = '23514';
    END IF;
    per := (elem ->> 1)::int;
    IF per < 1 OR per > 27 OR per > NEW.max_per_inbox THEN
      RAISE EXCEPTION 'ramp per_inbox % exceeds the cap', per USING ERRCODE = '23514';
    END IF;
    IF elem -> 0 = 'null'::jsonb OR jsonb_typeof(elem -> 0) = 'null' THEN
      IF i <> n - 1 THEN
        RAISE EXCEPTION 'only the last ramp step may be open-ended' USING ERRCODE = '23514';
      END IF;
    ELSIF jsonb_typeof(elem -> 0) <> 'number' OR (elem ->> 0)::int < 1 THEN
      RAISE EXCEPTION 'ramp day counts must be positive' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$fn$;

CREATE TABLE app_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  approval_mode text NOT NULL DEFAULT 'review' CHECK (approval_mode IN ('review', 'auto')),
  legal_name text NOT NULL DEFAULT 'TODO: legal name',
  postal_address text NOT NULL DEFAULT 'TODO: postal address',
  verification_provider text NOT NULL DEFAULT 'TODO: verification provider',
  unsubscribe_https_base text NOT NULL DEFAULT 'TODO: unsubscribe url',
  hosting text NOT NULL DEFAULT 'TODO: hosting',
  max_per_inbox integer NOT NULL DEFAULT 27 CHECK (max_per_inbox BETWEEN 1 AND 27),
  max_total integer NOT NULL DEFAULT 405 CHECK (max_total BETWEEN 1 AND 405),
  new_per_inbox_per_day integer NOT NULL DEFAULT 9 CHECK (new_per_inbox_per_day BETWEEN 1 AND 27),
  ramp jsonb NOT NULL DEFAULT '[[3, 9], [4, 18], [null, 27]]'::jsonb,
  send_window jsonb NOT NULL DEFAULT '{"et_start":"09:00","et_end":"17:00","ist_start":"18:30","ist_end":"06:30"}'::jsonb,
  followup_business_days jsonb NOT NULL DEFAULT '{"2": 3, "3": 7}'::jsonb,
  hard_bounce_pct numeric NOT NULL DEFAULT 2.0,
  hard_bounce_window integer NOT NULL DEFAULT 200,
  seed_min_inbox_pct numeric NOT NULL DEFAULT 80,
  unsub_max_hours integer NOT NULL DEFAULT 24,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER app_settings_guard_trg
  BEFORE INSERT OR UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION app_settings_guard();

COMMENT ON COLUMN app_settings.approval_mode IS
  'review = approval OFF, drafts wait in the review queue. auto = send on schedule. Default review.';
COMMENT ON TABLE app_settings IS
  'SENDING_ENABLED is an environment kill switch, not a column, so a database edit cannot turn sending on.';

CREATE TABLE app_kv (
  k text PRIMARY KEY,
  v text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

COMMENT ON COLUMN api_keys.key_hash IS 'SHA-256 of the key. The raw key is never stored.';

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('ui', 'api', 'system')),
  actor text NOT NULL,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  detail jsonb
);

CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

-- ---------------------------------------------------------------------------
-- Sending domains and inboxes.
-- ---------------------------------------------------------------------------

CREATE TABLE sending_domains (
  domain text PRIMARY KEY,
  dkim_status text NOT NULL DEFAULT 'unknown' CHECK (dkim_status IN ('unknown', 'pass', 'fail')),
  spf_status text NOT NULL DEFAULT 'unknown' CHECK (spf_status IN ('unknown', 'pass', 'fail')),
  dmarc_status text NOT NULL DEFAULT 'unknown' CHECK (dmarc_status IN ('unknown', 'pass', 'fail')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  sender_name text NOT NULL CHECK (length(btrim(sender_name)) > 0),
  domain text NOT NULL REFERENCES sending_domains (domain),
  provider text NOT NULL DEFAULT 'gmail_sa' CHECK (provider IN ('gmail_sa', 'gmail_oauth', 'imap_smtp', 'mock')),
  status text NOT NULL DEFAULT 'not_connected' CHECK (status IN ('not_connected', 'active', 'paused', 'disconnected', 'error')),
  daily_cap integer NOT NULL DEFAULT 27 CHECK (daily_cap BETWEEN 1 AND 27),
  history_id text,
  watch_expiration timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inboxes_email_lower CHECK (email = lower(email)),
  CONSTRAINT inboxes_domain_match CHECK (split_part(email, '@', 2) = domain)
);

CREATE TABLE pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('inbox', 'domain', 'fleet')),
  target text NOT NULL,
  rule text NOT NULL,
  detail text,
  paused_at timestamptz NOT NULL DEFAULT now(),
  resumed_at timestamptz,
  resumed_by text,
  resume_note text
);

CREATE UNIQUE INDEX pauses_one_active ON pauses (scope, target, rule) WHERE resumed_at IS NULL;

CREATE TABLE inbox_health_daily (
  inbox_id uuid NOT NULL REFERENCES inboxes (id),
  et_date date NOT NULL,
  sent_count integer NOT NULL DEFAULT 0,
  hard_bounces integer NOT NULL DEFAULT 0,
  soft_bounces integer NOT NULL DEFAULT 0,
  replies integer NOT NULL DEFAULT 0,
  complaints integer NOT NULL DEFAULT 0,
  cap integer NOT NULL CHECK (cap BETWEEN 1 AND 27),
  PRIMARY KEY (inbox_id, et_date)
);

-- Placement is a seed-test estimate. The check rejects any other measurement label.
CREATE TABLE seed_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES inboxes (id),
  tested_at timestamptz NOT NULL,
  et_date date NOT NULL,
  inbox_placement_pct numeric(5, 2),
  spam_pct numeric(5, 2),
  report_ref text,
  measurement text NOT NULL DEFAULT 'seed_test_only' CHECK (measurement = 'seed_test_only'),
  note text NOT NULL DEFAULT 'Seed-test estimate only. Not measured on real recipients.'
);

COMMENT ON TABLE seed_tests IS
  'Inbox placement is estimable only via seed tests. Never claim real-recipient placement.';

CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  inbox_id uuid REFERENCES inboxes (id),
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Contacts. normalized_email is the global dedupe key.
-- ---------------------------------------------------------------------------

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_email text NOT NULL,
  normalized_email text NOT NULL,
  domain text NOT NULL,
  first_name text,
  last_name text,
  company text,
  title text,
  timezone text,
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_status text NOT NULL DEFAULT 'unknown'
    CHECK (verification_status IN ('unknown', 'pending', 'valid', 'risky', 'invalid', 'hold')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_normalized_email_key UNIQUE (normalized_email),
  CONSTRAINT contacts_email_normalized CHECK (
    normalized_email IS NOT NULL
    AND normalize_email(display_email) IS NOT NULL
    AND normalized_email = normalize_email(display_email)
    AND domain = split_part(normalized_email, '@', 2)
  )
);

CREATE INDEX contacts_domain_idx ON contacts (domain);

CREATE TABLE contact_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  literal_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_aliases_literal_key UNIQUE (literal_email),
  CONSTRAINT contact_aliases_canonical CHECK (
    literal_email IS NOT NULL
    AND literal_email = public.literal_email(literal_email)
  )
);

CREATE INDEX contact_aliases_contact_idx ON contact_aliases (contact_id);

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contact_tags (
  contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE contact_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  body text NOT NULL,
  author text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE suppression (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('email', 'domain')),
  value text NOT NULL,
  reason text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppression_kind_value_key UNIQUE (kind, value),
  CONSTRAINT suppression_value_normalized CHECK (
    (kind = 'email' AND value = normalize_email(value))
    OR (kind = 'domain' AND value = lower(value) AND position('@' IN value) = 0 AND value <> '')
  )
);

CREATE TABLE verification_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('valid', 'risky', 'invalid', 'unknown', 'error')),
  syntax_ok boolean,
  mx_ok boolean,
  is_role boolean,
  is_disposable boolean,
  raw jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX verification_results_contact_idx ON verification_results (contact_id, checked_at DESC);

CREATE TABLE imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('csv', 'paste', 'api', 'ui', 'system')),
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_mappings (
  import_id uuid PRIMARY KEY REFERENCES imports (id) ON DELETE CASCADE,
  mapping jsonb NOT NULL
);

CREATE TABLE import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid REFERENCES imports (id) ON DELETE CASCADE,
  line_number integer,
  raw_email text NOT NULL,
  literal_email text,
  normalized_email text,
  contact_id uuid REFERENCES contacts (id),
  outcome text NOT NULL CHECK (outcome IN ('created', 'duplicate', 'invalid')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_rows_import_idx ON import_rows (import_id);

-- ---------------------------------------------------------------------------
-- Campaigns and sequence enrollment.
-- ---------------------------------------------------------------------------

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  approval_override text CHECK (approval_override IN ('review', 'auto')),
  track_opens boolean NOT NULL DEFAULT false,
  track_clicks boolean NOT NULL DEFAULT false,
  timezone_mode text NOT NULL DEFAULT 'lead' CHECK (timezone_mode IN ('lead', 'et')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN campaigns.track_opens IS
  'Off by default. Tracking pixels hurt plain-text deliverability and Apple Mail Privacy Protection inflates opens.';
COMMENT ON COLUMN campaigns.track_clicks IS
  'Off by default. Redirect links hurt plain-text deliverability. Replies are the primary metric.';
COMMENT ON COLUMN campaigns.approval_override IS
  'Null inherits the global approval toggle. review forces the queue. auto allows schedule sends when the global toggle is also auto.';

CREATE TABLE sequence_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  step_number integer NOT NULL CHECK (step_number >= 1),
  delay_business_days integer NOT NULL DEFAULT 0 CHECK (delay_business_days >= 0),
  CONSTRAINT sequence_steps_campaign_step_key UNIQUE (campaign_id, step_number)
);

CREATE TABLE step_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id uuid NOT NULL REFERENCES sequence_steps (id) ON DELETE CASCADE,
  variant_key text NOT NULL,
  subject_template text,
  body_template text NOT NULL,
  weight integer NOT NULL DEFAULT 1 CHECK (weight > 0),
  CONSTRAINT step_variants_step_key UNIQUE (step_id, variant_key)
);

CREATE TABLE enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE RESTRICT,
  contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'held', 'completed', 'stopped')),
  stop_reason text,
  variant text,
  inbox_id uuid REFERENCES inboxes (id),
  next_step integer NOT NULL DEFAULT 1 CHECK (next_step >= 1),
  thread_id text,
  last_rfc_message_id text,
  references_chain text,
  first_subject text,
  step1_et_date date,
  unsub_token text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrollments_campaign_contact_key UNIQUE (campaign_id, contact_id)
);

CREATE INDEX enrollments_inbox_idx ON enrollments (inbox_id);
CREATE INDEX enrollments_status_idx ON enrollments (status);

-- The sent-log. Reserving a row is the idempotency lock: a retry or a restart
-- inserts nothing and therefore sends nothing. Failed rows stay so the step
-- is not attempted again. Cap queries use sends_counting_toward_cap and skip
-- failed rows, so a failure does not burn another prospect's numeric slot.
CREATE TABLE sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts (id) ON DELETE RESTRICT,
  campaign_id uuid REFERENCES campaigns (id) ON DELETE RESTRICT,
  enrollment_id uuid REFERENCES enrollments (id) ON DELETE RESTRICT,
  step_number integer NOT NULL CHECK (step_number >= 1),
  variant text,
  inbox_id uuid NOT NULL REFERENCES inboxes (id),
  kind text NOT NULL CHECK (kind IN ('prospect', 'seed')),
  seed_address text,
  et_date date NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'sending', 'sent', 'failed')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  gmail_id text,
  thread_id text,
  rfc_message_id text,
  template_ref text,
  error text,
  CONSTRAINT sends_kind_shape CHECK (
    (kind = 'prospect' AND contact_id IS NOT NULL AND campaign_id IS NOT NULL AND seed_address IS NULL)
    OR
    (kind = 'seed' AND seed_address IS NOT NULL AND contact_id IS NULL)
  )
);

CREATE UNIQUE INDEX sends_prospect_once
  ON sends (contact_id, campaign_id, step_number)
  WHERE kind = 'prospect';

CREATE UNIQUE INDEX sends_seed_once_per_day
  ON sends (seed_address, inbox_id, step_number, et_date)
  WHERE kind = 'seed';

CREATE INDEX sends_cap_inbox_day ON sends (inbox_id, et_date) WHERE state IN ('reserved', 'sending', 'sent');
CREATE INDEX sends_cap_day ON sends (et_date) WHERE state IN ('reserved', 'sending', 'sent');

CREATE VIEW sends_counting_toward_cap AS
  SELECT * FROM sends WHERE state IN ('reserved', 'sending', 'sent');

COMMENT ON VIEW sends_counting_toward_cap IS
  'Daily 27/405 accounting. Includes in-flight reserves so a crash cannot free the slot. Excludes failed.';

CREATE TABLE schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  et_date date NOT NULL,
  inbox_id uuid NOT NULL REFERENCES inboxes (id),
  contact_id uuid NOT NULL REFERENCES contacts (id),
  campaign_id uuid NOT NULL REFERENCES campaigns (id),
  enrollment_id uuid NOT NULL REFERENCES enrollments (id),
  step_number integer NOT NULL CHECK (step_number >= 1),
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'sent', 'skipped', 'error')),
  CONSTRAINT schedule_once UNIQUE (et_date, contact_id, campaign_id, step_number)
);

CREATE TABLE review_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES enrollments (id) ON DELETE CASCADE,
  send_id uuid UNIQUE REFERENCES sends (id),
  step_number integer NOT NULL CHECK (step_number >= 1),
  subject text NOT NULL,
  body text NOT NULL,
  inbox_id uuid REFERENCES inboxes (id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'edited', 'approved', 'sent', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  CONSTRAINT review_drafts_enrollment_step_key UNIQUE (enrollment_id, step_number)
);

-- ---------------------------------------------------------------------------
-- Engagement and the mailbox. Opens and clicks are stored only when a campaign
-- has tracking on; the columns default off, and replies remain the metric.
-- ---------------------------------------------------------------------------

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid REFERENCES inboxes (id),
  contact_id uuid REFERENCES contacts (id),
  campaign_id uuid REFERENCES campaigns (id),
  send_id uuid REFERENCES sends (id),
  kind text NOT NULL CHECK (kind IN (
    'reply', 'auto_reply', 'opt_out_reply', 'interested', 'not_now', 'not_interested',
    'hard_bounce', 'soft_bounce', 'unsubscribe', 'complaint', 'provider_error',
    'seed_result', 'blacklist', 'postmaster_warning', 'open', 'click'
  )),
  detail jsonb,
  gmail_message_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  et_date date NOT NULL
);

CREATE UNIQUE INDEX events_gmail_kind ON events (inbox_id, gmail_message_id, kind)
  WHERE gmail_message_id IS NOT NULL AND inbox_id IS NOT NULL;

CREATE INDEX events_campaign_kind_idx ON events (campaign_id, kind);
CREATE INDEX events_occurred_idx ON events (occurred_at DESC);

CREATE TABLE threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES inboxes (id),
  gmail_thread_id text NOT NULL,
  subject text,
  snippet text,
  last_message_at timestamptz,
  contact_id uuid REFERENCES contacts (id),
  campaign_id uuid REFERENCES campaigns (id),
  CONSTRAINT threads_inbox_gmail_key UNIQUE (inbox_id, gmail_thread_id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES inboxes (id),
  thread_row_id uuid REFERENCES threads (id),
  gmail_message_id text NOT NULL,
  rfc_message_id text,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  from_email text,
  from_name text,
  to_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text,
  body_text text,
  body_html text,
  snippet text,
  internal_date timestamptz,
  is_read boolean NOT NULL DEFAULT false,
  is_starred boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  snooze_until timestamptz,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  has_attachments boolean NOT NULL DEFAULT false,
  campaign_id uuid REFERENCES campaigns (id),
  enrollment_id uuid REFERENCES enrollments (id),
  classification text CHECK (
    classification IS NULL OR classification IN ('interested', 'not_now', 'not_interested', 'ooo', 'unsubscribe')
  ),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english'::regconfig,
      coalesce(subject, '') || ' ' || coalesce(body_text, '') || ' ' || coalesce(from_email, '')
    )
  ) STORED,
  CONSTRAINT messages_inbox_gmail_key UNIQUE (inbox_id, gmail_message_id)
);

CREATE INDEX messages_inbox_date_idx ON messages (inbox_id, internal_date DESC);
CREATE INDEX messages_search_idx ON messages USING gin (search_vector);
CREATE INDEX messages_rfc_idx ON messages (rfc_message_id);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  filename text,
  mime_type text,
  size_bytes integer,
  gmail_attachment_id text
);

CREATE TABLE labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid REFERENCES inboxes (id),
  name text NOT NULL,
  gmail_label_id text,
  kind text NOT NULL DEFAULT 'user' CHECK (kind IN ('system', 'user', 'classification')),
  CONSTRAINT labels_inbox_name_key UNIQUE (inbox_id, name)
);

CREATE UNIQUE INDEX labels_global_name_idx ON labels (name) WHERE inbox_id IS NULL;

CREATE TABLE message_labels (
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);

CREATE TABLE reply_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  subject text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE processed_messages (
  inbox_id uuid NOT NULL REFERENCES inboxes (id),
  gmail_message_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inbox_id, gmail_message_id)
);
