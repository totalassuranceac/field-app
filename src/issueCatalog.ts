/** Driver-facing common repair choices (simple language). */
export const DRIVER_ISSUE_OPTIONS = [
  { value: "flat_tire", label: "Flat tire / blowout", severity: "critical", emergency: true },
  { value: "battery", label: "Battery / won’t start (electrical)", severity: "high", emergency: false },
  { value: "wont_start", label: "Won’t start (engine)", severity: "high", emergency: false },
  { value: "overheating", label: "Overheating", severity: "critical", emergency: true },
  { value: "oil_leak", label: "Oil leak", severity: "high", emergency: false },
  { value: "coolant_leak", label: "Coolant leak", severity: "high", emergency: false },
  { value: "brakes", label: "Brakes / soft pedal / noise", severity: "critical", emergency: false },
  { value: "transmission", label: "Transmission / shifting", severity: "high", emergency: false },
  { value: "steering", label: "Steering / alignment feel", severity: "high", emergency: false },
  { value: "ac_heat", label: "A/C or heat not working", severity: "medium", emergency: false },
  { value: "lights", label: "Lights / signals", severity: "medium", emergency: false },
  { value: "warning_light", label: "Dashboard warning light", severity: "medium", emergency: false },
  { value: "noise", label: "Unusual noise / vibration", severity: "medium", emergency: false },
  { value: "glass", label: "Glass / mirror damage", severity: "medium", emergency: false },
  { value: "body", label: "Body damage / accident", severity: "high", emergency: false },
  { value: "dash_cam", label: "Dash cam missing / not working", severity: "medium", emergency: false },
  { value: "gps", label: "GPS tracker missing / not working", severity: "medium", emergency: false },
  { value: "other", label: "Other (describe)", severity: "medium", emergency: false },
] as const;

export type DriverIssueCode = (typeof DRIVER_ISSUE_OPTIONS)[number]["value"];

export function driverIssueLabel(code: string | null | undefined): string {
  if (!code) return "Issue";
  return DRIVER_ISSUE_OPTIONS.find((o) => o.value === code)?.label || code;
}

/**
 * Shop multi-select: vehicle issues / tech concerns (check all that apply).
 * Stored on the ticket as a joined list for the work record.
 */
export const SHOP_CONCERN_OPTIONS = [
  "Customer / tech concern (see notes)",
  "Road test / verify complaint",
  "Flat tire / plug",
  "Tire replacement",
  "Battery test / replace",
  "Starter / alternator",
  "Won’t start / no crank",
  "Overheating",
  "Oil change",
  "Oil leak",
  "Coolant leak / radiator",
  "Brake pads / rotors",
  "Brake hydraulic / soft pedal",
  "Transmission / shifting",
  "Steering / alignment",
  "Suspension",
  "A/C not cooling",
  "Heat not working",
  "Electrical / wiring",
  "Sensor / computer",
  "Belts / hoses",
  "Lights / signals",
  "Glass / mirror",
  "Body damage",
  "Dash cam",
  "GPS tracker",
  "Door / latch / window",
  "Other (describe in problem found)",
] as const;

/** @deprecated use SHOP_CONCERN_OPTIONS — kept for older imports */
export const MECHANIC_DIAGNOSIS = SHOP_CONCERN_OPTIONS;

const CONCERN_SEP = " · ";

export function parseShopConcerns(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  // Prefer separator; fall back to single legacy value
  if (raw.includes(CONCERN_SEP)) {
    return raw
      .split(CONCERN_SEP)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (raw.includes("|")) {
    return raw
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [raw.trim()];
}

export function joinShopConcerns(tags: string[]): string {
  return tags
    .map((t) => t.trim())
    .filter(Boolean)
    .join(CONCERN_SEP);
}

/** Pack diagnostics + work into work_performed for storage without a new column. */
export function packWorkPerformed(diagnostics: string, work: string): string | null {
  const d = diagnostics.trim();
  const w = work.trim();
  if (!d && !w) return null;
  if (d && w) return `Diagnostics / troubleshooting:\n${d}\n\nWork performed:\n${w}`;
  if (d) return `Diagnostics / troubleshooting:\n${d}`;
  return w;
}

export function unpackWorkPerformed(raw: string | null | undefined): {
  diagnostics: string;
  work: string;
} {
  const s = (raw || "").trim();
  if (!s) return { diagnostics: "", work: "" };
  const diagMark = /Diagnostics\s*\/\s*troubleshooting:\s*\n?/i;
  const workMark = /\n\nWork performed:\s*\n?/i;
  if (diagMark.test(s) && workMark.test(s)) {
    const parts = s.split(workMark);
    const diagPart = parts[0].replace(diagMark, "").trim();
    const workPart = (parts[1] || "").trim();
    return { diagnostics: diagPart, work: workPart };
  }
  if (diagMark.test(s) && !workMark.test(s)) {
    return { diagnostics: s.replace(diagMark, "").trim(), work: "" };
  }
  // Legacy plain "work performed" text
  return { diagnostics: "", work: s };
}
