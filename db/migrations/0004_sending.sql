-- Step 4: sending engine. Caps stay capped. Stop thresholds cannot be loosened
-- without an audited override row.

CREATE TABLE seed_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seed_addresses_email_lower CHECK (email = lower(email) AND position('@' IN email) > 1)
);

COMMENT ON TABLE seed_addresses IS
  'Addresses that seed-only mode is allowed to mail. Placement measured here is seed_test_only.';

CREATE TABLE threshold_overrides (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('ui', 'api', 'system')),
  actor text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  previous jsonb NOT NULL,
  next jsonb NOT NULL
);

COMMENT ON TABLE threshold_overrides IS
  'Required before app_settings stop thresholds may be looser than the shipped defaults.';

ALTER TABLE app_settings
  ADD COLUMN complaint_pause_pct numeric NOT NULL DEFAULT 0.10,
  ADD COLUMN complaint_hard_stop_pct numeric NOT NULL DEFAULT 0.30,
  ADD COLUMN stop_override_id bigint REFERENCES threshold_overrides (id);

COMMENT ON COLUMN app_settings.complaint_pause_pct IS
  'Percent points, matching the reference: 0.10 means 0.10 percent (1 per 1,000), not 10 percent.';
COMMENT ON COLUMN app_settings.complaint_hard_stop_pct IS
  'Percent points. 0.30 means 0.30 percent. A higher number pauses later and is looser.';

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

  IF NEW.stop_override_id IS NULL AND (
    NEW.hard_bounce_pct > 2
    OR NEW.hard_bounce_window > 200
    OR NEW.seed_min_inbox_pct < 80
    OR NEW.unsub_max_hours > 24
    OR NEW.complaint_pause_pct > 0.10
    OR NEW.complaint_hard_stop_pct > 0.30
  ) THEN
    RAISE EXCEPTION 'stop thresholds cannot be looser than defaults without an audited override'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'schedule'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%state%'
  LOOP
    EXECUTE format('ALTER TABLE schedule DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE schedule
  ADD CONSTRAINT schedule_state_check
  CHECK (state IN ('planned', 'drafted', 'sent', 'skipped', 'error'));

COMMENT ON COLUMN schedule.state IS
  'planned is queued to send. drafted is waiting in Review. sent, skipped, and error are terminal.';

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'events'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE events DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE events
  ADD CONSTRAINT events_kind_check
  CHECK (kind IN (
    'reply', 'auto_reply', 'opt_out_reply', 'interested', 'not_now', 'not_interested',
    'hard_bounce', 'soft_bounce', 'unsubscribe', 'complaint', 'provider_error',
    'seed_result', 'blacklist', 'postmaster_warning', 'open', 'click', 'ooo'
  ));
