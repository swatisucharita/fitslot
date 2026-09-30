"use server";

import { revalidatePath } from "next/cache";

import { markAttendance } from "@/lib/bookings";
import { db } from "@/lib/db";

export async function markAttendanceAction(studioId: number, bookingId: number, attended: boolean) {
  const booking = await db.booking.findFirst({
    where: { id: bookingId, session: { classType: { studioId } } },
  });
  if (!booking) return;
  await markAttendance(bookingId, attended);
  revalidatePath(`/studio/${studioId}`);
}
