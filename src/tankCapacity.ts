/**
 * Mirror of worker/tankCapacity.ts — keep in sync.
 * Conservative OEM tank capacities (gallons) by make/model.
 */
export function suggestTankCapacity(
  make: string | null | undefined,
  model: string | null | undefined
): number | null {
  const m = `${make || ""} ${model || ""}`.toLowerCase().replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim();
  if (!m) return null;

  if (/fork\s*lift|forklift|8fgu/.test(m)) return null;
  if (/transit/.test(m)) return 31;
  if (/raptor/.test(m)) return 36;
  if (/f[\s-]?150/.test(m)) return 26;
  if (/e[\s-]?250|e[\s-]?350/.test(m)) return 35;
  if (/f[\s-]?250|f[\s-]?350|super\s*duty/.test(m)) return 34;
  if (/express/.test(m)) return 31;
  if (/promaster|pro\s*master/.test(m)) return 24;
  if (/\bnv\b|nv1500|nv\s*cargo/.test(m)) return 28;
  if (/compass/.test(m)) return 13.5;
  if (/jetta/.test(m)) return 13.2;
  if (/4runner|4[\s-]?runner/.test(m)) return 23;
  return null;
}
