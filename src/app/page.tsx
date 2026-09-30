import Link from "next/link";
import { connection } from "next/server";

import { Shell } from "@/components/Shell";
import { PLAN_LABELS, type Plan } from "@/lib/billing";
import { db } from "@/lib/db";

export default async function Home() {
  await connection(); // always read fresh data
  const studios = await db.studio.findMany({ include: { members: { take: 4, orderBy: { id: "asc" } } } });

  return (
    <Shell subtitle="Demo">
      <div className="card">
        <h2>FitSlot demo</h2>
        <p>
          A minimal version of the fictional studio booking app used by the Feature Research Agent demo. All data is
          sample data.
        </p>
      </div>
      {studios.map((studio) => (
        <div className="card" key={studio.id}>
          <h3>
            {studio.name} <span className="pill">{PLAN_LABELS[studio.plan as Plan]}</span>
          </h3>
          <p>
            <Link href={`/studio/${studio.id}`}>Owner dashboard</Link>
          </p>
          <p>
            Member view:{" "}
            {studio.members.map((m, i) => (
              <span key={m.id}>
                {i > 0 && " · "}
                <Link href={`/m/${m.id}`}>{m.name}</Link>
              </span>
            ))}
          </p>
        </div>
      ))}
      {studios.length === 0 && (
        <div className="card">
          No data yet. Run <code>npm run seed</code>.
        </div>
      )}
    </Shell>
  );
}
