/**
 * Fuzzy street-address matching for office invoice lookup.
 * Shared rules with worker/addressFuzzy.ts — keep in sync.
 */

const STREET_ALIASES: Record<string, string> = {
  st: "street",
  street: "street",
  rd: "road",
  road: "road",
  dr: "drive",
  drive: "drive",
  ln: "lane",
  lane: "lane",
  ct: "court",
  court: "court",
  ave: "avenue",
  avenue: "avenue",
  blvd: "boulevard",
  boulevard: "boulevard",
  townhouse: "townhouse",
  "town house": "townhouse",
};

const STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "at",
  "on",
  "in",
  "to",
  "for",
  "and",
  "unit",
  "apt",
  "suite",
  "ste",
  "#",
]);

export function normalizeAddress(raw: string | null | undefined): string {
  let s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[.,'"#/\\_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Join "town house" before tokenizing
  s = s.replace(/\btown\s+house\b/g, "townhouse");
  const tokens = s
    .split(" ")
    .map((t) => STREET_ALIASES[t] || t)
    .filter(Boolean);
  return tokens.join(" ").replace(/\s+/g, " ").trim();
}

/** Include house numbers as significant (22, 22a). */
export function significantTokens(normalized: string): string[] {
  return significantTokensLoose(normalized);
}

export function significantTokensLoose(normalized: string): string[] {
  return normalized
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => {
      if (!t || STOP.has(t)) return false;
      if (/^\d+[a-z]?$/.test(t)) return true;
      return t.length >= 2;
    });
}

export function addressContainsQuery(address: string, query: string): boolean {
  const a = normalizeAddress(address);
  const q = normalizeAddress(query);
  if (!a || !q) return false;
  if (a.includes(q) || q.includes(a)) return true;
  const qTokens = significantTokensLoose(q);
  if (qTokens.length < 2) {
    // Single meaningful token: require containment
    return qTokens.length === 1 && a.includes(qTokens[0]);
  }
  let hits = 0;
  for (const t of qTokens) {
    if (a.includes(t)) hits += 1;
  }
  return hits >= 2;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[a.length][b.length];
}

export type FuzzyAddressScore = {
  address: string;
  score: number; // higher = better
  match: "contain" | "tokens" | "near";
};

export function scoreAddressMatch(address: string, query: string): FuzzyAddressScore | null {
  const a = normalizeAddress(address);
  const q = normalizeAddress(query);
  if (!a || !q) return null;
  if (a.includes(q) || q.includes(a)) {
    return { address, score: 100 + Math.min(a.length, 40), match: "contain" };
  }
  const qTokens = significantTokensLoose(q);
  const aTokens = new Set(significantTokensLoose(a));
  let shared = 0;
  for (const t of qTokens) if (aTokens.has(t) || a.includes(t)) shared += 1;
  if (shared >= 2) {
    return { address, score: 50 + shared * 10, match: "tokens" };
  }
  // Near-miss: shared 1 token + small edit distance on street portion
  if (shared >= 1 && q.length >= 4) {
    const dist = editDistance(a.slice(0, 48), q.slice(0, 48));
    if (dist <= Math.max(3, Math.floor(q.length * 0.35))) {
      return { address, score: 20 - dist + shared * 5, match: "near" };
    }
  }
  if (q.length >= 5) {
    const dist = editDistance(a.slice(0, 48), q.slice(0, 48));
    if (dist <= 3) return { address, score: 15 - dist, match: "near" };
  }
  return null;
}

export function pickDidYouMean(
  candidates: string[],
  query: string,
  limit = 5
): string[] {
  const scored: { address: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const key = normalizeAddress(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const s = scoreAddressMatch(raw, query);
    if (s && (s.match === "near" || s.match === "tokens")) {
      scored.push({ address: raw.trim(), score: s.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.address);
}
