import { notFound } from "next/navigation";

import { Flash } from "@/components/Flash";
import { Shell } from "@/components/Shell";
import { spotsLeft } from "@/lib/bookings";
import { db } from "@/lib/db";
import { DAY, fmtDateTime } from "@/lib/format";

import { bookAction, cancelAction } from "./actions";

export default async function MemberPage(props: PageProps<"/m/[memberId]">) {
  const memberId = Number((await props.params).memberId);
  const { ok, err } = (await props.searchParams) as { ok?: string; err?: string };
  const member = await db.member.findUnique({ where: { id: memberId }, include: { studio: true } });
  if (!member) notFound();

  const now = new Date();
  const sessions = await db.classSession.findMany({
    where: { classType: { studioId: member.studioId }, startsAt: { gt: now, lt: new Date(now.getTime() + 7 * DAY) } },
    include: { classType: true, bookings: { where: { memberId, status: "booked" } } },
    orderBy: { startsAt: "asc" },
  });
  const rows = await Promise.all(
    sessions.map(async (s) => ({ session: s, booking: s.bookings[0], left: await spotsLeft(s.id, s.capacity) })),
  );
  const notifications = await db.notification.findMany({
    where: { memberId },
    orderBy: { sentAt: "desc" },
    take: 5,
  });

  return (
    <Shell subtitle={`${member.studio.name} · member view`}>
      <Flash ok={ok} err={err} />
      <div className="card">
        <h2>Hi {member.name}</h2>
        <p>Classes for the next 7 days. Cancellations close 2 hours before class.</p>
        <table>
          <thead>
            <tr><th>Class</th><th>When</th><th>Trainer</th><th>Spots left</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(({ session: s, booking, left }) => (
              <tr key={s.id}>
                <td>{s.classType.name}</td>
                <td>{fmtDateTime(s.startsAt)}</td>
                <td>{s.trainer}</td>
                <td>{left} of {s.capacity}</td>
                <td>
                  {booking ? (
                    <form action={cancelAction.bind(null, memberId, booking.id)}>
                      <button className="ghost">Cancel</button>
                    </form>
                  ) : (
                    <form action={bookAction.bind(null, memberId, s.id)}>
                      <button className="primary">{left ? "Book" : "Join waitlist"}</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5}>No upcoming classes.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Recent messages to you</h3>
        <table>
          <tbody>
            {notifications.map((n) => (
              <tr key={n.id}>
                <td><span className="pill">{n.channel}</span></td>
                <td>{n.body}</td>
                <td>{fmtDateTime(n.sentAt)}</td>
              </tr>
            ))}
            {notifications.length === 0 && <tr><td>No messages yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
