// Called every 5 minutes by a scheduler (e.g. Vercel Cron). Protected by CRON_SECRET when set.
import { sendClassReminders } from "@/lib/notifications/reminders";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`)
    return new Response("unauthorized", { status: 401 });
  return Response.json({ sent: await sendClassReminders() });
}
