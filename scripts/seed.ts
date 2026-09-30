/**
 * Reset and load demo data: two studios, 80 members, 30 days of history and 7 days ahead.
 *
 * History is generated so the numbers match the FitSlot product profile:
 * about 18% no-shows, and about a quarter of bookings typed in by the
 * front desk (members asking on WhatsApp).
 */
import "dotenv/config";

import type { Plan } from "@/lib/billing";
import { db } from "@/lib/db";
import { fmtTime, HOUR, DAY, startOfDayIST } from "@/lib/format";

// Small seeded PRNG so every run produces the same data.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const sample = <T,>(xs: readonly T[], n: number) => [...xs].sort(() => rand() - 0.5).slice(0, n);
const weighted = <T,>(items: [T, number][]) => {
  let r = rand() * items.reduce((s, [, w]) => s + w, 0);
  for (const [item, w] of items) if ((r -= w) < 0) return item;
  return items[items.length - 1][0];
};

const FIRST = ["Aarav", "Diya", "Ishaan", "Ananya", "Kabir", "Meera", "Rohan", "Saanvi", "Arjun", "Priya",
  "Vivaan", "Kavya", "Aditya", "Nisha", "Karan", "Riya", "Siddharth", "Tara", "Neel", "Pooja"];
const LAST = ["Sharma", "Iyer", "Patel", "Reddy", "Nair", "Gupta", "Das", "Menon", "Kulkarni", "Singh"];

const STUDIOS: { name: string; city: string; plan: Plan; classes: [string, string, number[]][] }[] = [
  { name: "Prana Yoga", city: "Bengaluru", plan: "growth",
    classes: [["Hatha Yoga", "Lakshmi", [7, 18]], ["Power Yoga", "Vikram", [8, 19]], ["Pilates", "Sara", [17]]] },
  { name: "Beat Dance Co", city: "Pune", plan: "pro",
    classes: [["Bollywood Dance", "Rahul", [18, 20]], ["Zumba", "Neha", [7, 19]], ["Hip Hop", "Jay", [17]]] },
];

async function main() {
  // Children first; cascades would also work but this keeps it explicit.
  await db.notification.deleteMany();
  await db.waitlistEntry.deleteMany();
  await db.booking.deleteMany();
  await db.classSession.deleteMany();
  await db.classType.deleteMany();
  await db.member.deleteMany();
  await db.studio.deleteMany();
  await db.paymentEvent.deleteMany();

  const now = new Date();
  const today = startOfDayIST(now);

  for (const spec of STUDIOS) {
    const studio = await db.studio.create({
      data: { name: spec.name, city: spec.city, plan: spec.plan, whatsappNumber: `+9198${int(10000000, 99999999)}` },
    });
    await db.member.createMany({
      data: Array.from({ length: 40 }, (_, i) => ({
        studioId: studio.id,
        name: `${pick(FIRST)} ${pick(LAST)}`,
        phone: `+919${int(100000000, 999999999)}`,
        email: `member${i}@example.com`,
        pushToken: rand() < 0.6 ? `tok-${i}` : "",
      })),
    });
    const members = await db.member.findMany({ where: { studioId: studio.id } });

    const bookings: { memberId: number; sessionId: number; source: string; status: string; reminderSentAt: Date | null }[] = [];
    const notes: { memberId: number; channel: string; kind: string; body: string; sentAt: Date }[] = [];

    for (const [name, trainer, hours] of spec.classes) {
      const ctype = await db.classType.create({ data: { studioId: studio.id, name } });
      for (let day = -30; day < 8; day++) {
        for (const hour of hours) {
          const startsAt = new Date(today.getTime() + day * DAY + hour * HOUR);
          const session = await db.classSession.create({
            data: { classTypeId: ctype.id, trainer, startsAt, capacity: 15 },
          });
          const past = startsAt < now;
          for (const m of sample(members, int(6, 14))) {
            const source = weighted<string>([["app", 60], ["web", 15], ["front_desk", 25]]);
            const status = past ? (rand() < 0.18 ? "no_show" : "attended") : "booked";
            bookings.push({ memberId: m.id, sessionId: session.id, source, status, reminderSentAt: past ? startsAt : null });
            if (!past) continue;
            // The confirmation and reminder the member would have received.
            notes.push({ memberId: m.id, channel: m.pushToken ? "push" : "email", kind: "booking_confirmed",
              body: `You're booked: ${name} at ${fmtTime(startsAt)}.`, sentAt: startsAt });
            if (spec.plan !== "starter" && m.smsOptIn)
              notes.push({ memberId: m.id, channel: "sms", kind: "class_reminder",
                body: `Reminder: ${name} at ${fmtTime(startsAt)} today.`, sentAt: startsAt });
          }
        }
      }
    }
    await db.booking.createMany({ data: bookings });
    await db.notification.createMany({ data: notes });
    console.log(`Created ${studio.name} (${spec.plan}) with ${members.length} members`);
  }
}

main().finally(() => db.$disconnect());
