import { isUnset } from "@/lib/gates";
import { literalEmail, normalizeEmail } from "@/lib/email/normalize";
import type { Db } from "@/lib/db/pool";
import { withOptionalTransaction } from "@/lib/db/tx";
import type { FieldMapping, LeadRecord } from "@/lib/contacts/parse-leads";
import { decideVerification, type ContactVerdict } from "@/lib/verify/decide";
import { isDisposableDomain } from "@/lib/verify/disposable";
import { lookupMailHost, type DnsResolver, type MxResult } from "@/lib/verify/dns";
import { isRoleAccount } from "@/lib/verify/roles";
import type { VerificationAdapter, VerificationResult } from "@/lib/verify/adapter";

export type ImportSource = "csv" | "paste" | "api" | "ui" | "system";

export type DedupeBucket = "new" | "duplicate_in_file" | "already_in_system" | "invalid" | "suppressed";

export type ImportResult =
  | {
      ok: true;
      created: boolean;
      contactId: string;
      normalizedEmail: string;
      literalEmail: string;
      aliasAdded: boolean;
    }
  | { ok: false; reason: "invalid_email"; raw: string };

export type ImportReportRow = {
  lineNumber: number;
  raw: string;
  bucket: DedupeBucket;
  contactId: string | null;
  normalizedEmail: string | null;
  literalEmail: string | null;
  verificationStatus: StoredVerification | null;
  enrolled: boolean;
  held: boolean;
  detail: string;
};

export type ImportReport = {
  importId: string;
  counts: Record<DedupeBucket, number>;
  rows: ImportReportRow[];
};

const MAX_RECORDS = 5_000;

type StoredVerification = ContactVerdict | "pending" | "hold";

type ContactHit = { id: string; verification_status: StoredVerification };

type Policy = { treatMxPassAsValid: boolean; provider: string };

function emptyCounts(): Record<DedupeBucket, number> {
  return { new: 0, duplicate_in_file: 0, already_in_system: 0, invalid: 0, suppressed: 0 };
}

function domainOf(normalized: string): string {
  return normalized.slice(normalized.indexOf("@") + 1);
}

function outcomeFor(bucket: DedupeBucket): string {
  if (bucket === "new") return "created";
  return bucket;
}

async function loadPolicy(db: Db): Promise<Policy> {
  const result = await db.query<{ treat_mx_pass_as_valid: boolean; verification_provider: string }>(
    "SELECT treat_mx_pass_as_valid, verification_provider FROM app_settings WHERE id = 1",
  );
  const row = result.rows[0];
  if (!row) throw new Error("app_settings is missing. Seed did not run.");
  return { treatMxPassAsValid: row.treat_mx_pass_as_valid, provider: row.verification_provider };
}

async function suppressedReason(db: Db, normalized: string): Promise<string | null> {
  const email = await db.query<{ reason: string }>(
    "SELECT reason FROM suppression WHERE kind = 'email' AND value = $1",
    [normalized],
  );
  if (email.rows[0]) return email.rows[0].reason;
  const domain = domainOf(normalized);
  const labels = domain.split(".");
  const candidates: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) candidates.push(labels.slice(i).join("."));
  const domainHit = await db.query<{ value: string; reason: string }>(
    "SELECT value, reason FROM suppression WHERE kind = 'domain' AND value = ANY($1::text[])",
    [candidates],
  );
  if (domainHit.rows[0]) return `domain ${domainHit.rows[0].value}: ${domainHit.rows[0].reason}`;
  return null;
}

async function upsertContact(
  db: Db,
  input: {
    literal: string;
    normalized: string;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    title?: string | null;
    timezone?: string | null;
  },
): Promise<{ created: boolean; contactId: string; aliasAdded: boolean; verificationStatus: StoredVerification }> {
  const domain = domainOf(input.normalized);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO contacts (
       display_email, normalized_email, domain, first_name, last_name, company, title, timezone
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (normalized_email) DO NOTHING
     RETURNING id`,
    [
      input.literal,
      input.normalized,
      domain,
      input.firstName ?? null,
      input.lastName ?? null,
      input.company ?? null,
      input.title ?? null,
      input.timezone ?? null,
    ],
  );
  const created = inserted.rows.length > 0;
  let contactId = inserted.rows[0]?.id;
  let verificationStatus: StoredVerification = "unknown";
  if (!contactId) {
    const existing = await db.query<ContactHit>(
      "SELECT id, verification_status FROM contacts WHERE normalized_email = $1",
      [input.normalized],
    );
    contactId = existing.rows[0]?.id;
    verificationStatus = existing.rows[0]?.verification_status ?? "unknown";
  }
  if (!contactId) throw new Error(`contact insert missed ${input.normalized}`);

  if (!created) {
    await db.query(
      `UPDATE contacts SET
         first_name = COALESCE(first_name, $2),
         last_name = COALESCE(last_name, $3),
         company = COALESCE(company, $4),
         title = COALESCE(title, $5),
         timezone = COALESCE(timezone, $6),
         updated_at = now()
       WHERE id = $1`,
      [
        contactId,
        input.firstName ?? null,
        input.lastName ?? null,
        input.company ?? null,
        input.title ?? null,
        input.timezone ?? null,
      ],
    );
  }

  const alias = await db.query(
    `INSERT INTO contact_aliases (contact_id, literal_email)
     VALUES ($1, $2)
     ON CONFLICT (literal_email) DO NOTHING
     RETURNING id`,
    [contactId, input.literal],
  );
  return { created, contactId, aliasAdded: alias.rows.length > 0, verificationStatus };
}

async function mergeCustom(db: Db, contactId: string, custom: Record<string, string> | undefined): Promise<void> {
  if (!custom || Object.keys(custom).length === 0) return;
  await db.query(
    `UPDATE contacts
     SET custom_fields = custom_fields || COALESCE((
       SELECT jsonb_object_agg(e.key, e.value)
       FROM jsonb_each($2::jsonb) AS e
       WHERE NOT (contacts.custom_fields ? e.key)
     ), '{}'::jsonb)
     WHERE id = $1`,
    [contactId, JSON.stringify(custom)],
  );
}

async function applyTags(db: Db, contactId: string, tags: string[]): Promise<void> {
  for (const tag of tags) {
    const row = await db.query<{ id: string }>(
      `INSERT INTO tags (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [tag],
    );
    await db.query(
      `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [contactId, row.rows[0].id],
    );
  }
}

async function findContact(db: Db, normalized: string): Promise<ContactHit | null> {
  const result = await db.query<ContactHit>(
    "SELECT id, verification_status FROM contacts WHERE normalized_email = $1",
    [normalized],
  );
  return result.rows[0] ?? null;
}

function keepStatus(current: StoredVerification, mx: MxResult, next: ContactVerdict): StoredVerification {
  if (next === "invalid") return "invalid";
  // A missing provider, or a DNS timeout, must not undo a valid result.
  if (current === "valid" && next === "unknown") return "valid";
  if (mx.state === "unknown" && current !== "unknown" && current !== "pending") return current;
  return next;
}

async function storeVerification(
  db: Db,
  input: {
    contactId: string;
    current: StoredVerification;
    isNew: boolean;
    mx: MxResult;
    role: boolean;
    disposable: boolean;
    provider: VerificationResult | null;
    treatMxPassAsValid: boolean;
    providerLabel: string;
  },
): Promise<StoredVerification> {
  const verdict = decideVerification({
    mx: input.mx,
    role: input.role,
    disposable: input.disposable,
    provider: input.provider,
    treatMxPassAsValid: input.treatMxPassAsValid,
  });
  const status = input.isNew ? verdict.status : keepStatus(input.current, input.mx, verdict.status);
  await db.query("UPDATE contacts SET verification_status = $2, updated_at = now() WHERE id = $1", [
    input.contactId,
    status,
  ]);
  await db.query(
    `INSERT INTO verification_results (
       contact_id, provider, status, syntax_ok, mx_ok, is_role, is_disposable, raw
     ) VALUES ($1, $2, $3, true, $4, $5, $6, $7::jsonb)`,
    [
      input.contactId,
      input.provider?.provider ?? input.providerLabel,
      input.provider?.status ?? verdict.status,
      input.mx.state === "unknown" ? null : input.mx.state === "pass",
      input.role,
      input.disposable,
      JSON.stringify({
        mx: input.mx,
        reason: verdict.reason,
        contactStatus: status,
        treatMxPassAsValid: input.treatMxPassAsValid,
      }),
    ],
  );
  return status;
}

async function enrollIfValid(db: Db, contactId: string, campaignId: string | null, status: StoredVerification): Promise<boolean> {
  if (status !== "valid" || !campaignId) return false;
  const enrollment = await db.query(
    `INSERT INTO enrollments (campaign_id, contact_id)
     VALUES ($1, $2)
     ON CONFLICT (campaign_id, contact_id) DO NOTHING
     RETURNING id`,
    [campaignId, contactId],
  );
  return enrollment.rows.length > 0;
}

async function holdIfNeeded(
  db: Db,
  contactId: string,
  campaignId: string | null,
  status: StoredVerification,
  reason: string,
): Promise<boolean> {
  if (status !== "risky" && status !== "unknown") return false;
  const existing = await db.query(
    `SELECT status FROM verification_holds
     WHERE contact_id = $1 AND campaign_id IS NOT DISTINCT FROM $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [contactId, campaignId],
  );
  if (existing.rows[0]) return existing.rows[0].status === "pending";
  await db.query(
    `INSERT INTO verification_holds (contact_id, campaign_id, verification_status, reason)
     VALUES ($1, $2, $3, $4)`,
    [contactId, campaignId, status, reason],
  );
  return true;
}

async function writeImportRow(
  db: Db,
  importId: string,
  row: ImportReportRow,
): Promise<void> {
  await db.query(
    `INSERT INTO import_rows (
       import_id, line_number, raw_email, literal_email, normalized_email, contact_id, outcome, detail
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      importId,
      row.lineNumber,
      row.raw,
      row.literalEmail,
      row.normalizedEmail,
      row.contactId,
      outcomeFor(row.bucket),
      row.detail,
    ],
  );
}

/**
 * Stores one contact. Does not verify, enroll, or call DNS.
 * The first display fields win. Later literals are kept as aliases.
 */
export async function importContact(
  db: Db,
  input: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    title?: string | null;
    timezone?: string | null;
    custom?: Record<string, string>;
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
        `INSERT INTO import_rows (import_id, line_number, raw_email, outcome, detail)
         VALUES ($1, $2, $3, 'invalid', 'Not an email address')`,
        [input.importId, input.lineNumber ?? null, input.email],
      );
    }
    return { ok: false, reason: "invalid_email", raw: input.email };
  }

  const saved = await upsertContact(db, {
    literal,
    normalized,
    firstName: input.firstName,
    lastName: input.lastName,
    company: input.company,
    title: input.title,
    timezone: input.timezone,
  });
  await mergeCustom(db, saved.contactId, input.custom);

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
        saved.contactId,
        saved.created ? "created" : "already_in_system",
      ],
    );
  }

  return {
    ok: true,
    created: saved.created,
    contactId: saved.contactId,
    normalizedEmail: normalized,
    literalEmail: literal,
    aliasAdded: saved.aliasAdded,
  };
}

function cleanTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const tag of tags ?? []) {
    const name = tag.trim().toLowerCase().replace(/\s+/g, " ");
    if (!name || name.length > 64 || seen.has(name)) continue;
    seen.add(name);
    cleaned.push(name);
  }
  return cleaned;
}

/**
 * CSV, paste, and the function an API route calls.
 * One contact per normalized address. Aliases keep the other spellings.
 * Only a valid contact is enrolled. Risky and unknown contacts go on the hold list.
 */
export async function importLeads(
  db: Db,
  input: {
    source: ImportSource;
    label?: string | null;
    records: LeadRecord[];
    mapping?: FieldMapping | null;
    tags?: string[];
    campaignId?: string | null;
    resolver: DnsResolver;
    adapter?: VerificationAdapter | null;
    treatMxPassAsValid?: boolean;
  },
): Promise<ImportReport> {
  if (input.records.length > MAX_RECORDS) {
    throw new Error(`Import is limited to ${MAX_RECORDS} rows.`);
  }
  const tags = cleanTags(input.tags);
  return withOptionalTransaction(db, async (tx) => {
    const policy = await loadPolicy(tx);
    const treatMxPassAsValid = input.treatMxPassAsValid ?? policy.treatMxPassAsValid;
    const providerLabel = isUnset(policy.provider) ? "TODO: verification provider" : policy.provider;
    const createdImport = await tx.query<{ id: string }>(
      "INSERT INTO imports (source, label) VALUES ($1, $2) RETURNING id",
      [input.source, input.label ?? null],
    );
    const importId = createdImport.rows[0].id;
    await tx.query("INSERT INTO import_mappings (import_id, mapping) VALUES ($1, $2::jsonb)", [
      importId,
      JSON.stringify({ mapping: input.mapping ?? null, tags, campaignId: input.campaignId ?? null }),
    ]);

    const counts = emptyCounts();
    const rows: ImportReportRow[] = [];
    const seen = new Map<string, { contactId: string; status: StoredVerification }>();

    for (const record of input.records) {
      const literal = literalEmail(record.email);
      const normalized = normalizeEmail(record.email);
      if (!literal || !normalized) {
        const row: ImportReportRow = {
          lineNumber: record.lineNumber,
          raw: record.email,
          bucket: "invalid",
          contactId: null,
          normalizedEmail: null,
          literalEmail: null,
          verificationStatus: null,
          enrolled: false,
          held: false,
          detail: "Not an email address",
        };
        counts.invalid += 1;
        rows.push(row);
        await writeImportRow(tx, importId, row);
        continue;
      }

      const blocked = await suppressedReason(tx, normalized);
      if (blocked) {
        const row: ImportReportRow = {
          lineNumber: record.lineNumber,
          raw: record.email,
          bucket: "suppressed",
          contactId: null,
          normalizedEmail: normalized,
          literalEmail: literal,
          verificationStatus: null,
          enrolled: false,
          held: false,
          detail: blocked,
        };
        counts.suppressed += 1;
        rows.push(row);
        await writeImportRow(tx, importId, row);
        continue;
      }

      const earlier = seen.get(normalized);
      if (earlier) {
        const saved = await upsertContact(tx, { ...record, literal, normalized });
        await mergeCustom(tx, saved.contactId, record.custom);
        await applyTags(tx, saved.contactId, tags);
        const row: ImportReportRow = {
          lineNumber: record.lineNumber,
          raw: record.email,
          bucket: "duplicate_in_file",
          contactId: saved.contactId,
          normalizedEmail: normalized,
          literalEmail: literal,
          verificationStatus: earlier.status,
          enrolled: false,
          held: earlier.status === "risky" || earlier.status === "unknown",
          detail: "Already listed earlier in this import",
        };
        counts.duplicate_in_file += 1;
        rows.push(row);
        await writeImportRow(tx, importId, row);
        continue;
      }

      const existing = await findContact(tx, normalized);
      const saved = await upsertContact(tx, { ...record, literal, normalized });
      await mergeCustom(tx, saved.contactId, record.custom);
      await applyTags(tx, saved.contactId, tags);

      const mailDomain = literal.slice(literal.indexOf("@") + 1);
      const mx = await lookupMailHost(mailDomain, input.resolver);
      let provider: VerificationResult | null = null;
      if (input.adapter) provider = await input.adapter.verify(literal);
      else if (!isUnset(policy.provider)) {
        provider = {
          provider: policy.provider,
          status: "unknown",
          reason: `${policy.provider} is named, but no verification adapter is installed`,
        };
      }
      const status = await storeVerification(tx, {
        contactId: saved.contactId,
        current: existing?.verification_status ?? "unknown",
        isNew: !existing,
        mx,
        role: isRoleAccount(literal),
        disposable: isDisposableDomain(mailDomain),
        provider,
        treatMxPassAsValid,
        providerLabel,
      });
      const verdict = decideVerification({
        mx,
        role: isRoleAccount(literal),
        disposable: isDisposableDomain(mailDomain),
        provider,
        treatMxPassAsValid,
      });
      const enrolled = await enrollIfValid(tx, saved.contactId, input.campaignId ?? null, status);
      const held = await holdIfNeeded(tx, saved.contactId, input.campaignId ?? null, status, verdict.reason);
      const bucket: DedupeBucket = existing ? "already_in_system" : status === "invalid" ? "invalid" : "new";
      seen.set(normalized, { contactId: saved.contactId, status });
      const row: ImportReportRow = {
        lineNumber: record.lineNumber,
        raw: record.email,
        bucket,
        contactId: saved.contactId,
        normalizedEmail: normalized,
        literalEmail: literal,
        verificationStatus: status,
        enrolled,
        held,
        detail: verdict.reason,
      };
      counts[bucket] += 1;
      rows.push(row);
      await writeImportRow(tx, importId, row);
    }

    return { importId, counts, rows };
  });
}
