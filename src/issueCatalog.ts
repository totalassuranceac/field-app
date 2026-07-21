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
  { value: "other", label: "Other (describe)", severity: "medium", emergency: false },
] as const;

export type DriverIssueCode = (typeof DRIVER_ISSUE_OPTIONS)[number]["value"];

export function driverIssueLabel(code: string | null | undefined): string {
  if (!code) return "Issue";
  return DRIVER_ISSUE_OPTIONS.find((o) => o.value === code)?.label || code;
}

/** Mechanic diagnosis buckets (more specific). */
export const MECHANIC_DIAGNOSIS = [
  "Diagnose / road test",
  "Flat repair / plug",
  "Tire replacement",
  "Battery test / replace",
  "Starter / alternator",
  "Oil change",
  "Oil leak repair",
  "Coolant system / radiator",
  "Brake pads / rotors",
  "Brake hydraulic",
  "Transmission service / repair",
  "A/C recharge / repair",
  "Electrical diagnostics",
  "Sensor / computer",
  "Belts / hoses",
  "Suspension / steering",
  "Lights / wiring",
  "Body / glass",
  "Other (see work performed)",
] as const;
