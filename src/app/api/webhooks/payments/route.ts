import { db } from "@/lib/db";
import { validSignature } from "@/lib/webhooks";

export async function POST(request: Request) {
  const body = await request.text();
  const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? "dev-secret";
  if (!validSignature(body, request.headers.get("x-signature") ?? "", secret))
    return new Response("bad signature", { status: 403 });

  const event = JSON.parse(body) as { id: string; type: string };
  // Idempotent: gateways retry, so a repeated event id is acknowledged and ignored.
  const existing = await db.paymentEvent.findUnique({ where: { eventId: event.id } });
  if (existing) return new Response("duplicate");
  await db.paymentEvent.create({ data: { eventId: event.id, eventType: event.type, payload: body } });
  return new Response("ok");
}
