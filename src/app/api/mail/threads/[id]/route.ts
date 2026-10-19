import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getPool } from "@/lib/db/pool";
import { REPLY_CLASSES, type ReplyClass } from "@/lib/mail/classify";
import {
  applyLabel,
  loadThread,
  relabelMessage,
  setThreadArchived,
  setThreadRead,
  setThreadStar,
  setMessageState,
} from "@/lib/mail/mailbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guard(request, "viewer");
  if ("response" in gate) return gate.response;
  const { id } = await context.params;
  try {
    const detail = await loadThread(getPool(), id);
    if (!detail) return NextResponse.json({ error: "thread not found" }, { status: 404 });
    await setThreadRead(getPool(), id, true, gate.user.actor, "ui");
    return NextResponse.json(await loadThread(getPool(), id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the thread";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guard(request, "operator");
  if ("response" in gate) return gate.response;
  const { id } = await context.params;
  const actor = { actor: gate.user.actor, source: "ui" as const };
  const body = (await request.json()) as {
    action?: string;
    starred?: boolean;
    read?: boolean;
    hours?: number;
    name?: string;
    messageId?: string;
    classification?: string;
  };
  const pool = getPool();
  try {
    if (body.action === "archive") {
      await setThreadArchived(pool, id, true, actor.actor, actor.source);
    } else if (body.action === "star") {
      await setThreadStar(pool, id, Boolean(body.starred), actor.actor, actor.source);
    } else if (body.action === "read") {
      await setThreadRead(pool, id, body.read !== false, actor.actor, actor.source);
    } else if (body.action === "snooze") {
      const hours = Number(body.hours ?? 24);
      const until = new Date(Date.now() + hours * 60 * 60 * 1000);
      const detail = await loadThread(pool, id);
      const latest = detail?.messages[detail.messages.length - 1];
      if (!latest) return NextResponse.json({ error: "thread has no message" }, { status: 404 });
      await setMessageState(pool, { messageId: latest.id, snoozeUntil: until, ...actor });
    } else if (body.action === "label") {
      if (!body.name?.trim()) return NextResponse.json({ error: "label name is required" }, { status: 400 });
      const detail = await loadThread(pool, id);
      const latest = detail?.messages[detail.messages.length - 1];
      if (!latest) return NextResponse.json({ error: "thread has no message" }, { status: 404 });
      await applyLabel(pool, { messageId: latest.id, name: body.name, ...actor });
    } else if (body.action === "classify") {
      if (!body.messageId || !body.classification || !REPLY_CLASSES.includes(body.classification as ReplyClass)) {
        return NextResponse.json({ error: "messageId and a known classification are required" }, { status: 400 });
      }
      await relabelMessage(pool, {
        messageId: body.messageId,
        classification: body.classification as ReplyClass,
        ...actor,
      });
    } else {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update the thread";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
