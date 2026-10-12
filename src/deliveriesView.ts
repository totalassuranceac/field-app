/** Pure Deliveries display helpers. No React. */

export function fmtCt(utc: string | null | undefined): string {
  if (!utc) return "";
  try {
    const raw = String(utc);
    const d = new Date(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
    if (Number.isNaN(d.getTime())) return raw.slice(0, 16);
    const date = d.toLocaleDateString("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
    });
    const time = d.toLocaleTimeString("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
    });
    return `${date}, ${time} CT`;
  } catch {
    return String(utc).slice(0, 16);
  }
}

export function fmtYmd(ymd: string | null | undefined): string {
  const s = String(ymd || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(d.getTime())) return "";
  return d
    .toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    .replace(",", "");
}

export function ageLabel(days: number): string {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return "today";
  if (n === 1) return "1 day";
  return `${n} days`;
}

export function statusLabel(s: string | null | undefined): string {
  const v = String(s || "").toLowerCase();
  if (v === "scheduled") return "Scheduled";
  if (v === "picked_up") return "Picked up";
  if (v === "voided") return "Voided";
  return "Received";
}

export type ProgressStep = {
  key: string;
  label: string;
  done: boolean;
  active: boolean;
  when: string;
};

export function progressSteps(d: {
  status?: string | null;
  received_at?: string | null;
  scheduled_for?: string | null;
  scheduled_at?: string | null;
  picked_up_at?: string | null;
}): ProgressStep[] {
  const st = String(d.status || "");
  const hasSchedule = Boolean(String(d.scheduled_at || "").trim() || String(d.scheduled_for || "").trim());
  const skipped = st === "picked_up" && !hasSchedule;
  const scheduledDone = !skipped && hasSchedule && (st === "scheduled" || st === "picked_up");
  const whenScheduled = skipped ? "" : d.scheduled_for ? fmtYmd(d.scheduled_for) : fmtCt(d.scheduled_at);
  return [
    {
      key: "received",
      label: "Received",
      done: st === "received" || st === "scheduled" || st === "picked_up",
      active: st === "received",
      when: fmtCt(d.received_at),
    },
    {
      key: "scheduled",
      label: skipped ? "Scheduled (skipped)" : "Scheduled",
      done: skipped ? false : scheduledDone,
      active: st === "scheduled",
      when: whenScheduled,
    },
    {
      key: "picked_up",
      label: "Picked up",
      done: st === "picked_up",
      active: st === "picked_up",
      when: fmtCt(d.picked_up_at),
    },
  ];
}

function clip60(raw: string): string {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 60) : t;
}

/** Same sentence the office bell uses, for the save confirmation line. */
export function smsPreview(target: string, spot: string): string {
  const place = clip60(spot);
  const who = clip60(target);
  if (who === "stock (no job)") {
    const text = `Parts in for stock (no job) - staged at ${place}.`;
    return text.length > 280 ? text.slice(0, 280) : text;
  }
  const text = `Parts in for ${who} - staged at ${place} - ready to schedule.`;
  return text.length > 280 ? text.slice(0, 280) : text;
}
