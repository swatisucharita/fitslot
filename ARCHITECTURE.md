# FitSlot architecture

A code map for the FitSlot demo app: what lives where, how a request flows through it, and the rules each module owns. For setup and run commands see [README.md](README.md).

## At a glance

FitSlot is a single Next.js 16 App Router app (TypeScript, strict) backed by SQLite through Prisma 7. There is no separate backend: pages are Server Components that query the database directly, mutations go through Server Actions or JSON route handlers, and both call into the same domain layer in `src/lib/`.

```
                ┌────────────────────────── src/app ───────────────────────────┐
 Browser ──────▶│ Pages (Server Components)      Server Actions                │
                │  /            home             m/[memberId]/actions.ts       │
                │  /m/[id]      member view      studio/[studioId]/actions.ts  │
                │  /studio/[id] owner dashboard                                │
 Member app ───▶│ Route handlers  /api/bookings, /api/bookings/[id]/cancel     │
 Scheduler ────▶│                 /api/cron/reminders                          │
 Payment GW ───▶│                 /api/webhooks/payments                       │
                └───────────────┬──────────────────────────────────────────────┘
                                │ calls
 scripts/ (tsx) ───────────────▶│
                ┌───────────────▼──────────── src/lib ─────────────────────────┐
                │ bookings.ts ──▶ notifications/channels.ts ──▶ billing.ts     │
                │ notifications/reminders.ts ──▶ channels.ts                   │
                │ webhooks.ts (HMAC)    format.ts (IST time)                   │
                └───────────────┬──────────────────────────────────────────────┘
                                ▼
                        db.ts (PrismaClient + better-sqlite3 adapter)
                                ▼
                           SQLite (dev.db / test.db)
```

Rule of thumb: **business rules live in `src/lib/`**. Pages, actions, route handlers and scripts are thin adapters that parse input, call a lib function, and shape the response.

## Directory map

```
.
├── prisma/schema.prisma          Data model (single source of truth for types)
├── prisma.config.ts              Prisma CLI config; reads DATABASE_URL via dotenv
├── src/
│   ├── generated/prisma/         Generated Prisma client (output of `prisma generate`, not hand-edited)
│   ├── lib/                      Domain layer
│   │   ├── db.ts                 Shared PrismaClient singleton
│   │   ├── bookings.ts           Book / cancel / waitlist / attendance rules
│   │   ├── billing.ts            Plans, member limits, feature gating
│   │   ├── format.ts             IST date formatting, time constants
│   │   ├── webhooks.ts           HMAC-SHA256 signature check
│   │   └── notifications/
│   │       ├── channels.ts       Channel registry + notify()
│   │       └── reminders.ts      "Class starts soon" job
│   ├── app/                      Next.js App Router
│   │   ├── layout.tsx            Root <html>, imports globals.css
│   │   ├── globals.css           All styling (plain CSS, no framework)
│   │   ├── page.tsx              Home: list studios, links to dashboards and member views
│   │   ├── m/[memberId]/         Member booking page + Server Actions
│   │   ├── studio/[studioId]/    Owner dashboard + Server Actions
│   │   └── api/                  JSON / webhook / cron route handlers
│   └── components/
│       ├── Shell.tsx             Page chrome (header + <main>)
│       └── Flash.tsx             Success / error banner from ?ok= / ?err=
├── scripts/
│   ├── seed.ts                   Wipe and load deterministic demo data
│   └── send-reminders.ts         CLI entry for the reminder job
├── tests/
│   ├── global-setup.ts           Recreate test.db with `prisma db push`
│   └── fitslot.test.ts           Booking, reminder, webhook and API tests
├── vitest.config.ts              `@` alias, test env vars, serial files
├── next.config.ts                Empty (defaults)
└── docs/screenshots/             Images used by README
```

Path alias: `@/*` → `src/*` (tsconfig and vitest).

## Data model

Defined in `prisma/schema.prisma`. SQLite has no enums, so status-like fields are `String` with the allowed values in comments; the TypeScript unions in `src/lib/` are the real contract.

```
Studio 1─* Member 1─* Booking *─1 ClassSession *─1 ClassType *─1 Studio
                 1─* WaitlistEntry *─1 ClassSession
                 1─* Notification
PaymentEvent (standalone)
```

| Model | Key fields | Notes |
|---|---|---|
| `Studio` | `plan` (`starter` \| `growth` \| `pro`), `whatsappNumber` | Plan drives feature gating in `billing.ts`. `whatsappNumber` is display-only. |
| `Member` | `phone` (E.164), `email`, `pushToken`, `smsOptIn`, `emailOptIn` | Per-channel consent flags. Empty string means "not set". |
| `ClassType` | `name`, `durationMinutes` | Belongs to a studio. |
| `ClassSession` | `startsAt`, `capacity`, `trainer`, `room` | One occurrence of a class. Indexed on `startsAt`. Studio is reached via `classType.studioId`. |
| `Booking` | `status` (`booked` \| `cancelled` \| `attended` \| `no_show`), `source` (`app` \| `web` \| `front_desk`), `reminderSentAt` | `reminderSentAt` makes reminders idempotent. Indexed on `(sessionId, status)`. |
| `WaitlistEntry` | `createdAt` | Unique per `(memberId, sessionId)`; FIFO by `createdAt`. |
| `Notification` | `channel`, `kind`, `body`, `sentAt` | Append-only log of every message sent. Feeds the dashboard and member page. |
| `PaymentEvent` | `eventId` (unique), `eventType`, `payload` | Raw webhook events, stored for idempotency. |

All relations `onDelete: Cascade`, so deleting a `Studio` removes everything under it (the tests rely on this).

Times are stored as UTC `DateTime`; every display goes through `format.ts`, which renders in `Asia/Kolkata`.

## Domain layer (`src/lib/`)

### `db.ts`
Exports `db`, a single `PrismaClient` using the `PrismaBetterSqlite3` driver adapter. Strips the `file:` prefix from `DATABASE_URL` (default `./dev.db`, resolved against the process cwd). Caches the client on `globalThis` outside production so hot reload doesn't open new connections.

### `bookings.ts` — booking rules
Every booking channel must go through these functions.

| Export | Behaviour |
|---|---|
| `book(memberId, sessionId, source = "app")` | In a transaction: reject if the class has started or the member already has a `booked` booking; count `booked`/`attended`/`no_show` bookings against `capacity`; if full, upsert a `WaitlistEntry` and (after commit) throw `Waitlisted`; otherwise create the booking. On success sends a `booking_confirmed` notification on the default channels. |
| `cancel(bookingId)` | Only `booked` bookings; rejects inside `CANCEL_CUTOFF_MS` (2 h) of start. Sets status `cancelled`, then promotes the waitlist. |
| `promoteWaitlist(sessionId)` *(private)* | Oldest waitlist entry → deleted and replaced with a `booked` booking (transaction), then `waitlist_promoted` notification. |
| `markAttendance(bookingId, attended)` | Sets `attended` or `no_show`. No status or time checks. |
| `spotsLeft(sessionId, capacity)` | Capacity minus active bookings, floored at 0. |
| `BookingError`, `Waitlisted` | `BookingError` is the "user-facing rule violation" type; adapters turn it into a 400 or an `?err=` flash. `Waitlisted extends BookingError`, so a waitlist join surfaces as an error message. |
| `BOOKING_SOURCES`, `CANCEL_CUTOFF_MS` | Constants. |

### `billing.ts` — plans and feature gating
`PLANS`, `PLAN_LABELS`, `MEMBER_LIMITS` (150 / 500 / unlimited), and `PLAN_FEATURES` mapping each plan to a set of `Feature`s. `hasFeature(studio, feature)` is the only gate. Today only `sms_reminders` is actually checked (in the SMS channel); `MEMBER_LIMITS` and the other features are declared but not enforced anywhere.

### `notifications/channels.ts` — outbound messaging
- `NotificationChannel { name, canSend(member) }` and the `CHANNELS` registry:
  - `push`: member has a `pushToken`.
  - `email`: member has an email and `emailOptIn`.
  - `sms`: `smsOptIn` **and** the studio has `sms_reminders`.
- `notify(member, kind, body, channels = ["push", "email"])`: for each requested channel that `canSend`, calls `deliver()` (a stub that only logs in development) and writes a `Notification` row. Returns the rows written.
- Callers must pass a member with `studio` included (`MemberWithStudio`).

### `notifications/reminders.ts` — reminder job
`sendClassReminders(now = new Date())` finds `booked` bookings with `reminderSentAt = null` whose session starts in `(now, now + 2h]`, sends a `class_reminder` on `["sms", "push"]`, and stamps `reminderSentAt`. Returns the count. Safe to run repeatedly (designed for every 5 minutes).

### `webhooks.ts`
`validSignature(body, signature, secret)`: hex HMAC-SHA256 of the raw body, compared with `timingSafeEqual`.

### `format.ts`
`TZ = "Asia/Kolkata"`, `fmtTime`, `fmtDateTime`, `startOfDayIST(d)` (IST midnight as a UTC `Date`), and `HOUR` / `DAY` in ms.

## Entry points

### Pages (Server Components)

| Route | File | Reads | Writes via |
|---|---|---|---|
| `/` | `src/app/page.tsx` | Studios + first 4 members each. Calls `connection()` to opt out of static rendering. | — |
| `/m/[memberId]` | `src/app/m/[memberId]/page.tsx` | Member's studio sessions for the next 7 days, their own `booked` bookings, `spotsLeft` per session, last 5 notifications. | `bookAction`, `cancelAction` |
| `/studio/[studioId]` | `src/app/studio/[studioId]/page.tsx` | Today's sessions (IST day) with non-cancelled bookings; 30-day `groupBy` on booking status, booking source and notification channel; member count. Computes no-show rate = `no_show / (no_show + attended)`. | `markAttendanceAction` |

Pages use the Next 16 typed helpers `PageProps<"/route">`; `params` and `searchParams` are Promises and must be awaited.

### Server Actions

| File | Action | Pattern |
|---|---|---|
| `m/[memberId]/actions.ts` | `bookAction(memberId, sessionId)` | Calls `book(..., "web")`. Result is reported by `redirect()` back to the page with `?ok=` or `?err=`, which `<Flash>` renders. |
| | `cancelAction(memberId, bookingId)` | Checks the booking belongs to the member, then `cancel()`. Same redirect pattern. |
| `studio/[studioId]/actions.ts` | `markAttendanceAction(studioId, bookingId, attended)` | Checks the booking belongs to the studio, `markAttendance()`, then `revalidatePath`. |

Actions are bound with `.bind(null, ...ids)` in the page's `<form action>`. Note that `redirect()` throws, so the `back()` helper is typed `never` and must not be wrapped in a `try` that swallows it.

### Route handlers (`src/app/api/`)

| Method + path | Purpose | Responses |
|---|---|---|
| `POST /api/bookings` | JSON booking for the member app. Body `{ member_id, session_id, source? }`; unknown `source` falls back to `app`. | 201 booking JSON · 404 unknown member/session · 400 `BookingError` (including waitlisted) |
| `POST /api/bookings/[bookingId]/cancel` | Cancel a booking. | 200 booking JSON · 404 · 400 |
| `POST /api/cron/reminders` | Runs `sendClassReminders()` for a hosted scheduler. Requires `Authorization: Bearer $CRON_SECRET` only when `CRON_SECRET` is set. | `{ sent: n }` · 401 |
| `POST /api/webhooks/payments` | Payment gateway webhook: verify `x-signature` against `PAYMENT_WEBHOOK_SECRET` (default `dev-secret`), then store in `PaymentEvent` unless the `eventId` already exists. Events are stored, not processed further. | `ok` · `duplicate` · 403 |

None of the routes or pages authenticate the caller; IDs in the URL or body are trusted.

### Scripts (run with `tsx`, load `.env` via `dotenv/config`)
- `scripts/seed.ts` (`npm run seed`): deletes all rows, then creates 2 studios (Growth and Pro), 40 members each, 3 class types per studio, sessions from 30 days ago to 7 days ahead, and bookings/notifications. Uses a seeded PRNG so output is deterministic; probabilities are tuned to give ~18% no-shows and ~25% front-desk bookings.
- `scripts/send-reminders.ts` (`npm run reminders`): calls `sendClassReminders()` once and disconnects. Intended for system cron.

## Key flows

**Member books a class on the web page**
`<form action={bookAction}>` → `bookAction` → `book(memberId, sessionId, "web")` → transaction (capacity check, booking or waitlist) → `notify(..., "booking_confirmed")` → `CHANNELS.push/email.canSend` → `Notification` rows → `redirect("/m/:id?ok=Booked.")` → page re-renders with `<Flash>`.

**Cancellation with waitlist**
`cancelAction` or `POST /api/bookings/:id/cancel` → `cancel()` (2-hour cutoff) → status `cancelled` → `promoteWaitlist()` → oldest `WaitlistEntry` becomes a booking → `notify(..., "waitlist_promoted")`.

**Reminders**
Cron (`npm run reminders` or `POST /api/cron/reminders`) → `sendClassReminders()` → for each due booking `notify(..., "class_reminder", ["sms", "push"])` → SMS only goes out on Growth/Pro with consent (`hasFeature`) → `reminderSentAt` set so the booking is skipped next run.

**Payment webhook**
Raw body → `validSignature()` → look up `eventId` → insert `PaymentEvent` or reply `duplicate`.

## Configuration

| Variable | Used by | Default |
|---|---|---|
| `DATABASE_URL` | `db.ts`, `prisma.config.ts` | `file:./dev.db` |
| `PAYMENT_WEBHOOK_SECRET` | payments webhook | `dev-secret` |
| `CRON_SECRET` | cron route | unset (route open) |
| `NODE_ENV` | `db.ts` client caching, `deliver()` logging | set by Next / tooling |

Prisma: the client is generated into `src/generated/prisma` (`postinstall` runs `prisma generate`). The schema is applied with `prisma db push`; there are no migration files yet even though `prisma.config.ts` points at `prisma/migrations`.

## Testing

`npm test` runs Vitest against a throwaway `test.db`:
- `tests/global-setup.ts` deletes `test.db` and runs `prisma db push`.
- `vitest.config.ts` sets `DATABASE_URL=file:./test.db` and `PAYMENT_WEBHOOK_SECRET=s3cret`, and disables file parallelism (one shared SQLite file).
- `beforeEach` deletes all studios (cascade) and payment events, then creates one Growth studio, one session 5 h out with capacity 1, and two members.
- Route handlers are tested by importing their `POST` export and passing a `Request` directly.

Covered: confirmation notification, waitlist + promotion, cancel cutoff, SMS reminders on Growth and not Starter, reminder idempotency, webhook signature rejection and idempotency, JSON booking API. Not covered: Server Actions, pages, `markAttendance`, the cron route.

Other checks: `npm run typecheck` (runs `next typegen` first so `PageProps` / `RouteContext` types exist) and `npm run lint`.

## Conventions

- Domain logic in `src/lib/`; adapters in `src/app/` and `scripts/` stay thin.
- User-facing rule failures are `BookingError`s; anything else propagates as a 500.
- Every outbound message goes through `notify()` so it is gated by consent/plan and logged in `Notification`.
- Every paid capability is checked through `hasFeature()`.
- Inbound webhooks follow: verify signature on the raw body → store the raw event keyed by a unique id → process.
- Display times with `format.ts` helpers, never `toLocaleString()` without the IST timezone.
- This is a modified Next.js (see `AGENTS.md`): check `node_modules/next/dist/docs/` before using a Next API you haven't seen in this repo.

## Known gaps

What the code does today that a production version would need to change. Most are deliberate demo shortcuts (see README "Deliberately left out"); the rest are bugs or missing rules. References are `file:line`.

### Security and access

| Gap | Where | Effect |
|---|---|---|
| No authentication anywhere | all pages, actions and `src/app/api/` | Anyone can open any member's page or dashboard, or book/cancel for any member by ID. |
| API trusts the caller's `source` | `src/app/api/bookings/route.ts:11` | Any client can label a booking `front_desk`, which skews the dashboard's channel split. |
| Cancel API doesn't check ownership | `src/app/api/bookings/[bookingId]/cancel/route.ts:6` | Any booking can be cancelled by ID. (The Server Action does check, `m/[memberId]/actions.ts:25`.) |
| Cron route is open when `CRON_SECRET` is unset | `src/app/api/cron/reminders/route.ts:6` | Fine locally; must be set in any deployed environment. |
| Webhook secret falls back to `dev-secret` | `src/app/api/webhooks/payments/route.ts:6` | A deployment without the env var accepts payloads signed with a public value. |

### Booking and waitlist rules

| Gap | Where | Effect |
|---|---|---|
| `cancel()` is two separate writes | `src/lib/bookings.ts:60-61` | If promotion fails, the booking is cancelled but nobody is promoted. |
| Promotion doesn't re-check the member | `src/lib/bookings.ts:65-79` | A member on the waitlist who later books directly (after a spot frees up) keeps their waitlist entry, and can be promoted into a second booking for the same class. |
| No way to see or leave the waitlist | `src/app/m/[memberId]/page.tsx:20`, no API | The member page only shows `booked` bookings, so a waitlisted member still sees "Join waitlist". |
| Waitlist joins are allowed inside the 2-hour window | `src/lib/bookings.ts:30-42` | Promotion only happens on cancel, and cancels are blocked inside 2 hours, so these entries can never be promoted. |
| Capacity check relies on SQLite write locking | `src/lib/bookings.ts:34-43` | Count-then-insert is safe only because SQLite serialises writers. On Postgres it needs `SERIALIZABLE` isolation or a row lock to prevent overbooking. |
| `markAttendance` has no guards | `src/lib/bookings.ts:81`, `studio/[studioId]/actions.ts:8` | Can mark cancelled bookings, or future classes, as attended/no-show. |
| Waitlist outcome is reported as an error | `Waitlisted extends BookingError` (`bookings.ts:18`) | The web page shows "added to the waitlist" in the red error banner; the API returns 400. |

### Notifications and reminders

| Gap | Where | Effect |
|---|---|---|
| Providers are stubs | `src/lib/notifications/channels.ts:43` | `deliver()` only logs; nothing is actually sent. |
| No delivery status or retries | `channels.ts:56-57` | A `Notification` row is written as if delivery succeeded. No failed/queued state. |
| Reminder text contradicts the cancel rule | `src/lib/notifications/reminders.ts:24-26` vs `bookings.ts:11` | Reminders go out at most 2 hours before class, which is exactly when cancellation has closed, yet the message says "Cancel in the FitSlot app". |
| Starter members without a push token get no reminder | `reminders.ts:27` | Reminders use `["sms", "push"]`; SMS is Growth/Pro only and email isn't tried. |
| Push has no consent flag or plan gate | `channels.ts:21-24` | Unlike SMS/email, there is no `pushOptIn`; the `push` feature in `billing.ts` is never checked. |
| `kind` and `channel` are untyped strings | `prisma/schema.prisma:92-93`, `notify(kind: string)` | Typos aren't caught; there's no message template registry. |
| Booking confirmation is sent after commit, outside any retry | `bookings.ts:49-50` | If `notify()` throws, the booking exists but the caller sees an error. |

### Billing and payments

| Gap | Where | Effect |
|---|---|---|
| Member limits not enforced | `src/lib/billing.ts:22` | `MEMBER_LIMITS` is never read. |
| Most features are declared but unused | `billing.ts:10-18` | Only `sms_reminders` is checked. |
| Payment events are stored, never processed | `src/app/api/webhooks/payments/route.ts:14` | No plan changes, no subscription state. |
| Unguarded `JSON.parse` | `payments/route.ts:10` | A correctly signed but malformed body returns 500, and the gateway will keep retrying. |
| Duplicate check can race | `payments/route.ts:12-14` | Two concurrent deliveries of one event: the second insert hits the unique constraint and returns 500 instead of `duplicate`. |
| `plan` is a free string | `schema.prisma:16` | An unknown plan silently has no features and no label. |

### Data, time and platform

| Gap | Where | Effect |
|---|---|---|
| No migrations | `prisma.config.ts:8`, `npm run db:push` | Schema changes are pushed directly; no history, unsafe for production data. |
| Timezone is hard-coded to IST | `src/lib/format.ts:2` | No per-studio timezone. |
| Invalid IDs aren't validated | `api/bookings/route.ts:7-8`, page `Number(params...)` | A missing or non-numeric ID becomes `NaN` and is passed straight to Prisma instead of being rejected as a 400. |
| N+1 queries on the member page | `src/app/m/[memberId]/page.tsx:24` | One `count` per upcoming session. |
| Single location only | schema has no `Location` model | `multi_location` exists only as a feature name. |
| Tests run serially on one SQLite file | `vitest.config.ts:10` | Fine at this size; Server Actions, pages, `markAttendance` and the cron route have no tests. |

## Extension points

The places the code is designed to grow. Each one has a single registry or function, so a change starts there and ripples out to a known set of files.

### 1. Notification channels — `src/lib/notifications/channels.ts`

**Contract:** a `NotificationChannel` with `name` and `canSend(member)`. Delivery happens in `deliver(channel, member, body)`.

To add a channel:
1. Extend `ChannelName` and add the channel object to `CHANNELS`. Put consent and plan checks in `canSend`.
2. Add a provider call to `deliver()` (or move `deliver` onto the channel object once there's more than one real provider).
3. Add a consent field on `Member` in `prisma/schema.prisma` if the channel needs opt-in.
4. Decide where it's used: the `notify()` default list, and the explicit list in `reminders.ts:27`.
5. Show it on the dashboard: the "Messages sent" stat in `studio/[studioId]/page.tsx:70` hard-codes the channel names.

### 2. Feature gating and plans — `src/lib/billing.ts`

**Contract:** `hasFeature(studio, feature)` is the only gate.

- New paid capability: add to `Feature`, add to the right sets in `PLAN_FEATURES`, call `hasFeature()` at the point of use (usually inside a channel's `canSend` or an action).
- New plan: add to `PLANS`, `PLAN_LABELS`, `MEMBER_LIMITS`, `PLAN_FEATURES`; the `Record<Plan, …>` types make the compiler flag anything missing.
- Enforcing member limits would be a new check where members are created (there is no member-creation path yet besides the seed).

### 3. Booking entry channels — `src/lib/bookings.ts`

**Contract:** every channel calls `book(memberId, sessionId, source)` and `cancel(bookingId)` and maps `BookingError` to its own error format. Rules are never duplicated in adapters.

To add a channel (e.g. a chat bot or a kiosk):
1. Add the value to `BOOKING_SOURCES`.
2. Write a thin adapter (route handler, webhook or action) that resolves the member and session, then calls `book` / `cancel`.
3. Add a label in `SOURCE_LABELS` and the "Bookings by channel" stat in `studio/[studioId]/page.tsx:10,66`, and update the `source` comment in the schema.

### 4. Inbound webhooks — `src/app/api/webhooks/` + `src/lib/webhooks.ts`

**Pattern:** read the raw body → `validSignature()` → store the raw event keyed by the provider's unique event ID → process. The payments route is the template.

For a new provider: new folder under `src/app/api/webhooks/<provider>/route.ts`, a new secret env var, and a raw-event model (copy `PaymentEvent`) for idempotency. If the provider signs differently (base64, timestamped, or a different header), add a sibling function in `webhooks.ts` rather than changing `validSignature`. Processing that books or cancels should go through extension point 3.

### 5. Scheduled jobs — `src/lib/notifications/reminders.ts`

**Pattern:** a pure async function taking `now` (for testability) that finds due work, does it, and stamps a column so re-runs are no-ops. It is exposed twice: a `tsx` script in `scripts/` and a `POST` route under `src/app/api/cron/` guarded by `CRON_SECRET`.

New jobs (waitlist expiry, no-show follow-ups, payment reconciliation) should follow the same three pieces: lib function, script, cron route.

### 6. Message kinds

`kind` is a free string passed to `notify()` (`booking_confirmed`, `class_reminder`, `waitlist_promoted`). A new message type is a new `notify()` call at the trigger point. If channels need different templates (for example, pre-approved templates on a chat platform), this is where a typed `kind` union and a template map would go.

### 7. Data model — `prisma/schema.prisma`

Edit the schema → `npm run db:push` (regenerates the client in `src/generated/prisma`) → update `scripts/seed.ts` if demo data should cover the new field → update the test fixture in `tests/fitslot.test.ts` if required fields were added. Status-like columns are strings, so update the matching TypeScript union and the comment together.

### 8. Dashboard metrics — `src/app/studio/[studioId]/page.tsx`

Metrics are `groupBy` queries over the last 30 days, run in parallel and turned into lookup maps by `countBy()`. Add a query to the `Promise.all` and a `.stat` block. Channel and source names are hard-coded in the JSX, so new channels and sources need adding here.

### Worked example: WhatsApp

The integration the demo was built to size touches every extension point above:

| Step | Extension point | Files |
|---|---|---|
| `whatsappOptIn` consent flag on `Member` | 7 | `prisma/schema.prisma`, `scripts/seed.ts` |
| `"whatsapp"` feature on the chosen plans | 2 | `src/lib/billing.ts` |
| `whatsapp` channel gated on opt-in + feature | 1 | `src/lib/notifications/channels.ts` |
| Reminders on `["whatsapp", "push"]` where enabled; fix the "cancel in app" wording | 1, 5 | `src/lib/notifications/reminders.ts` |
| Template per message kind (WhatsApp requires pre-approved templates outside the 24-hour window) | 6 | `channels.ts` or a new `templates.ts` |
| Inbound message webhook, signed and idempotent | 4 | `src/app/api/webhooks/whatsapp/route.ts`, new raw-event model |
| Bot books and cancels with a `whatsapp` source | 3 | `src/lib/bookings.ts`, the webhook handler |
| Dashboard shows WhatsApp bookings and messages | 8 | `src/app/studio/[studioId]/page.tsx` |
