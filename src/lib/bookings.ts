/**
 * Booking rules. Every channel (app, web page, front desk, and any future
 * chat channel) goes through these functions.
 */
import type { Booking, ClassSession, ClassType } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { fmtDateTime, HOUR } from "@/lib/format";

import { notify } from "./notifications/channels";

export const CANCEL_CUTOFF_MS = 2 * HOUR;
export const BOOKING_SOURCES = ["app", "web", "front_desk"] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];
const ACTIVE = ["booked", "attended", "no_show"];

export class BookingError extends Error {}
/** The class was full; the member was put on the waitlist. */
export class Waitlisted extends BookingError {}

const label = (s: ClassSession & { classType: ClassType }) => `${s.classType.name} @ ${fmtDateTime(s.startsAt)}`;

export async function spotsLeft(sessionId: number, capacity: number) {
  const taken = await db.booking.count({ where: { sessionId, status: { in: ACTIVE } } });
  return Math.max(capacity - taken, 0);
}

export async function book(memberId: number, sessionId: number, source: BookingSource = "app"): Promise<Booking> {
  const result = await db.$transaction(async (tx) => {
    const session = await tx.classSession.findUniqueOrThrow({ where: { id: sessionId }, include: { classType: true } });
    if (session.startsAt <= new Date()) throw new BookingError("This class has already started.");
    if (await tx.booking.findFirst({ where: { memberId, sessionId, status: "booked" } }))
      throw new BookingError("You're already booked into this class.");

    const taken = await tx.booking.count({ where: { sessionId, status: { in: ACTIVE } } });
    if (taken >= session.capacity) {
      await tx.waitlistEntry.upsert({
        where: { memberId_sessionId: { memberId, sessionId } },
        create: { memberId, sessionId },
        update: {},
      });
      return { booking: null, session };
    }
    return { booking: await tx.booking.create({ data: { memberId, sessionId, source } }), session };
  });

  // Thrown after the transaction commits so the waitlist entry is kept.
  if (!result.booking) throw new Waitlisted("Class is full. You've been added to the waitlist.");

  const member = await db.member.findUniqueOrThrow({ where: { id: memberId }, include: { studio: true } });
  await notify(member, "booking_confirmed", `You're booked: ${label(result.session)}.`);
  return result.booking;
}

export async function cancel(bookingId: number): Promise<Booking> {
  const booking = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { session: true } });
  if (booking.status !== "booked") throw new BookingError("Only active bookings can be cancelled.");
  if (booking.session.startsAt.getTime() - Date.now() < CANCEL_CUTOFF_MS)
    throw new BookingError("Cancellations close 2 hours before class.");

  const cancelled = await db.booking.update({ where: { id: bookingId }, data: { status: "cancelled" } });
  await promoteWaitlist(booking.sessionId);
  return cancelled;
}

async function promoteWaitlist(sessionId: number) {
  const entry = await db.waitlistEntry.findFirst({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    include: { member: { include: { studio: true } }, session: { include: { classType: true } } },
  });
  if (!entry) return null;

  const [, promoted] = await db.$transaction([
    db.waitlistEntry.delete({ where: { id: entry.id } }),
    db.booking.create({ data: { memberId: entry.memberId, sessionId } }),
  ]);
  await notify(entry.member, "waitlist_promoted", `A spot opened up. You're booked: ${label(entry.session)}.`);
  return promoted;
}

export async function markAttendance(bookingId: number, attended: boolean) {
  return db.booking.update({ where: { id: bookingId }, data: { status: attended ? "attended" : "no_show" } });
}
