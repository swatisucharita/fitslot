import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { POST as bookApi } from "@/app/api/bookings/route";
import { POST as paymentWebhook } from "@/app/api/webhooks/payments/route";
import { book, BookingError, cancel, Waitlisted } from "@/lib/bookings";
import { db } from "@/lib/db";
import { HOUR } from "@/lib/format";
import { sendClassReminders } from "@/lib/notifications/reminders";

let studioId: number, sessionId: number, a: number, b: number;

beforeEach(async () => {
  await db.studio.deleteMany(); // cascades to everything below it
  await db.paymentEvent.deleteMany();
  const studio = await db.studio.create({ data: { name: "Test", city: "Pune", plan: "growth" } });
  const ctype = await db.classType.create({ data: { studioId: studio.id, name: "Yoga" } });
  const session = await db.classSession.create({
    data: { classTypeId: ctype.id, trainer: "T", startsAt: new Date(Date.now() + 5 * HOUR), capacity: 1 },
  });
  const [ma, mb] = await Promise.all([
    db.member.create({ data: { studioId: studio.id, name: "A", phone: "+911", email: "a@x.com" } }),
    db.member.create({ data: { studioId: studio.id, name: "B", phone: "+912", email: "b@x.com" } }),
  ]);
  [studioId, sessionId, a, b] = [studio.id, session.id, ma.id, mb.id];
});

describe("booking rules", () => {
  it("confirms a booking by email", async () => {
    await book(a, sessionId);
    expect(await db.notification.count({ where: { memberId: a, kind: "booking_confirmed" } })).toBe(1);
  });

  it("waitlists when full and promotes on cancel", async () => {
    const booking = await book(a, sessionId);
    await expect(book(b, sessionId)).rejects.toBeInstanceOf(Waitlisted);
    expect(await db.waitlistEntry.count({ where: { memberId: b } })).toBe(1);

    await cancel(booking.id);
    expect(await db.booking.count({ where: { memberId: b, status: "booked" } })).toBe(1);
    expect(await db.waitlistEntry.count()).toBe(0);
  });

  it("closes cancellations 2 hours before class", async () => {
    await db.classSession.update({ where: { id: sessionId }, data: { startsAt: new Date(Date.now() + HOUR) } });
    const booking = await db.booking.create({ data: { memberId: a, sessionId } });
    await expect(cancel(booking.id)).rejects.toBeInstanceOf(BookingError);
  });
});

describe("reminders", () => {
  const ninetyMinutesBefore = async () =>
    new Date((await db.classSession.findUniqueOrThrow({ where: { id: sessionId } })).startsAt.getTime() - 1.5 * HOUR);

  it("sends SMS on Growth and never twice", async () => {
    await db.booking.create({ data: { memberId: a, sessionId } });
    const now = await ninetyMinutesBefore();
    expect(await sendClassReminders(now)).toBe(1);
    expect(await db.notification.count({ where: { channel: "sms", kind: "class_reminder" } })).toBe(1);
    expect(await sendClassReminders(now)).toBe(0);
  });

  it("sends no SMS on Starter", async () => {
    await db.studio.update({ where: { id: studioId }, data: { plan: "starter" } });
    await db.booking.create({ data: { memberId: a, sessionId } });
    await sendClassReminders(await ninetyMinutesBefore());
    expect(await db.notification.count({ where: { channel: "sms" } })).toBe(0);
  });
});

describe("payment webhook", () => {
  const post = (body: object, sig?: string) => {
    const raw = JSON.stringify(body);
    const signature = sig ?? createHmac("sha256", "s3cret").update(raw).digest("hex");
    return paymentWebhook(new Request("http://x/api/webhooks/payments", {
      method: "POST", body: raw, headers: { "x-signature": signature },
    }));
  };

  it("rejects a bad signature", async () => {
    expect((await post({ id: "e1", type: "payment.captured" }, "bad")).status).toBe(403);
  });

  it("is idempotent", async () => {
    expect(await (await post({ id: "e1", type: "payment.captured" })).text()).toBe("ok");
    expect(await (await post({ id: "e1", type: "payment.captured" })).text()).toBe("duplicate");
  });
});

describe("bookings API", () => {
  it("books via JSON", async () => {
    const res = await bookApi(new Request("http://x/api/bookings", {
      method: "POST", body: JSON.stringify({ member_id: a, session_id: sessionId }),
    }));
    expect(res.status).toBe(201);
  });
});
