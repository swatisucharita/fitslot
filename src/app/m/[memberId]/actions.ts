"use server";

import { redirect } from "next/navigation";

import { book, BookingError, cancel } from "@/lib/bookings";
import { db } from "@/lib/db";

function back(memberId: number, key: "ok" | "err", msg: string): never {
  redirect(`/m/${memberId}?${key}=${encodeURIComponent(msg)}`);
}

export async function bookAction(memberId: number, sessionId: number) {
  let msg: string;
  try {
    await book(memberId, sessionId, "web");
    msg = "Booked.";
  } catch (e) {
    if (e instanceof BookingError) back(memberId, "err", e.message);
    throw e;
  }
  back(memberId, "ok", msg);
}

export async function cancelAction(memberId: number, bookingId: number) {
  const booking = await db.booking.findFirst({ where: { id: bookingId, memberId } });
  if (!booking) back(memberId, "err", "Booking not found.");
  try {
    await cancel(bookingId);
  } catch (e) {
    if (e instanceof BookingError) back(memberId, "err", e.message);
    throw e;
  }
  back(memberId, "ok", "Booking cancelled.");
}
