/**
 * Conservative OEM tank capacities (gallons) by make/model.
 * Prefer the larger common factory size so extended tanks don't false-alarm;
 * office can lower/raise per unit on Vehicles.
 */
export function suggestTankCapacity(
  make: string | null | undefined,
  model: string | null | undefined
): number | null {
  const m = `${make || ""} ${model || ""}`.toLowerCase().replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim();
  if (!m) return null;

  // Non-fuel / skip
  if (/fork\s*lift|forklift|8fgu/.test(m)) return null;

  // Ford Transit — OEM ~25.1 or ~30.5/31; use 31
  if (/transit/.test(m)) return 31;

  // F-150 Raptor before generic F-150
  if (/raptor/.test(m)) return 36;
  if (/f[\s-]?150/.test(m) || (/\bford\b/.test(m) && /\bf[\s-]?150\b/.test(m))) return 26;

  // E-series vans / box (before "Super Duty" — E-350 Super Duty is not an F-250)
  if (/e[\s-]?250|e[\s-]?350/.test(m)) return 35;

  // Super Duty / F-250 / F-350
  if (/f[\s-]?250|f[\s-]?350|super\s*duty/.test(m)) return 34;

  // Chevy / GMC Express
  if (/express/.test(m)) return 31;

  // Ram ProMaster
  if (/promaster|pro\s*master/.test(m)) return 24;

  // Nissan NV
  if (/\bnv\b|nv1500|nv\s*cargo/.test(m)) return 28;

  if (/compass/.test(m)) return 13.5;
  if (/jetta/.test(m)) return 13.2;
  if (/4runner|4[\s-]?runner/.test(m)) return 23;

  // Bare "Ford F-250" sometimes stored with make null, model only — already covered
  return null;
}

/** Effective capacity: stored value, else make/model suggestion. */
export function resolveTankCapacity(
  stored: number | null | undefined,
  make: string | null | undefined,
  model: string | null | undefined
): number | null {
  if (stored != null && Number.isFinite(Number(stored)) && Number(stored) > 0) {
    return Number(stored);
  }
  return suggestTankCapacity(make, model);
}
