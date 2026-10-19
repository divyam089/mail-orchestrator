-- Step 6: live dashboard. Row changes append a cursor the SSE stream can replay
-- after a dropped connection. NOTIFY fires only after the writing transaction commits.

CREATE TABLE dashboard_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  happened_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE dashboard_events IS
  'Append-only cursor for the dashboard SSE stream. A reconnect sends every row after Last-Event-ID.';

CREATE OR REPLACE FUNCTION dashboard_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_id bigint;
  entity_id text;
BEGIN
  entity_id := COALESCE(NEW.id::text, OLD.id::text);
  INSERT INTO dashboard_events (topic, entity, entity_id, payload)
  VALUES (TG_TABLE_NAME, TG_TABLE_NAME, entity_id, jsonb_build_object('op', TG_OP))
  RETURNING id INTO new_id;
  PERFORM pg_notify('dashboard', new_id::text);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER sends_dashboard
  AFTER INSERT OR UPDATE ON sends
  FOR EACH ROW EXECUTE FUNCTION dashboard_notify();

CREATE TRIGGER events_dashboard
  AFTER INSERT OR UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION dashboard_notify();

CREATE TRIGGER review_drafts_dashboard
  AFTER INSERT OR UPDATE ON review_drafts
  FOR EACH ROW EXECUTE FUNCTION dashboard_notify();

CREATE TRIGGER pauses_dashboard
  AFTER INSERT OR UPDATE ON pauses
  FOR EACH ROW EXECUTE FUNCTION dashboard_notify();

CREATE TRIGGER alerts_dashboard
  AFTER INSERT ON alerts
  FOR EACH ROW EXECUTE FUNCTION dashboard_notify();

CREATE TRIGGER schedule_dashboard
  AFTER INSERT OR UPDATE ON schedule
  FOR EACH ROW EXECUTE FUNCTION dashboard_notify();

CREATE TRIGGER suppression_dashboard
  AFTER INSERT ON suppression
  FOR EACH ROW EXECUTE FUNCTION dashboard_notify();

ALTER TABLE inboxes ADD COLUMN warmup_status text;
ALTER TABLE inboxes ADD COLUMN warmup_source text
  CHECK (warmup_source IS NULL OR warmup_source IN ('manual', 'provider'));

COMMENT ON COLUMN inboxes.warmup_status IS
  'Manual or provider-reported warmup. Null means TODO: warmup provider. No vendor is connected.';

CREATE TRIGGER inboxes_dashboard
  AFTER UPDATE OF status, last_sync_at, last_error, warmup_status, warmup_source ON inboxes
  FOR EACH ROW EXECUTE FUNCTION dashboard_notify();
