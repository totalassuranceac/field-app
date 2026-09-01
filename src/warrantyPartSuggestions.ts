/** Common warranty part names — type-ahead for techs. */
export const WARRANTY_PART_SUGGESTIONS: string[] = [
  "Compressor",
  "Control board",
  "Contactor",
  "Capacitor",
  "Condenser fan motor",
  "Blower motor",
  "Indoor blower motor",
  "Outdoor fan motor",
  "Draft inducer motor",
  "Evaporator coil",
  "Condenser coil",
  "TXV / expansion valve",
  "Reversing valve",
  "Pressure switch",
  "Flame sensor",
  "Ignitor",
  "Inducer motor",
  "Gas valve",
  "Limit switch",
  "Transformer",
  "Circuit board",
  "ECM module",
  "Blower wheel",
  "Fan blade",
  "Filter drier",
  "Accumulator",
  "Crankcase heater",
  "Hard start kit",
  "Thermostat",
  "Sensor",
  "Relay",
];

export function isCompressorPartName(name: string): boolean {
  const n = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) return false;
  // Match compressor / comp (not "compartment", "complete", etc.)
  if (/\bcompressors?\b/.test(n)) return true;
  if (/^comp\b/.test(n) || /\bcomp\b/.test(n)) {
    if (/\bcompartment\b|\bcomplete\b|\bcompactor\b|\bcompany\b/.test(n)) return false;
    return true;
  }
  return false;
}

function scoreSuggestion(query: string, candidate: string): number {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase();
  if (!q) return 0;
  if (c === q) return 1000;
  if (c.startsWith(q)) return 500 + (q.length / c.length) * 100;
  const words = c.split(/\s+/);
  if (words.some((w) => w.startsWith(q))) return 300 + q.length * 10;
  if (c.includes(q)) return 100 + q.length;
  // fuzzy: all query chars in order
  let i = 0;
  for (const ch of c) {
    if (ch === q[i]) i++;
    if (i >= q.length) return 50 + q.length;
  }
  return 0;
}

/** Rank suggestions for what the tech typed (plus optional learned names). */
export function suggestWarrantyParts(
  query: string,
  extras: string[] = [],
  limit = 6
): string[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const pool = [...new Set([...extras, ...WARRANTY_PART_SUGGESTIONS])];
  return pool
    .map((name) => ({ name, score: scoreSuggestion(q, name) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((x) => x.name);
}
