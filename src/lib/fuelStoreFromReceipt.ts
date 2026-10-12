/**
 * Fuel receipt store # - ONLY what is printed on this receipt.
 * Brand from the top of the slip; number from a labeled store line. Never a guess.
 */
export type ReceiptStore = {
  brand: string | null;
  store_id: string | null;
  /** "7-Eleven 41980" or null when no number is printed */
  store_label: string | null;
  needs_review: boolean;
  reason: string | null;
};

export type BrandAlias = { key: string; brand: string };

const BRANDS: { brand: string; re: RegExp }[] = [
  { brand: "7-Eleven", re: /\b7\s*[-\s]?\s*EL[E3]V[E3]N\b|\b7\s*[-\s]?\s*EL[E3]U[E3]N\b|\bTHANK\s*HEAVEN\b|\bTHANK\s*HE[AR]U[E3]N\b|\bHE[AR][VU][E3]N\b/i },
  { brand: "Stripes", re: /\bSTR[I1L]P[E3][SA]?\b|\bS[I1]R[I1]PES\b|\b5TRIPES?\b/i },
  { brand: "Circle K", re: /\bCIRCLE\s*K\b|\bCIRCLEK\b|\bC[I1L]R[CE][CTL][CE]\s*K\b/i },
  { brand: "Murphy USA", re: /\bMURPHY\s*USA\b/i },
  { brand: "Murphy Express", re: /\bMURPHY\s*EXPRESS\b/i },
  { brand: "Sunoco", re: /\bSUNOCO\b/i },
  { brand: "Shell", re: /\bSHELL\b/i },
  { brand: "Exxon", re: /\bEXXON\b/i },
  { brand: "Valero", re: /\bVALERO\b/i },
  { brand: "H-E-B", re: /\bH-?E-?B\b/i },
];

const HEADER_LINES = 8;

/** Normal store-# lengths per brand. Outside this range we still show what is printed, but flag review. */
const BRAND_ID_LEN: Record<string, number[]> = {
  "7-Eleven": [5],
  Stripes: [3, 4, 5],
  "Circle K": [4, 7],
  "Murphy USA": [4],
  "Murphy Express": [4],
};

function headerLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, HEADER_LINES);
}

export function normAliasKey(line: string): string {
  return line.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().slice(0, 40);
}

/** Brand printed at the top of THIS receipt (footer text such as "7-eleven.com" is ignored). */
export function brandFromHeader(text: string, aliases: BrandAlias[] = []): string | null {
  const head = headerLines(text);
  for (const line of head) {
    for (const b of BRANDS) if (b.re.test(line)) return b.brand;
  }
  if (aliases.length) {
    for (const line of head) {
      const k = normAliasKey(line);
      if (k.length < 4) continue;
      const hit = aliases.find((a) => a.key === k);
      if (hit) return hit.brand;
    }
  }
  return null;
}

/** Store numbers printed on a labeled line, best first. */
export function labeledStoreIds(text: string, brand: string | null): string[] {
  const out: string[] = [];
  const add = (v: string | undefined) => {
    if (v && /^\d{3,8}$/.test(v) && !out.includes(v)) out.push(v);
  };
  // 1) Brand + number on the same header line: "Stripes #40823", "Circle K 2741849", "Murphy USA 7738"
  for (const line of headerLines(text)) {
    const m = line.match(/\b(?:STR[I1L]P[E3][SA]?|CIRCLE\s*K|MURPHY\s*(?:USA|EXPRESS))\s*#?\s*(\d{3,8})\b/i);
    if (m) add(m[1]);
  }
  // 2) STORE: 41980 / STORE # 41980 / STORE NO 41980 / STORE NUMBER 41980
  for (const m of text.matchAll(/\bSTORE\s*(?:NO\.?|NUMBER|NUM|#)?\s*[:#]?\s*(\d{3,8})\b/gi)) add(m[1]);
  // 3) Murphy SITE: 7738
  if (!brand || /murphy/i.test(brand)) {
    for (const m of text.matchAll(/\bSITE\s*[:#]\s*(\d{3,8})\b/gi)) add(m[1]);
  }
  // 4) ST# 2213 / ST #2213
  for (const m of text.matchAll(/\bST\s*#\s*(\d{3,8})\b/gi)) add(m[1]);
  return out;
}

export function storeFromReceiptText(text: string, aliases: BrandAlias[] = []): ReceiptStore {
  const brand = brandFromHeader(text || "", aliases);
  const ids = labeledStoreIds(text || "", brand);
  const id = ids[0] ?? null;
  if (!id) {
    return {
      brand,
      store_id: null,
      store_label: null,
      needs_review: true,
      reason: brand ? `No store # printed on the ${brand} receipt` : "No store # or brand found on the receipt",
    };
  }
  if (!brand) {
    return { brand: null, store_id: id, store_label: `Store ${id}`, needs_review: true, reason: "Store # found but no brand at the top of the receipt" };
  }
  const lens = BRAND_ID_LEN[brand];
  if (lens && !lens.includes(id.length)) {
    return { brand, store_id: id, store_label: `${brand} ${id}`, needs_review: true, reason: `Store # ${id} has an unusual length for ${brand} (check the photo)` };
  }
  if (ids.length > 1) {
    return { brand, store_id: id, store_label: `${brand} ${id}`, needs_review: true, reason: `Receipt shows more than one store #: ${ids.join(", ")}` };
  }
  return { brand, store_id: id, store_label: `${brand} ${id}`, needs_review: false, reason: null };
}

/** Server guard: is the saved store's number printed on a labeled line of this receipt text? */
export function storeMatchesReceiptText(saved: string | null | undefined, text: string | null | undefined): boolean {
  if (!saved || !text) return false;
  const d = (String(saved).match(/\d{3,8}/g) || []).sort((a, b) => b.length - a.length)[0];
  if (!d) return false;
  return labeledStoreIds(text, brandFromHeader(text)).includes(d);
}

/** "7 Eleven 42360" / "7-Eleven" / "stripes #2221" -> canonical brand ("7-Eleven" / "Stripes"); null if not a known brand. */
export function canonicalBrand(label: string | null | undefined): string | null {
  const s = String(label || "").replace(/#?\s*\d{3,}.*$/, "").trim();
  if (!s) return null;
  for (const b of BRANDS) if (b.re.test(s)) return b.brand;
  return null;
}

/**
 * Header line that may be taught as a brand alias (Save & verify).
 * Only the first 3 lines; never lines with a 3+ digit run, address, city, phone or date words.
 */
export function aliasCandidateLine(text: string): string | null {
  for (const line of headerLines(text || "").slice(0, 3)) {
    const k = normAliasKey(line);
    if (k.length < 4 || k.length > 40) continue;
    if ((k.match(/[A-Z]/g) || []).length < 4) continue;
    if (/\d{3,}/.test(k)) continue;
    if (/\b(TX|RD|ST|AVE|HWY|BLVD|DR|LN|PKWY|CORPUS|CHRISTI|PHONE|TEL|DATE|TIME|RECEIPT|WELCOME|STORE|SITE)\b/.test(k)) continue;
    return k;
  }
  return null;
}
