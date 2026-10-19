import { literalEmail, normalizeEmail } from "@/lib/email/normalize";
import type { Db } from "@/lib/db/pool";

export type ImportSource = "csv" | "paste" | "api" | "ui" | "system";

export type ImportResult =
  | {
      ok: true;
      created: boolean;
      contactId: string;
      normalizedEmail: string;
      literalEmail: string;
      aliasAdded: boolean;
      enrollmentCreated: boolean;
    }
  | { ok: false; reason: "invalid_email"; raw: string };

type ContactRow = { id: string };

export async function importContact(
  db: Db,
  input: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    title?: string | null;
    timezone?: string | null;
    custom?: Record<string, unknown>;
    campaignId?: string | null;
    source: ImportSource;
    importId?: string | null;
    lineNumber?: number | null;
  },
): Promise<ImportResult> {
  const literal = literalEmail(input.email);
  const normalized = normalizeEmail(input.email);
  if (!literal || !normalized) {
    if (input.importId) {
      await db.query(
        `INSERT INTO import_rows (import_id, line_number, raw_email, outcome)
         VALUES ($1, $2, $3, 'invalid')`,
        [input.importId, input.lineNumber ?? null, input.email],
      );
    }
    return { ok: false, reason: "invalid_email", raw: input.email };
  }

  const domain = normalized.slice(normalized.indexOf("@") + 1);
  const inserted = await db.query<ContactRow>(
    `INSERT INTO contacts (
       display_email, normalized_email, domain, first_name, last_name, company, title, timezone, custom_fields
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (normalized_email) DO NOTHING
     RETURNING id`,
    [
      literal,
      normalized,
      domain,
      input.firstName ?? null,
      input.lastName ?? null,
      input.company ?? null,
      input.title ?? null,
      input.timezone ?? null,
      JSON.stringify(input.custom ?? {}),
    ],
  );

  let created = inserted.rows.length > 0;
  let contactId = inserted.rows[0]?.id;
  if (!contactId) {
    const existing = await db.query<ContactRow>("SELECT id FROM contacts WHERE normalized_email = $1", [
      normalized,
    ]);
    contactId = existing.rows[0]?.id;
    created = false;
  }
  if (!contactId) {
    throw new Error(`contact insert missed ${normalized}`);
  }

  const alias = await db.query(
    `INSERT INTO contact_aliases (contact_id, literal_email)
     VALUES ($1, $2)
     ON CONFLICT (literal_email) DO NOTHING
     RETURNING id`,
    [contactId, literal],
  );

  let enrollmentCreated = false;
  if (input.campaignId) {
    const enrollment = await db.query(
      `INSERT INTO enrollments (campaign_id, contact_id)
       VALUES ($1, $2)
       ON CONFLICT (campaign_id, contact_id) DO NOTHING
       RETURNING id`,
      [input.campaignId, contactId],
    );
    enrollmentCreated = enrollment.rows.length > 0;
  }

  if (input.importId) {
    await db.query(
      `INSERT INTO import_rows (
         import_id, line_number, raw_email, literal_email, normalized_email, contact_id, outcome
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.importId,
        input.lineNumber ?? null,
        input.email,
        literal,
        normalized,
        contactId,
        created ? "created" : "duplicate",
      ],
    );
  }

  return {
    ok: true,
    created,
    contactId,
    normalizedEmail: normalized,
    literalEmail: literal,
    aliasAdded: alias.rows.length > 0,
    enrollmentCreated,
  };
}
