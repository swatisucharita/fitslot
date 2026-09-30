// Send reminders for classes in the next 2 hours. Run from cron every 5 minutes.
import "dotenv/config";

import { db } from "@/lib/db";
import { sendClassReminders } from "@/lib/notifications/reminders";

sendClassReminders()
  .then((n) => console.log(`Sent ${n} reminders`))
  .finally(() => db.$disconnect());
