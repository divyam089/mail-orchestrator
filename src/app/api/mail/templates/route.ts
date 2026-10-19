import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getPool } from "@/lib/db/pool";
import { listTemplates, saveTemplate } from "@/lib/mail/mailbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await guard(request, "viewer");
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await listTemplates(getPool()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not list templates";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = await guard(request, "operator");
  if ("response" in gate) return gate.response;
  const body = (await request.json()) as { name?: string; subject?: string; body?: string };
  if (!body.name?.trim() || !body.body?.trim()) {
    return NextResponse.json({ error: "name and body are required" }, { status: 400 });
  }
  try {
    const id = await saveTemplate(getPool(), {
      name: body.name,
      subject: body.subject,
      body: body.body,
      actor: gate.user.actor,
      source: "ui",
    });
    return NextResponse.json({ id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save the template";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
