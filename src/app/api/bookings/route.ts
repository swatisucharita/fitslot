// JSON API used by the member app. Demo only: the real app authenticates members with a token.
import { book, BOOKING_SOURCES, BookingError, type BookingSource } from "@/lib/bookings";
import { db } from "@/lib/db";

export async function POST(request: Request) {
  const data = (await request.json().catch(() => ({}))) as { member_id?: number; session_id?: number; source?: string };
  const member = await db.member.findUnique({ where: { id: Number(data.member_id) } });
  const session = await db.classSession.findUnique({ where: { id: Number(data.session_id) } });
  if (!member || !session) return Response.json({ error: "Not found" }, { status: 404 });

  const source = BOOKING_SOURCES.includes(data.source as BookingSource) ? (data.source as BookingSource) : "app";
  try {
    const b = await book(member.id, session.id, source);
    return Response.json({ id: b.id, session_id: b.sessionId, status: b.status, source: b.source }, { status: 201 });
  } catch (e) {
    if (e instanceof BookingError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
