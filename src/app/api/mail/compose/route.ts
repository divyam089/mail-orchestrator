import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { readSendMode, readSendingEnabled } from "@/lib/gates";
import { MockMailAdapter } from "@/lib/mail/adapter";
import { composeManual, type ComposeMode } from "@/lib/mail/compose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES = new Set<ComposeMode>(["reply", "reply_all", "forward", "new"]);

export async function POST(request: Request) {
  const body = (await request.json()) as {
    inboxEmail?: string;
    mode?: string;
    sourceMessageId?: string;
    to?: string[];
    cc?: string[];
    subject?: string;
    html?: string;
    text?: string;
    attachments?: { filename: string; mimeType: string; contentBase64: string }[];
    clientToken?: string;
  };
  if (!body.inboxEmail || !body.mode || !MODES.has(body.mode as ComposeMode)) {
    return NextResponse.json({ error: "inboxEmail and mode are required" }, { status: 400 });
  }
  try {
    const result = await composeManual(getPool(), {
      inboxEmail: body.inboxEmail,
      mode: body.mode as ComposeMode,
      sourceMessageId: body.sourceMessageId,
      to: body.to ?? [],
      cc: body.cc,
      subject: body.subject ?? "",
      html: body.html ?? "",
      text: body.text,
      attachments: body.attachments,
      clientToken: body.clientToken,
      actor: "operator",
      source: "ui",
      sendingEnabled: readSendingEnabled(),
      sendMode: readSendMode(),
      adapter: new MockMailAdapter(),
    });
    return NextResponse.json({ outcome: result.outcome, reason: result.reason, draftId: result.draftId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Compose failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
