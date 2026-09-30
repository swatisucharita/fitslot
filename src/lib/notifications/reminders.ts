/**
 * Scheduled job: remind members about classes starting soon.
 * Runs every 5 minutes via `npm run reminders` (cron) or POST /api/cron/reminders.
 */
import { db } from "@/lib/db";
import { fmtTime, HOUR } from "@/lib/format";

import { notify } from "./channels";

export const REMINDER_LEAD_MS = 2 * HOUR; // reminders go out 2 hours before class

export async function sendClassReminders(now = new Date()): Promise<number> {
  const due = await db.booking.findMany({
    where: {
      status: "booked",
      reminderSentAt: null,
      session: { startsAt: { gt: now, lte: new Date(now.getTime() + REMINDER_LEAD_MS) } },
    },
    include: { member: { include: { studio: true } }, session: { include: { classType: true } } },
  });

  for (const booking of due) {
    const s = booking.session;
    const body =
      `Reminder: ${s.classType.name} with ${s.trainer} at ${fmtTime(s.startsAt)} today. ` +
      "Can't make it? Cancel in the FitSlot app.";
    await notify(booking.member, "class_reminder", body, ["sms", "push"]);
    await db.booking.update({ where: { id: booking.id }, data: { reminderSentAt: now } });
  }
  return due.length;
}
