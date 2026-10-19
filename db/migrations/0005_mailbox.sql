-- Step 5: mailbox client. Local flag changes are queued for a Gmail modify
-- mirror that stays off unless GMAIL_MIRROR_ENABLED is exactly true.

DROP INDEX IF EXISTS messages_search_idx;
ALTER TABLE messages DROP COLUMN search_vector;
ALTER TABLE messages ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english'::regconfig,
      coalesce(subject, '') || ' ' ||
      coalesce(body_text, '') || ' ' ||
      coalesce(from_email, '') || ' ' ||
      coalesce(from_name, '') || ' ' ||
      coalesce(to_addrs::text, '') || ' ' ||
      coalesce(cc_addrs::text, '')
    )
  ) STORED;
CREATE INDEX messages_search_idx ON messages USING gin (search_vector);
CREATE INDEX messages_snooze_idx ON messages (snooze_until) WHERE snooze_until IS NOT NULL;

COMMENT ON COLUMN messages.search_vector IS
  'English full-text index over sender, recipient, subject, and body.';

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
      AND rel.relname = 'sends'
      AND con.contype = 'c'
      AND (
        pg_get_constraintdef(con.oid) ILIKE '%kind%'
      )
  LOOP
    EXECUTE format('ALTER TABLE sends DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE sends ADD COLUMN client_token text;
CREATE UNIQUE INDEX sends_manual_token ON sends (client_token) WHERE client_token IS NOT NULL;

ALTER TABLE sends ADD CONSTRAINT sends_kind_check CHECK (kind IN ('prospect', 'seed', 'manual'));
ALTER TABLE sends ADD CONSTRAINT sends_kind_shape CHECK (
  (kind = 'prospect' AND contact_id IS NOT NULL AND campaign_id IS NOT NULL AND seed_address IS NULL)
  OR
  (kind = 'seed' AND seed_address IS NOT NULL AND contact_id IS NULL)
  OR
  (kind = 'manual' AND seed_address IS NULL)
);

COMMENT ON COLUMN sends.kind IS
  'manual messages count toward the same 27/405 cap as prospect and seed sends.';

ALTER TABLE review_drafts ALTER COLUMN enrollment_id DROP NOT NULL;
ALTER TABLE review_drafts ADD COLUMN kind text NOT NULL DEFAULT 'sequence' CHECK (kind IN ('sequence', 'manual'));
ALTER TABLE review_drafts ADD COLUMN to_addrs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE review_drafts ADD COLUMN cc_addrs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE review_drafts ADD COLUMN gmail_thread_id text;
ALTER TABLE review_drafts ADD COLUMN in_reply_to text;
ALTER TABLE review_drafts ADD COLUMN references_header text;
ALTER TABLE review_drafts ADD COLUMN compose_mode text CHECK (
  compose_mode IS NULL OR compose_mode IN ('reply', 'reply_all', 'forward', 'new')
);
ALTER TABLE review_drafts ADD COLUMN source_message_id uuid REFERENCES messages (id);
ALTER TABLE review_drafts ADD COLUMN html_body text;
ALTER TABLE review_drafts ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE gmail_mirror_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id uuid NOT NULL REFERENCES inboxes (id),
  gmail_message_id text NOT NULL,
  action text NOT NULL CHECK (action IN (
    'read', 'unread', 'star', 'unstar', 'archive', 'unarchive', 'snooze', 'unsnooze', 'label_add', 'label_remove'
  )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  held_reason text
);

CREATE INDEX gmail_mirror_pending_idx ON gmail_mirror_jobs (inbox_id, gmail_message_id) WHERE applied_at IS NULL;

COMMENT ON TABLE gmail_mirror_jobs IS
  'Local star, read, archive, snooze, and label changes waiting to be mirrored with messages.modify. Held while GMAIL_MIRROR_ENABLED is not true.';
