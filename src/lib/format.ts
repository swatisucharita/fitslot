// All studios are in India; render times in IST regardless of server timezone.
export const TZ = "Asia/Kolkata";

export const fmtTime = (d: Date) =>
  d.toLocaleTimeString("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export const fmtDateTime = (d: Date) =>
  d.toLocaleString("en-IN", {
    timeZone: TZ, weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

/** Midnight IST of the day containing `d`, as a UTC Date. */
export function startOfDayIST(d = new Date()): Date {
  const ist = new Date(d.getTime() + 330 * 60_000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 330 * 60_000);
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
