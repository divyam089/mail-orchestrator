import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getPool } from "@/lib/db/pool";
import { importLeads } from "@/lib/contacts/import";
import { mapCsv, parsePaste, type FieldMapping } from "@/lib/contacts/parse-leads";
import { createNodeDnsResolver } from "@/lib/verify/node-dns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 1_000_000;

type ImportBody = {
  source?: "csv" | "paste";
  text?: string;
  mapping?: FieldMapping;
  tags?: string[];
  campaignName?: string;
  label?: string;
};

export async function POST(request: Request) {
  const gate = await guard(request, "operator");
  if ("response" in gate) return gate.response;
  let body: ImportBody;
  try {
    body = (await request.json()) as ImportBody;
  } catch {
    return NextResponse.json({ error: "Send JSON with source and text." }, { status: 400 });
  }
  const source = body.source;
  const text = body.text ?? "";
  if (source !== "csv" && source !== "paste") {
    return NextResponse.json({ error: "source must be csv or paste." }, { status: 400 });
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ error: "That import is too large." }, { status: 400 });
  }

  try {
    const records = source === "csv" ? mapCsv(text, body.mapping ?? { email: "email" }) : parsePaste(text);
    const pool = getPool();
    let campaignId: string | null = null;
    const campaignName = body.campaignName?.trim();
    if (campaignName) {
      const created = await pool.query<{ id: string }>(
        "INSERT INTO campaigns (name) VALUES ($1) RETURNING id",
        [campaignName.slice(0, 200)],
      );
      campaignId = created.rows[0].id;
    }
    const report = await importLeads(pool, {
      source,
      label: body.label?.trim() || (source === "csv" ? "CSV import" : "Paste import"),
      records,
      mapping: source === "csv" ? (body.mapping ?? { email: "email" }) : null,
      tags: Array.isArray(body.tags) ? body.tags : [],
      campaignId,
      resolver: createNodeDnsResolver(),
    });
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
