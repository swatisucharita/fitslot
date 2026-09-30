import { BookingError, cancel } from "@/lib/bookings";
import { db } from "@/lib/db";

export async function POST(_request: Request, ctx: RouteContext<"/api/bookings/[bookingId]/cancel">) {
  const bookingId = Number((await ctx.params).bookingId);
  if (!(await db.booking.findUnique({ where: { id: bookingId } })))
    return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const b = await cancel(bookingId);
    return Response.json({ id: b.id, session_id: b.sessionId, status: b.status, source: b.source });
  } catch (e) {
    if (e instanceof BookingError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
