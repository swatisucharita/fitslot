/**
 * Plan limits and feature gating.
 *
 * Every paid feature is checked through `hasFeature`, so a new feature
 * (e.g. WhatsApp messaging) only needs a new entry in PLAN_FEATURES.
 */
export const PLANS = ["starter", "growth", "pro"] as const;
export type Plan = (typeof PLANS)[number];

export type Feature =
  | "push"
  | "email"
  | "sms_reminders"
  | "reports"
  | "multi_location"
  | "trainer_payroll"
  | "marketing"
  | "api";

export const PLAN_LABELS: Record<Plan, string> = { starter: "Starter", growth: "Growth", pro: "Pro" };

export const MEMBER_LIMITS: Record<Plan, number | null> = { starter: 150, growth: 500, pro: null };

export const PLAN_FEATURES: Record<Plan, ReadonlySet<Feature>> = {
  starter: new Set(["push", "email"]),
  growth: new Set(["push", "email", "sms_reminders", "reports"]),
  pro: new Set([
    "push", "email", "sms_reminders", "reports",
    "multi_location", "trainer_payroll", "marketing", "api",
  ]),
};

export function hasFeature(studio: { plan: string }, feature: Feature): boolean {
  return PLAN_FEATURES[studio.plan as Plan]?.has(feature) ?? false;
}
