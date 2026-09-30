/**
 * Outbound notification channels.
 *
 * Each channel implements `NotificationChannel`. In this demo the providers
 * are stubs that only write to the Notification log; a real deployment would
 * call FCM (push), an email API and an SMS gateway.
 * Adding WhatsApp means adding one more channel here and registering it in CHANNELS.
 */
import type { Member, Notification, Studio } from "@/generated/prisma/client";
import { hasFeature } from "@/lib/billing";
import { db } from "@/lib/db";

export type ChannelName = "push" | "email" | "sms";
export type MemberWithStudio = Member & { studio: Studio };

export interface NotificationChannel {
  name: ChannelName;
  canSend(member: MemberWithStudio): boolean;
}

const pushChannel: NotificationChannel = {
  name: "push",
  canSend: (m) => m.pushToken !== "",
};

const emailChannel: NotificationChannel = {
  name: "email",
  canSend: (m) => m.email !== "" && m.emailOptIn,
};

const smsChannel: NotificationChannel = {
  name: "sms",
  canSend: (m) => m.smsOptIn && hasFeature(m.studio, "sms_reminders"),
};

export const CHANNELS: Record<ChannelName, NotificationChannel> = {
  push: pushChannel,
  email: emailChannel,
  sms: smsChannel,
};

/** Hand the message to the provider. Stubbed in the demo. */
function deliver(channel: ChannelName, member: Member, body: string) {
  if (process.env.NODE_ENV === "development") console.log(`[${channel}] to ${member.name}: ${body}`);
}

export async function notify(
  member: MemberWithStudio,
  kind: string,
  body: string,
  channels: ChannelName[] = ["push", "email"],
): Promise<Notification[]> {
  const sent: Notification[] = [];
  for (const name of channels) {
    if (!CHANNELS[name].canSend(member)) continue;
    deliver(name, member, body);
    sent.push(await db.notification.create({ data: { memberId: member.id, channel: name, kind, body } }));
  }
  return sent;
}
