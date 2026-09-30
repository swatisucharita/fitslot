import { notFound } from "next/navigation";

import { Shell } from "@/components/Shell";
import { PLAN_LABELS, type Plan } from "@/lib/billing";
import { db } from "@/lib/db";
import { DAY, fmtTime, startOfDayIST } from "@/lib/format";

import { markAttendanceAction } from "./actions";

const SOURCE_LABELS: Record<string, string> = { app: "Member app", web: "Web booking page", front_desk: "Front desk" };
const STATUS_LABELS: Record<string, string> = {
  booked: "Booked", cancelled: "Cancelled", attended: "Attended", no_show: "No-show",
};

async function countBy<T extends string>(rows: Promise<({ _count: { _all: number } } & Record<T, string>)[]>, key: T) {
  return Object.fromEntries((await rows).map((r) => [r[key], r._count._all])) as Record<string, number>;
}

export default async function Dashboard(props: PageProps<"/studio/[studioId]">) {
  const studioId = Number((await props.params).studioId);
  const studio = await db.studio.findUnique({ where: { id: studioId } });
  if (!studio) notFound();

  const now = new Date();
  const dayStart = startOfDayIST(now);
  const monthAgo = new Date(now.getTime() - 30 * DAY);

  const today = await db.classSession.findMany({
    where: { classType: { studioId }, startsAt: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY) } },
    include: {
      classType: true,
      bookings: { where: { status: { not: "cancelled" } }, include: { member: true }, orderBy: { id: "asc" } },
    },
    orderBy: { startsAt: "asc" },
  });

  const last30 = { session: { classType: { studioId }, startsAt: { gte: monthAgo, lt: now } } };
  const [status, bySource, channels, memberCount] = await Promise.all([
    countBy(db.booking.groupBy({ by: ["status"], where: last30, _count: { _all: true } }), "status"),
    countBy(db.booking.groupBy({ by: ["source"], where: last30, _count: { _all: true } }), "source"),
    countBy(
      db.notification.groupBy({
        by: ["channel"],
        where: { member: { studioId }, sentAt: { gte: monthAgo } },
        _count: { _all: true },
      }),
      "channel",
    ),
    db.member.count({ where: { studioId } }),
  ]);
  const noShows = status.no_show ?? 0;
  const finished = noShows + (status.attended ?? 0);
  const noShowRate = finished ? ((100 * noShows) / finished).toFixed(1) : "0";

  return (
    <Shell subtitle={`${studio.name} · owner dashboard · ${PLAN_LABELS[studio.plan as Plan]} plan`}>
      <div className="card stats">
        <div className="stat">
          <small>No-show rate, last 30 days</small>
          <b>{noShowRate}%</b>
          <small>{noShows} of {finished} bookings</small>
        </div>
        <div className="stat"><small>Members</small><b>{memberCount}</b></div>
        <div className="stat">
          <small>Bookings by channel, 30 days</small>
          <div>App {bySource.app ?? 0} · Web {bySource.web ?? 0} · Front desk {bySource.front_desk ?? 0}</div>
        </div>
        <div className="stat">
          <small>Messages sent, 30 days</small>
          <div>Push {channels.push ?? 0} · Email {channels.email ?? 0} · SMS {channels.sms ?? 0}</div>
        </div>
      </div>
      <div className="card gap">
        <b>Front-desk bookings</b> are mostly re-typed from members&apos; WhatsApp messages. FitSlot has no WhatsApp
        channel yet.
      </div>
      <div className="card">
        <h3>Today&apos;s classes</h3>
        {today.map((s) => (
          <div key={s.id}>
            <h4>
              {s.classType.name} · {fmtTime(s.startsAt)} · {s.trainer} ({s.bookings.length}/{s.capacity})
            </h4>
            <table>
              <tbody>
                {s.bookings.map((b) => (
                  <tr key={b.id}>
                    <td>{b.member.name}</td>
                    <td><span className="pill">{SOURCE_LABELS[b.source]}</span></td>
                    <td><span className={`pill ${b.status}`}>{STATUS_LABELS[b.status]}</span></td>
                    <td className="actions">
                      <form action={markAttendanceAction.bind(null, studioId, b.id, true)}>
                        <button className="ghost">Attended</button>
                      </form>
                      <form action={markAttendanceAction.bind(null, studioId, b.id, false)}>
                        <button className="ghost">No-show</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {today.length === 0 && <p>No classes today.</p>}
      </div>
    </Shell>
  );
}
