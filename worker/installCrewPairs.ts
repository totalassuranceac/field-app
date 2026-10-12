/**
 * Chris HARD LOCK install crews — lead first, helper second.
 * Used by Ops Performance + Day Board pair merge.
 * ST helpers: Jaden De la Garza; Warren Engel (lead first-name match).
 * Rank/display order elsewhere is by production; this only defines who rides with whom.
 */
export type HardLockInstallPair = {
  /** Lead first name (match FA display_name / employee name) */
  lead: string;
  /** Helper first name */
  helper: string;
};

/** Exact Chris lock — do not reorder leads/helpers. */
export const HARD_LOCK_INSTALL_PAIRS: readonly HardLockInstallPair[] = [
  { lead: "Beto", helper: "Geo" },
  { lead: "Kai", helper: "Charles" },
  { lead: "Marcus", helper: "Jaden" },
  { lead: "Warren", helper: "Lurch" },
] as const;

function normToken(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/** First name token for matching (Jaden De la Garza; Jayden alias OK). */
export function firstNameToken(full: string): string {
  const t = String(full || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  return normToken(t.split(/\s+/)[0] || "");
}

export function namesMatchHint(displayName: string, hint: string): boolean {
  const first = firstNameToken(displayName);
  const h = normToken(hint);
  if (!first || !h) return false;
  if (first === h) return true;
  if ((h === "jayden" && first === "jaden") || (h === "jaden" && first === "jayden")) {
    return true;
  }
  return first.startsWith(h) || h.startsWith(first);
}

export type NamedPerson = { id: number; display_name: string };

/**
 * Resolve HARD LOCK pairs to FA user ids (lead → helper).
 * Skips a pair if lead or helper cannot be matched.
 */
export function resolveHardLockPairs<T extends NamedPerson>(
  people: T[]
): Array<{ lead: T; helper: T }> {
  const unused = new Set(people.map((p) => p.id));
  const out: Array<{ lead: T; helper: T }> = [];

  const pick = (hint: string): T | null => {
    const hits = people.filter(
      (p) => unused.has(p.id) && namesMatchHint(p.display_name, hint)
    );
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const exact = hits.filter(
        (p) => firstNameToken(p.display_name) === normToken(hint)
      );
      if (exact.length === 1) return exact[0];
      return hits[0];
    }
    return null;
  };

  for (const pair of HARD_LOCK_INSTALL_PAIRS) {
    const lead = pick(pair.lead);
    if (!lead) continue;
    unused.delete(lead.id);
    const helper = pick(pair.helper);
    if (!helper) {
      unused.add(lead.id);
      continue;
    }
    unused.delete(helper.id);
    out.push({ lead, helper });
  }
  return out;
}
