/**
 * Per-role ntfy subscription checklist.
 * ntfy is topic-based (a shared word), not phone-number-based.
 */

import type { Role } from "./types";
import { getSetting, setSetting } from "./audit";
import { DEFAULT_NTFY_TOPIC, NTFY_ADMIN_TEST_TOPIC } from "./alertChannels";

export type SubItemKind = "channel" | "setup";

export interface SubscriptionDef {
  id: string;
  kind: SubItemKind;
  /** ntfy topic word when kind=channel (may be overridden by live settings) */
  topicKey?: "fleet" | "admin_test";
  title: string;
  /** Short “what this is for” */
  why: string;
  /** How to set it up */
  how: string;
  /** Roles that must complete this item */
  roles: Role[];
}

/** Static catalog — topic words filled at request time from settings / constants. */
export const SUBSCRIPTION_DEFS: SubscriptionDef[] = [
  {
    id: "install_ntfy",
    kind: "setup",
    title: "Install the free ntfy app",
    why: "Phone pushes only work through ntfy. Without the app you only see alerts inside the fleet app.",
    how: "App Store or Google Play — search “ntfy” (n-t-f-y).",
    roles: ["admin", "office", "mechanic", "driver"],
  },
  {
    id: "channel_fleet",
    kind: "channel",
    topicKey: "fleet",
    title: "Fleet channel",
    why: "Real emergencies, blowouts, and shop repairs. The mechanic and team stay on this only.",
    how: "In ntfy: Subscribe / + → type the word exactly → Allow notifications.",
    roles: ["admin", "office", "mechanic", "driver"],
  },
  {
    id: "channel_admin_test",
    kind: "channel",
    topicKey: "admin_test",
    title: "Admin test channel",
    why: "Settings “Send test” only. Keeps the mechanic free of test buzzes.",
    how: "In ntfy: Subscribe / + → type this second word. Only admins need this.",
    roles: ["admin"],
  },
  {
    id: "instant_delivery",
    kind: "setup",
    title: "Instant delivery on",
    why: "Some phones delay alerts unless Instant delivery is enabled for each subscription.",
    how: "Open each channel in ntfy → subscription settings → Instant delivery ON (if shown).",
    roles: ["admin", "office", "mechanic", "driver"],
  },
];

export function defsForRole(role: Role): SubscriptionDef[] {
  return SUBSCRIPTION_DEFS.filter((d) => d.roles.includes(role));
}

function ackSettingKey(userId: number): string {
  return `ntfy_acks_u${userId}`;
}

export async function loadAcks(db: D1Database, userId: number): Promise<Record<string, string>> {
  const raw = await getSetting(db, ackSettingKey(userId), "");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveAcks(
  db: D1Database,
  userId: number,
  acks: Record<string, string>
): Promise<void> {
  await setSetting(db, ackSettingKey(userId), JSON.stringify(acks));
}

export async function getFleetTopic(db: D1Database): Promise<string> {
  const t = (await getSetting(db, "ntfy_topic", DEFAULT_NTFY_TOPIC)).trim();
  return t || DEFAULT_NTFY_TOPIC;
}

export interface SubscriptionItemView {
  id: string;
  kind: SubItemKind;
  title: string;
  why: string;
  how: string;
  /** Present for kind=channel */
  topic: string | null;
  done: boolean;
  done_at: string | null;
}

export async function buildSubscriptionList(
  db: D1Database,
  userId: number,
  role: Role
): Promise<{
  fleet_topic: string;
  admin_test_topic: string;
  items: SubscriptionItemView[];
  all_done: boolean;
  remaining: number;
}> {
  const fleetTopic = await getFleetTopic(db);
  const adminTestTopic = NTFY_ADMIN_TEST_TOPIC;
  const acks = await loadAcks(db, userId);
  const defs = defsForRole(role);
  const items: SubscriptionItemView[] = defs.map((d) => {
    const doneAt = acks[d.id] || null;
    let topic: string | null = null;
    if (d.topicKey === "fleet") topic = fleetTopic;
    if (d.topicKey === "admin_test") topic = adminTestTopic;
    return {
      id: d.id,
      kind: d.kind,
      title: d.title,
      why: d.why,
      how: d.how,
      topic,
      done: Boolean(doneAt),
      done_at: doneAt,
    };
  });
  const remaining = items.filter((i) => !i.done).length;
  return {
    fleet_topic: fleetTopic,
    admin_test_topic: adminTestTopic,
    items,
    all_done: remaining === 0,
    remaining,
  };
}
