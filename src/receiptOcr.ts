/**
 * Client-side receipt OCR tuned for Total Assurance local fuel stops:
 *  - Stripes (Corpus / Port Aransas) — GALLONS: / 29.531G / ST#2213 / DATE …
 *  - Circle K — "16.238 Gallons @ $x" / XXXXXXXXXXXX5017 / store site #
 *  - Murphy USA / Murphy Express — SITE: / QTY(GAL): / ************0058
 *
 * Extracts: date+time, store, card last 4, gallons, total.
 * Rule: prefer printed labels over reverse-math (total÷price invents 0.001 errors).
 * Odometer is never read from the receipt (handwritten notes ignored).
 */

export interface ReceiptParseResult {
  gallons: number | null;
  total_cost: number | null;
  fuel_date: string | null;
  fuel_time: string | null;
  store_number: string | null;
  card_last4: string | null;
  store_name: string | null;
  raw_text: string;
  confidence: "high" | "medium" | "low";
  needs_retake: boolean;
  missing_core: string[];
  missing_extra: string[];
  /** true when receipt looks like prepay (total only, no gallons) */
  is_prepay: boolean;
}

function pad2(n: string | number) {
  return String(n).padStart(2, "0");
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 2000 || year > 2100) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  const now = new Date();
  const diffDays =
    (d.getTime() - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000;
  // Receipts can be filed a bit late; allow ~18 months back
  if (diffDays > 3 || diffDays < -550) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseTime(h: number, m: number, ampm?: string | null): string | null {
  if (m < 0 || m > 59) return null;
  let hour = h;
  if (ampm) {
    const ap = ampm.toUpperCase().replace(/\./g, "");
    if (ap.startsWith("P") && hour < 12) hour += 12;
    if (ap.startsWith("A") && hour === 12) hour = 0;
  }
  if (hour < 0 || hour > 23) return null;
  return `${pad2(hour)}:${pad2(m)}`;
}

export function parseReceiptDateTime(text: string): { fuel_date: string | null; fuel_time: string | null } {
  // Soft-clean OCR junk in times/dates (Circle K header + footer are fragile on phones)
  const cleaned = text
    .replace(/\r/g, "\n")
    // glue spaced dates: 6 / 7 / 2026 → 6/7/2026
    .replace(/(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})\s*[\/\-\.]\s*(\d{2,4})/g, "$1/$2/$3")
    // time with space in seconds: 13:44: 44 → 13:44:44
    .replace(/(\d{1,2}:\d{2}):\s+(\d{2})\b/g, "$1:$2")
    .replace(/(\d{1,2}:\d{2}):(\d)[^\d\s\n]*/g, "$1:0$2") // 19:43:5¢ → 19:43:05
    .replace(/(\d{1,2}:\d{2}):([^\d\s\n]+)/g, "$1") // drop fully garbage seconds
    // Circle K footer OCR: E2026 15:44:44 / 0G/07/2026 — try to salvage MM/DD/YYYY when 0/O glued
    .replace(/\b[O0E](\d)[\/\-.](\d{1,2})[\/\-.](\d{4})\b/gi, "0$1/$2/$3")
    .replace(/\b[O0](\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/g, "$1/$2/$3");
  const candidates: { iso: string; time: string | null; score: number }[] = [];

  const push = (y: number, mo: number, d: number, time: string | null, score: number) => {
    const iso = toIsoDate(y, mo, d);
    if (iso) candidates.push({ iso, time, score: score + (time ? 3 : 0) });
  };

  // Stripes / Circle K / 7-Eleven datetime patterns
  const patterns: { re: RegExp; score: number }[] = [
    // Circle K header: 6/7/2026 1:45:05 PM (single-digit month/day + AM/PM)
    {
      re: /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|A\.M\.|P\.M\.|am|pm)\b/gi,
      score: 24,
    },
    // DATE M/D/YY H:MM[:SS] [AM/PM]
    {
      re: /DATE\s*[:#]?\s*(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|A\.M\.|P\.M\.)?/gi,
      score: 20,
    },
    // 7-Eleven / Circle K footer: 06/07/2026 13:44:44 (24h, full year)
    {
      re: /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM|A\.M\.|P\.M\.|am|pm))?/gi,
      score: 22,
    },
    // M/D/YYYY H:MM only (seconds OCR failed): 10/02/2025 19:43
    {
      re: /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\s+(\d{1,2}):(\d{2})\b/g,
      score: 19,
    },
    // M/D/YY H:MM:SS AM/PM  (Stripes footer — often "2/23/26 12:00:59 PM" or "pM")
    {
      re: /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|A\.M\.|P\.M\.|am|pm)/gi,
      score: 17,
    },
    // Murphy USA header: 07-17-26  08:37  (2-digit year, 24h, no AM/PM)
    {
      re: /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g,
      score: 18,
    },
    // Footer with junk prefix: "0 2/23/26 12:00:59 pM" / "CSH: 0 2/23/26 …"
    {
      re: /(?:CSH|ST\s*#|DR\s*#|TRAN|Order)[^\n]{0,40}?(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|A\.M\.|P\.M\.|am|pm)?/gi,
      score: 16,
    },
    // M/D/YYYY H:MM:SS 24h (no am/pm)
    {
      re: /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g,
      score: 14,
    },
    // Labeled date only
    {
      re: /(?:DATE|TRAN\s*DATE|TRANS(?:ACTION)?\s*DATE)\s*[:#]?\s*(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/gi,
      score: 12,
    },
    // Zero-padded footer without word boundary before month: 06/07/2026 13:44:44 glued to junk
    {
      re: /(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/g,
      score: 15,
    },
  ];

  for (const { re, score } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned))) {
      // Patterns with time have groups 1,2,3 date and 4,5 time
      if (m[4] != null && m[5] != null && !Number.isNaN(Number(m[4]))) {
        let y = Number(m[3]);
        if (y < 100) y += 2000;
        const ampm = m[7] || null;
        // If first group is 4-digit year (unlikely in these patterns)
        if (String(m[1]).length === 4) {
          push(Number(m[1]), Number(m[2]), Number(m[3]), parseTime(Number(m[4]), Number(m[5]), ampm), score);
        } else {
          push(y, Number(m[1]), Number(m[2]), parseTime(Number(m[4]), Number(m[5]), ampm), score);
        }
      } else {
        let y = Number(m[3]);
        if (y < 100) y += 2000;
        if (String(m[1]).length === 4) {
          push(Number(m[1]), Number(m[2]), Number(m[3]), null, score);
        } else {
          push(y, Number(m[1]), Number(m[2]), null, score);
        }
      }
    }
  }

  // Bare US dates (lower score) — never beat a datetime match
  for (const mm of cleaned.matchAll(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/g)) {
    let y = Number(mm[3]);
    if (y < 100) y += 2000;
    push(y, Number(mm[1]), Number(mm[2]), null, 4);
  }

  if (!candidates.length) return { fuel_date: null, fuel_time: null };
  // Prefer higher score; among ties prefer one WITH time, then most recent date
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (Boolean(b.time) !== Boolean(a.time)) return a.time ? -1 : 1;
    return a.iso < b.iso ? 1 : -1;
  });
  return { fuel_date: candidates[0].iso, fuel_time: candidates[0].time };
}

/** @deprecated */
export function parseReceiptDate(text: string): string | null {
  return parseReceiptDateTime(text).fuel_date;
}

function parsePricePerGal(joined: string, lines: string[]): number | null {
  // Normalize common OCR junk around SELF @ price (2.759/ G → 2.7597 6, etc.)
  // Circle K: $3.699/Gal  /  $3.699/Ga1  /  $3.699 / Gal
  const soft = joined
    .replace(/(\d)\s+\.\s+(\d)/g, "$1.$2")
    .replace(/SELF\s*@\s*\$?\s*(\d+\.\d{2,4})\d?\s*[\/\s]*[G6]/gi, "SELF @ $1 / G")
    .replace(/\/\s*Ga[l1I|]\b/gi, "/Gal");

  // Prefer explicit PRICE/G line (Stripes Weber layout) — keep full thousandths ($2.319 not $2.31)
  for (const line of lines) {
    const m = line.match(/PRICE\s*\/\s*G(?:AL)?\s*[:#]?\s*\$?\s*(\d+\.\d{2,4})/i);
    if (m) {
      const p = parseFloat(m[1]);
      if (p > 1.2 && p < 12) return Math.round(p * 1000) / 1000; // 3 decimals for pump price
    }
  }

  const patterns = [
    /PRICE\s*\/\s*G(?:AL)?\s*[:#]?\s*\$?\s*(\d+\.\d{2,4})/i,
    // Circle K: 25.029 Gallons @ $3.699/Gal
    /@\s*\$?\s*(\d+\.\d{2,4})\s*\/\s*GAL/i,
    /@\s*\$?\s*(\d+\.\d{2,4})\s*\/\s*Ga[l1I|]/i,
    /GAL\s*@\s*\$?\s*(\d+\.\d{2,4})\s*\/?\s*GAL/i,
    // Stripes: SELF @ 2.759 / G  (OCR often loses slash or turns G into 6)
    /SELF\s*@\s*\$?\s*(\d+\.\d{2,4})\s*[\/\s]*G/i,
    /SELF\s*@\s*\$?\s*(\d+\.\d{3})\d?\b/i,
    /@\s*\$?\s*(\d+\.\d{3})\s*[\/\s]*G\b/i,
  ];
  for (const re of patterns) {
    const m = soft.match(re) || joined.match(re);
    if (m) {
      let p = parseFloat(m[1]);
      // OCR sometimes appends a digit: 2.7597 → 2.759
      if (p >= 10 && p < 100) p = p / 10;
      if (p > 1.2 && p < 12) {
        return Math.round(p * 1000) / 1000;
      }
    }
  }
  for (const line of lines) {
    // Prefer full thousandths on SELF @ 2.249 / G (not 2.25)
    const self3 = line.match(/SELF\s*@\s*\$?\s*(\d+\.\d{3})\d?\s*[\/\s]*G/i);
    if (self3) {
      const p = parseFloat(self3[1]);
      if (p > 1.2 && p < 12) return Math.round(p * 1000) / 1000;
    }
    const m =
      line.match(/(\d+\.\d{2,4})\s*\/\s*GAL/i) ||
      line.match(/(\d+\.\d{2,4})\s*\/\s*Ga[l1I|]/i) ||
      line.match(/SELF\s*@\s*\$?\s*(\d+\.\d{2,4})/i) ||
      line.match(/@\s*\$?\s*(\d+\.\d{3})\d?\s*[\/\s6]*G?/i);
    if (m) {
      let p = parseFloat(m[1]);
      if (p > 1.2 && p < 12) return Math.round(p * 1000) / 1000;
    }
  }
  return null;
}

/** True when a number is almost certainly $/gal, not gallons (e.g. SELF @ 2.659 / G). */
function looksLikePricePerGal(n: number): boolean {
  return n >= 1.2 && n <= 9.5;
}

function parseGallons(joined: string, lines: string[], totalCost: number | null): number | null {
  const candidates: { n: number; score: number }[] = [];
  const ppgKnown = parsePricePerGal(joined, lines);
  // Money totals on the slip — never treat these as gallons (55.79 was wrongly used as gal)
  const moneyTotals = new Set<number>();
  for (const line of lines) {
    for (const n of moneyOnLine(line)) {
      if (n >= 10) moneyTotals.add(Math.round(n * 100) / 100);
    }
  }
  if (totalCost != null && totalCost >= 10) {
    moneyTotals.add(Math.round(totalCost * 100) / 100);
  }

  const tryAdd = (raw: string, score: number) => {
    const n = parseFloat(String(raw).replace(/,/g, "").replace(/O/gi, "0"));
    // Pump gallons almost always have decimals; reject whole-dollar amounts (often $ totals)
    if (!(n > 0.5 && n < 120)) return;
    if (Number.isInteger(n) && score < 15) return;
    // Never treat price-per-gallon as gallons
    if (ppgKnown != null && Math.abs(n - ppgKnown) < 0.02) return;
    if (looksLikePricePerGal(n) && score < 20) return;
    // Never treat the $ total as gallons (Stripes: 20.220G 55.79)
    const rounded2 = Math.round(n * 100) / 100;
    if (moneyTotals.has(rounded2) && score < 28) return;
    // Stripes qty is almost always 3 decimals (20.220); pure .xx that equals a $ amount is money
    const dec = String(raw).split(".")[1] || "";
    if (dec.length === 2 && moneyTotals.has(rounded2) && n >= 15) return;
    candidates.push({ n, score });
  };

  // Murphy / Walmart fuel: QTY(GAL): 22.679 — highest trust (printed pump qty, never invent)
  const printedQty = extractPrintedQtyGallons(lines, joined);
  if (printedQty != null) tryAdd(String(printedQty), 50);

  // Stripes / 7-Eleven: GALLONS: 21.701 or GALLONS      5.167 (spaces, no colon)
  for (const line of lines) {
    // Skip pure price/gal lines (Murphy PRICE/GAL: $3.429)
    if (/PRICE\s*\/\s*GAL|NET\s*\/\s*GAL|\$\s*\/\s*GAL/i.test(line) && !/QTY|GALLONS?\s*[:#]/i.test(line)) {
      continue;
    }
    if (!/GALLON|GAL\s*:|QTY|BprLEN|GALL|BALLON|UNLEAD/i.test(line)) continue;
    // Clean common OCR: ] } l I as trailing 1; O as 0; BALLONS → GALLONS
    const cleaned = line
      .replace(/BALLONS?/gi, "GALLONS")
      .replace(/[Oo]/g, "0")
      .replace(/(\d)[\]\}lI|]\b/g, "$11")
      .replace(/(\d+\.\d{2})[\]\}lI|]/g, "$11")
      .replace(/(\d),(\d)/g, "$1.$2"); // 5,167 → 5.167 rare
    const m =
      cleaned.match(/QTY\s*\(\s*GAL(?:LON)?S?\s*\)\s*[:#]?\s*(\d+\.\d{1,4})/i) ||
      cleaned.match(/GALLONS?\s*[:#]?\s*(\d+\.\d{1,4})/i) ||
      cleaned.match(/(?:GALLON|GAL)\s*[:#]?\s*(\d+\.\d{1,4})/i) ||
      // 7-Eleven: GALLONS right-aligned qty without colon
      cleaned.match(/GALLONS?\s+(\d+\.\d{1,4})\b/i) ||
      line.match(/GALLONS?\s*[:#]?\s*(\d+\.\d{1,4})/i);
    if (m) tryAdd(m[1], 30);
  }
  for (const m of joined.matchAll(/GALLONS?\s*[:#]?\s*(\d+\.\d{1,4})/gi)) tryAdd(m[1], 20);
  for (const m of joined.matchAll(/GALLONS?\s+(\d+\.\d{1,4})\b/gi)) tryAdd(m[1], 28);

  // Circle K: 16.238 Gallons @ $2.799 / 25.029 Gallons @ $3.699/Gal
  for (const m of joined.matchAll(/(\d+\.\d{1,4})\s*GALLONS?\b/gi)) tryAdd(m[1], 20);
  // OCR: 25.O29 Gallons / 25,029 Gallons @
  for (const m of joined.matchAll(/([0-9O]{1,2}\.[0-9O]{2,4})\s*GALLONS?\s*@/gi)) {
    tryAdd(m[1].replace(/O/gi, "0"), 34);
  }
  // Line form: "25.029 Gallons @ $3.699/Gal     $92.58"
  for (const line of lines) {
    const ck =
      line.match(/\b(\d{1,2}\.\d{2,4})\s*GALLONS?\s*@/i) ||
      line.match(/\b([0-9O]{1,2}\.[0-9O]{2,4})\s*GALLONS?\s*@/i);
    if (ck) tryAdd(ck[1].replace(/O/gi, "0"), 36);
  }

  // Stripes qty: 15.408G / 29.531G / 20.220G (must have G — never bare 2.659 price)
  for (const m of joined.matchAll(/\b(\d{1,2}\.\d{2,4})\s*G\b/gi)) tryAdd(m[1], 24);
  for (const m of joined.matchAll(/\b(\d{1,2}\.\d{2,4})G\b/gi)) tryAdd(m[1], 24);
  // OCR: 2O.22OG / 20.2206 (O→0, trailing G glued as 6)
  // Important: 23.195G often OCRs as 23.1956 — take only 3 decimals, drop the fake 6
  for (const m of joined.matchAll(/\b([0-9O]{1,2}\.[0-9O]{3})[6G]\b/gi)) {
    tryAdd(m[1].replace(/O/gi, "0"), 26);
  }
  for (const m of joined.matchAll(/\b([0-9O]{1,2}\.[0-9O]{2,4})\s*[G6]\b/gi)) {
    const raw = m[1].replace(/O/gi, "0");
    // If 4+ decimals ending from G→6 (23.1956), keep first 3 decimal places
    const parts = raw.split(".");
    if (parts[1] && parts[1].length >= 4) {
      tryAdd(`${parts[0]}.${parts[1].slice(0, 3)}`, 25);
    } else {
      tryAdd(raw, 22);
    }
  }

  // Classic Stripes product row: UNLD CR #07 23.195G 52.17  (qty G then amount)
  // Also: 23.1956 52.17 when G OCR'd as trailing 6
  for (const m of joined.matchAll(
    /(?:UNLD|NLD|DSL|DIESEL|UNLEADED|RUL|REG|PREM|CR\s*#?\s*\d+)[^\n]{0,48}?\b(\d{1,2}\.\d{3})(?:[6G]|\s*G)?\s+(\d{1,3}\.\d{2})\b/gi
  )) {
    tryAdd(m[1], 36);
    moneyTotals.add(parseFloat(m[2]));
  }
  for (const m of joined.matchAll(
    /(?:UNLD|NLD|DSL|DIESEL|UNLEADED|RUL|REG|PREM|CR\s*#?\s*\d+)[^\n]{0,48}?\b(\d{1,2}\.\d{2,4})\s*G\b[^\n]{0,12}?(\d{1,3}\.\d{2})\b/gi
  )) {
    tryAdd(m[1], 32);
    moneyTotals.add(parseFloat(m[2]));
  }

  // UNLD CR #09 15.408G 40.97  — qty is the xx.xxxG token
  for (const m of joined.matchAll(
    /(?:UNLD|NLD|DSL|DIESEL|UNLEADED|RUL|REG|PREM|CR\s*#?\s*\d+)[^\n]{0,40}?\b(\d{1,2}\.\d{2,4})\s*G\b/gi
  )) {
    tryAdd(m[1], 28);
  }

  // 7-Eleven style: 21 GAL @ 2.319 /GAL   (qty BEFORE "GAL @", never the price after @)
  for (const m of joined.matchAll(
    /\b(\d{1,2}(?:\.\d{1,3})?)\s*GAL\s*@\s*\$?\d+\.\d{2,4}\s*\/?\s*GAL/gi
  )) {
    tryAdd(m[1], 21);
  }

  // Line context — never treat PREPAY / price-per-gal as gallons
  for (const line of lines) {
    if (/PREPAY|PRE-?AUTH|SUB\s*TOTAL|SUBTOTAL|PRICE\/G|TAX|CREDIT|FUEL\s*TO|TOTAL|USD\s*\$/i.test(line)) {
      continue;
    }
    // Stripes / Sunoco price-only lines: "SELF @ 2.659 / G" — NEVER gallons
    if (/SELF\s*@/i.test(line)) continue;
    if (/@\s*\$?\d+\.\d{2,4}\s*\/\s*G\b/i.test(line) && !/\d+\.\d+\s*G\b/i.test(line)) continue;
    // Qty before GAL @
    const qtyAt = line.match(/\b(\d{1,2}(?:\.\d{1,3})?)\s*GAL\s*@/i);
    if (qtyAt) {
      tryAdd(qtyAt[1], 21);
      continue;
    }
    // Skip pure "GAL @ 2.319 /GAL" or "/ G" price lines (no qty)
    if (/GAL\s*@\s*\$?\d+\.\d+/i.test(line)) continue;
    if (/\/\s*G(?:AL)?\b/i.test(line) && !/\b\d{1,2}\.\d{2,4}\s*G\b/i.test(line)) continue;

    // Fuel product lines: only accept a number that is clearly gallons (…G)
    if (/DSL|UNLD|NLD|DIESEL|UNLEAD|CR\s*#|RUL|REG|PREM/i.test(line)) {
      const withG =
        line.match(/\b(\d{1,2}\.\d{2,4})\s*G\b/i) ||
        line.match(/\b(\d{1,2}\.\d{2,4})G\b/i) ||
        // 23.1956 where G became 6, often followed by amount 52.17
        line.match(/\b(\d{1,2}\.\d{3})6\b/);
      if (withG) {
        tryAdd(withG[1], 26);
        continue;
      }
      // Bare 3-decimal qty + money on same line (G lost in OCR): 20.220 55.79
      const monies = [...line.matchAll(/\b(\d{1,3}\.\d{2})\b/g)].map((x) => parseFloat(x[1]));
      const bare3 = line.match(/\b(\d{1,2}\.\d{3})\b/);
      if (bare3) {
        const n = parseFloat(bare3[1]);
        const isMoney = monies.some((m) => Math.abs(m - n) < 0.001);
        if (!isMoney && n >= 5 && n < 80 && !looksLikePricePerGal(n)) {
          tryAdd(bare3[1], monies.length ? 22 : 12);
        }
      }
      // 4-decimal OCR of G-token: 23.1956 52.17 → use 23.195
      const bare4 = line.match(/\b(\d{1,2}\.\d{3})(\d)\b/);
      if (bare4 && monies.length) {
        const n = parseFloat(bare4[1]);
        if (n >= 5 && n < 80 && !looksLikePricePerGal(n)) tryAdd(bare4[1], 30);
      }
    }
  }

  if (candidates.length) {
    // Prefer realistic fill sizes over price-per-gal noise; prefer 3-decimal pump qty
    // Strongly prefer labeled QTY / GALLONS (score ≥ 30) over reverse-math noise
    candidates.sort((a, b) => {
      const aPpg = looksLikePricePerGal(a.n) ? -8 : 0;
      const bPpg = looksLikePricePerGal(b.n) ? -8 : 0;
      const a3 = (String(a.n).split(".")[1] || "").length >= 3 ? 2 : 0;
      const b3 = (String(b.n).split(".")[1] || "").length >= 3 ? 2 : 0;
      const aLabeled = a.score >= 30 ? 10 : 0;
      const bLabeled = b.score >= 30 ? 10 : 0;
      return b.score + bPpg + b3 + bLabeled - (a.score + aPpg + a3 + aLabeled) || b.n - a.n;
    });
    let best = candidates[0].n;
    const bestScore = candidates[0].score;
    // Printed / labeled qty always wins — never replace with total÷price
    if (bestScore >= 30) {
      return roundGallons(best);
    }
    // If top pick still looks like $/gal and we have total, derive instead
    if (looksLikePricePerGal(best) && totalCost != null && totalCost > 5) {
      const derived = totalCost / best;
      if (derived > 3 && derived < 100) {
        return roundGallons(derived);
      }
    }
    // If top pick equals the $ total, prefer pump-math when possible
    if (totalCost != null && Math.abs(best - totalCost) < 0.02 && ppgKnown) {
      const derived = totalCost / ppgKnown;
      if (derived > 3 && derived < 100) return roundGallons(derived);
    }
    return roundGallons(best);
  }

  // Fallback: gallons ≈ total ÷ price/gal ONLY when no printed qty exists
  // (Murphy: 85.48÷3.769 ≈ 22.680 but slip says QTY 22.679 — never invent)
  if (printedQty != null) return roundGallons(printedQty);
  if (totalCost != null && totalCost > 5) {
    const ppg = ppgKnown || parsePricePerGal(joined, lines);
    if (ppg) {
      const derived = totalCost / ppg;
      if (derived > 1 && derived < 100) {
        return roundGallons(derived);
      }
    }
  }

  return null;
}

/**
 * Pull the exact printed gallons from QTY(GAL) / GALLONS labels.
 * OCR-tolerant for Murphy Express / USA slips. Never invent from math.
 */
function extractPrintedQtyGallons(lines: string[], joined: string): number | null {
  const softLine = (line: string) =>
    line
      // OCR: 0TY → QTY, QIY → QTY
      .replace(/\b[O0]TY\b/gi, "QTY")
      .replace(/\bQIY\b/gi, "QTY")
      .replace(/\bQTYCGAL\b/gi, "QTY(GAL)")
      .replace(/QTY\s*[Cc]\s*GAL/gi, "QTY(GAL)")
      .replace(/[Oo](?=\d)/g, "0");

  const tryParse = (raw: string): number | null => {
    const n = parseFloat(String(raw).replace(/,/g, "").replace(/O/gi, "0"));
    if (!(n > 0.5 && n < 120)) return null;
    if (looksLikePricePerGal(n)) return null;
    return roundGallons(n);
  };

  // Line-by-line: labeled qty is ground truth
  for (const raw of lines) {
    const line = softLine(raw);
    // Skip pure price lines
    if (/PRICE\s*\/\s*GAL|NET\s*\/\s*GAL/i.test(line) && !/QTY/i.test(line)) continue;
    const m =
      line.match(/QTY\s*\(\s*GAL(?:LON)?S?\s*\)\s*[:#]?\s*(\d+\.\d{1,4})/i) ||
      line.match(/QTY\s*[:#]\s*(\d+\.\d{1,4})/i) ||
      line.match(/QTY\s+GAL(?:LON)?S?\s*[:#]?\s*(\d+\.\d{1,4})/i) ||
      line.match(/QUANTITY\s*\(?\s*GAL(?:LON)?S?\s*\)?\s*[:#]?\s*(\d+\.\d{1,4})/i) ||
      // "QTY(GAL) 22.679" with odd spacing / missing colon
      line.match(/QTY[^\d]{0,12}(\d{1,2}\.\d{3})\b/i);
    if (m) {
      const n = tryParse(m[1]);
      if (n != null) return n;
    }
  }

  // Full text
  const softJoined = softLine(joined);
  for (const re of [
    /QTY\s*\(\s*GAL(?:LON)?S?\s*\)\s*[:#]?\s*(\d+\.\d{1,4})/gi,
    /QTY\s*[:#]\s*(\d+\.\d{1,4})\s*(?:GAL)?/gi,
  ]) {
    const m = re.exec(softJoined);
    if (m) {
      const n = tryParse(m[1]);
      if (n != null) return n;
    }
  }

  return null;
}

/** Pump gallons use thousandths (16.290) — keep 3 decimals, not 16.29. */
export function roundGallons(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Format for form fields: always show 3 decimal places when from pump. */
export function formatGallonsDisplay(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "";
  return roundGallons(n).toFixed(3);
}

/** Pull currency amounts from a line; prefer $xx.xx forms. */
function moneyOnLine(line: string): number[] {
  const out: number[] = [];
  // Collapse OCR spaces inside amounts: "55. 78" / "55 .79" / "USD$55. 78"
  const soft = line.replace(/(\d)\s+\.\s*(\d)/g, "$1.$2").replace(/(\d)\.\s+(\d{2})\b/g, "$1.$2");

  // $55.76 or $ 55.76
  for (const m of soft.matchAll(/\$\s*(\d{1,4}\.\d{2})\b/g)) {
    out.push(parseFloat(m[1]));
  }
  // USD$55.76 / USD$55. 78
  for (const m of soft.matchAll(/USD\s*\$?\s*(\d{1,4}\.\d{2})\b/gi)) {
    out.push(parseFloat(m[1]));
  }
  // Bare xx.xx — only if no $ amounts found (avoid price/gal noise when $ present)
  if (!out.length) {
    for (const m of soft.matchAll(/\b(\d{1,4}\.\d{2})\b/g)) {
      out.push(parseFloat(m[1]));
    }
  }
  // OCR dropped the dollar and tens digit run-on: "S55.76" / "B55.76"
  for (const m of soft.matchAll(/[S5B$]\s*(\d{2,3}\.\d{2})\b/gi)) {
    const n = parseFloat(m[1]);
    if (n >= 10) out.push(n);
  }
  return out.filter((n) => n >= 1 && n < 1000);
}

/**
 * If OCR dropped a leading digit ($55.76 → $5.76), recover using gallons × price/gal.
 */
function recoverTotalFromMpg(
  candidates: number[],
  gallons: number | null,
  ppg: number | null
): number | null {
  if (gallons == null || ppg == null || gallons < 1 || ppg < 1.2) return null;
  const expected = gallons * ppg;
  if (expected < 5 || expected > 800) return null;

  // Exact-ish match already in candidates
  for (const n of candidates) {
    if (Math.abs(n - expected) <= 0.08 || Math.abs(n - expected) / expected <= 0.02) {
      return Math.round(n * 100) / 100;
    }
  }

  // Dropped leading digit: 5.76 vs 55.76
  for (const n of candidates) {
    if (n >= 10) continue;
    const s = n.toFixed(2); // "5.76"
    for (let d = 1; d <= 9; d++) {
      const cand = parseFloat(String(d) + s);
      if (Math.abs(cand - expected) <= 0.12 || Math.abs(cand - expected) / expected <= 0.03) {
        return Math.round(cand * 100) / 100;
      }
    }
  }

  // Trust pump math when labeled total is missing/corrupt
  if (expected >= 8 && expected <= 500) {
    return Math.round(expected * 100) / 100;
  }
  return null;
}

/**
 * When FUEL SALE + CREDIT DE + USD$ agree (classic Stripes), that amount wins.
 * Stops pump-math / bad OCR (50.57) from beating the real $50.32 on the slip.
 */
function consensusLabeledTotal(lines: string[], joined: string): number | null {
  const votes = new Map<string, { n: number; w: number }>();
  const bump = (n: number, w: number) => {
    if (!(n >= 5 && n < 800)) return;
    const key = n.toFixed(2);
    const cur = votes.get(key);
    if (cur) cur.w += w;
    else votes.set(key, { n, w });
  };

  for (const line of lines) {
    const monies = moneyOnLine(line);
    if (!monies.length) continue;
    const n = monies[monies.length - 1];
    // Allow OCR of FUEL SAE / FUEL SA E
    if (/FUEL\s*SA/i.test(line)) bump(n, 4);
    if (/FUEL\s*TOTAL/i.test(line)) bump(n, 5); // 7-Eleven / Murphy
    if (/NET\s*TOTAL/i.test(line)) bump(n, 5); // Murphy USA
    if (/CARD\s*AMT/i.test(line)) bump(n, 4); // Murphy card charge
    if (/CREDIT\s*DE/i.test(line)) bump(n, 4);
    if (/USD\s*\$/i.test(line)) bump(n, 5);
    // Circle K: Total: $92.58 / Visa: $92.58 / Sub. Total: $92.58
    if (/\bTOTAL\s*:/i.test(line) && !/SUB|DISCOUNT/i.test(line)) bump(n, 5);
    if (/\bVISA\s*:/i.test(line) && n >= 8) bump(n, 4);
    if (/SUB\.?\s*TOTAL/i.test(line) && n >= 8) bump(n, 3);
    if (/\bTOTAL\b/i.test(line) && !/SUB/i.test(line) && !/PRICE|DISCOUNT/i.test(line)) bump(n, 2);
  }
  const joinedSoft = joined.replace(/(\d)\s+\.\s*(\d)/g, "$1.$2").replace(/(\d)\.\s+(\d{2})\b/g, "$1.$2");
  for (const m of joinedSoft.matchAll(/USD\s*\$?\s*(\d{1,4}\.\d{2})\b/gi)) {
    bump(parseFloat(m[1]), 5);
  }

  const ranked = [...votes.values()].sort((a, b) => b.w - a.w || b.n - a.n);
  if (!ranked.length) return null;
  // Strong consensus: same amount from 2+ labeled sources
  if (ranked[0].w >= 8) return Math.round(ranked[0].n * 100) / 100;
  // USD$ alone is still very reliable on Stripes
  if (ranked[0].w >= 5) return Math.round(ranked[0].n * 100) / 100;
  return null;
}

/**
 * TOTAL is critical — prefer FUEL SALE / CREDIT DE / USD$ / TOTAL lines.
 * Cross-check with gallons × price/gal so $55.76 is not misread as $5.76.
 * Never let imprecise gal×price invent a different total (e.g. $50.57 vs $50.32).
 */
function parseTotalCost(
  joined: string,
  lines: string[],
  gallons: number | null = null
): number | null {
  const ppg = parsePricePerGal(joined, lines);

  // 1) Labeled consensus first — this is the cash amount on the slip
  const consensus = consensusLabeledTotal(lines, joined);
  if (consensus != null) {
    // Only repair truncated OCR ($5.76 vs $55.76), never replace $50.32 with $50.57 math
    if (gallons != null && ppg != null && consensus < 12) {
      const expected = gallons * ppg;
      if (expected >= 15) {
        const s = consensus.toFixed(2);
        for (let d = 1; d <= 9; d++) {
          const cand = parseFloat(String(d) + s);
          if (Math.abs(cand - expected) <= 0.15) return Math.round(cand * 100) / 100;
        }
      }
    }
    return consensus;
  }

  const scores: { n: number; score: number }[] = [];

  for (const line of lines) {
    // Never take price-per-gallon as the total
    if (/PRICE\s*\/\s*G|PER\s*GAL|GAL\s*@|\/\s*GAL\b/i.test(line) && !/TOTAL|SALE|CREDIT|USD/i.test(line)) {
      continue;
    }

    const monies = moneyOnLine(line);
    if (!monies.length) continue;
    // On a labeled total line, use the last (usually the amount column)
    const n = monies[monies.length - 1];

    let score = 0;
    if (/FUEL\s*TOTAL/i.test(line)) score = 32; // 7-Eleven / Murphy
    else if (/NET\s*TOTAL/i.test(line)) score = 31; // Murphy USA
    else if (/CARD\s*AMT/i.test(line)) score = 30; // Murphy card charge line
    else if (/FUEL\s*SA/i.test(line)) score = 30;
    else if (/\bCREDIT\s*DE\b/i.test(line)) score = 28;
    else if (/\bTOTAL\s*SALE\b/i.test(line)) score = 27;
    else if (/\bTOTAL\s*FUEL\b/i.test(line)) score = 26;
    else if (/\bFUEL\s*TO\b/i.test(line)) score = 25;
    // Circle K labeled Total: $92.58 (not Discount Total / Sub. Total)
    else if (/\bTOTAL\s*:/i.test(line) && !/SUB|DISCOUNT/i.test(line)) score = 30;
    else if (/\bVISA\s*:/i.test(line) && n >= 8) score = 26;
    else if (/USD\s*\$/i.test(line)) score = 24;
    else if (/\bTOTAL\b/i.test(line) && !/SUB\s*TOTAL|SUBTOTAL|DISCOUNT/i.test(line)) score = 22;
    else if (/^CREDIT\b/i.test(line.trim()) || /\bCREDIT\b/i.test(line)) score = 20;
    else if (/\bSUBTOTAL|SUB\.?\s*TOTAL\b/i.test(line)) score = 14;
    else if (/\bamount\b/i.test(line)) score = 14;
    else if (/\$\s*\d+\.\d{2}/.test(line) && monies.length === 1 && n >= 10) score = 8;
    else continue;

    // Prefer realistic fill totals over pocket-change OCR mistakes
    if (n >= 15) score += 4;
    if (n < 8) score -= 8;
    // Small bonus only for tight pump-math match (was +20 and could promote wrong totals)
    if (gallons != null && ppg != null) {
      const exp = gallons * ppg;
      if (Math.abs(n - exp) <= 0.08) score += 8;
      else if (Math.abs(n - exp) > 0.5) score -= 6; // penalize amounts that fight pump math
    }

    scores.push({ n, score });
  }

  // Explicit USD$55.76 anywhere (also "USD$55. 78" OCR space)
  const joinedSoft = joined.replace(/(\d)\s+\.\s*(\d)/g, "$1.$2").replace(/(\d)\.\s+(\d{2})\b/g, "$1.$2");
  for (const m of joinedSoft.matchAll(/USD\s*\$?\s*(\d{1,4}\.\d{2})\b/gi)) {
    const n = parseFloat(m[1]);
    let score = 28;
    if (n >= 15) score += 4;
    scores.push({ n, score });
  }

  if (scores.length) {
    scores.sort((a, b) => b.score - a.score || b.n - a.n);
    let best = scores[0].n;
    const topScore = scores[0].score;

    // Only repair clearly truncated OCR ($5.76 vs $55.76). Never overwrite a solid
    // labeled total like $50.32 with imprecise gal×price (e.g. 21.7 × 2.33 → $50.57).
    if (gallons != null && ppg != null) {
      const expected = gallons * ppg;
      if (best < 12 && expected >= 15) {
        const s = best.toFixed(2);
        let fixed: number | null = null;
        for (let d = 1; d <= 9; d++) {
          const cand = parseFloat(String(d) + s);
          if (Math.abs(cand - expected) <= 0.15 || Math.abs(cand - expected) / expected <= 0.025) {
            fixed = cand;
            break;
          }
        }
        if (fixed != null) best = fixed;
        else if (topScore < 18) best = expected; // weak labels only
      }
    }

    return Math.round(best * 100) / 100;
  }

  // No labeled total — last resort gallons × price
  if (gallons != null && ppg != null) {
    const expected = gallons * ppg;
    if (expected >= 8 && expected <= 500) return Math.round(expected * 100) / 100;
  }

  const all = [...joined.matchAll(/\$\s*(\d{1,4}\.\d{2})\b/g)]
    .map((x) => parseFloat(x[1]))
    .filter((n) => n >= 10 && n < 500);
  if (all.length) return Math.max(...all);
  return null;
}

/**
 * Prefer the printed gallons token over reverse math when product already matches.
 * When OCR flipped one digit in qty (25.079 vs 25.029), try single-digit repairs
 * that make gallons × price ≈ total — prefer that over raw total÷price (25.028…).
 */
function refineGallonsToTotal(
  gallons: number | null,
  total: number | null,
  ppg: number | null
): number | null {
  if (gallons == null) return null;
  if (total == null || ppg == null || ppg < 1.2 || total < 5) return roundGallons(gallons);
  const err0 = Math.abs(gallons * ppg - total);
  if (err0 <= 0.08) return roundGallons(gallons);

  // Single-digit flips in the 3-decimal pump qty (thermal OCR)
  const base = roundGallons(gallons).toFixed(3);
  const [whole, frac = "000"] = base.split(".");
  let best = gallons;
  let bestErr = err0;
  const tryCand = (n: number) => {
    if (!(n > 0.5 && n < 120)) return;
    const e = Math.abs(n * ppg - total);
    if (e < bestErr - 1e-9) {
      bestErr = e;
      best = n;
    }
  };
  for (let i = 0; i < Math.min(3, frac.length); i++) {
    for (let d = 0; d <= 9; d++) {
      if (String(d) === frac[i]) continue;
      const nf = frac.slice(0, i) + String(d) + frac.slice(i + 1);
      tryCand(parseFloat(`${whole}.${nf}`));
    }
  }
  // Also allow one-digit flip in the whole part (less common)
  for (let i = 0; i < whole.length; i++) {
    for (let d = 0; d <= 9; d++) {
      if (String(d) === whole[i]) continue;
      if (i === 0 && d === 0) continue;
      const nw = whole.slice(0, i) + String(d) + whole.slice(i + 1);
      tryCand(parseFloat(`${nw}.${frac}`));
    }
  }

  if (bestErr <= 0.08) return roundGallons(best);
  // Last resort: derived total÷price only when OCR is badly off
  if (err0 > 0.4) {
    const derived = total / ppg;
    if (derived > 1 && derived < 120 && Math.abs(derived - gallons) <= 0.25) {
      return roundGallons(derived);
    }
  }
  return roundGallons(gallons);
}

/** Store IDs for our stations are always numeric (never OCR junk like "KKK"). */
function cleanStoreDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  // Reject pure letters / repeated garbage (*** often OCRs as KKK, XXX, etc.)
  if (!/\d/.test(t)) return null;
  if (/^(.)\1{2,}$/i.test(t)) return null;
  if (/^[A-Za-z*#xX•·]+$/.test(t)) return null;
  // Prefer extracting the first sensible digit group
  const digits = t.match(/\d{3,8}/);
  if (!digits) return null;
  const n = digits[0];
  // Ignore year-like and phone fragments
  if (/^20\d{2}$/.test(n)) return null;
  if (n.length >= 10) return null;
  return n;
}

/**
 * Fleet Stripes locations — street OCR is often clearer than the brand line
 * ("VSirine i" instead of "Stripes 2221", but "6418 Weber" still reads).
 * 2221 is by far the most-used store in this fleet.
 */
const STRIPES_LOCATION_HINTS: { re: RegExp; id: string }[] = [
  // Stripes 2221 — Weber Rd, Corpus Christi (6418 / 6814 both appear on slips)
  { re: /\bweber\b/i, id: "2221" },
  { re: /\bw[e3]b[e3]r\b/i, id: "2221" }, // OCR: W3ber, etc.
  { re: /\b6[48]18\b/, id: "2221" },
  { re: /361[\s\-]?855[\s\-]?8865/, id: "2221" },
  { re: /361[\s\-]?\d{0,3}[\s\-]?8865/, id: "2221" }, // partial phone OCR
  // Stripes 5216 — South Padre Island Dr
  { re: /south\s*padre|s\.?\s*p\.?\s*i\.?\s*d/i, id: "5216" },
  { re: /\b601\b[^\n]{0,20}padre/i, id: "5216" },
  { re: /361[\s\-]?814[\s\-]?8206/, id: "5216" },
  // Stripes 9386 — NAS Drive / Navy Dr
  { re: /\bnavy\b|\bn\.?a\.?s\.?\b/i, id: "9386" },
  { re: /361[\s\-]?937[\s\-]?0251/, id: "9386" },
  // Stripes 40823 — Rodd Field Rd
  { re: /\brodd\s*field\b/i, id: "40823" },
  { re: /361[\s\-]?985[\s\-]?0998/, id: "40823" },
];

/**
 * Fleet Circle K locations — brand line often OCRs as Cirele/Circte; street+phone still read.
 * Only apply when street/phone match — never invent a store from a wrong prior receipt.
 */
const CIRCLEK_LOCATION_HINTS: { re: RegExp; id: string }[] = [
  // Circle K 2706973 — 2730 Agnes St, Corpus Christi
  { re: /\bagnes\b/i, id: "2706973" },
  { re: /\b2730\b[^\n]{0,24}agnes/i, id: "2706973" },
  { re: /361[\s\-]?888[\s\-]?9397/, id: "2706973" },
  // Circle K 2741849 — 2202 Holly Rd, Corpus Christi
  { re: /\bholly\s*r/i, id: "2741849" },
  { re: /\b2202\b[^\n]{0,24}holly/i, id: "2741849" },
  { re: /361[\s\-]?854[\s\-]?7769/, id: "2741849" },
  // Circle K 2741135 — E Causeway (from prior slips)
  { re: /\bcauseway\b/i, id: "2741135" },
  { re: /\b4502\b[^\n]{0,24}causeway/i, id: "2741135" },
];

/** Soft Circle K brand — OCR: Circte K, Cirele K, CIRCLEK, C1rcle K */
const CIRCLE_K_BRAND_RE =
  /\b(?:CIRCLE\s*K|CIRCLEK|C[I1L]RC[IL1]E\s*K|C[I1L]R[CE][CTL][CE]\s*K|CIRCTE\s*K|CIRELE\s*K|CIRCKE\s*K)\b/i;

function isCircleK(text: string): boolean {
  if (CIRCLE_K_BRAND_RE.test(text)) return true;
  // Layout signature when brand fails: N.NNN Gallons @ $x.xxx/Gal + Pay at Pump / UNL-REG
  if (
    /\d+\.\d{2,4}\s*GALLONS?\s*@/i.test(text) &&
    /(?:UNL-?REG|PAY\s*AT\s*PUMP|DUPLICATE\s*RECEIPT|CARD\s*NUM)/i.test(text)
  ) {
    return true;
  }
  // Fleet address alone on a fuel slip
  for (const h of CIRCLEK_LOCATION_HINTS) {
    if (h.re.test(text) && /\d+\.\d{2,4}\s*GALLONS?\s*@|TOTAL\s*:|USD\s*\$/i.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Fix common Circle K brand OCR before field parsers run.
 * "Cirele K 2741849" → "Circle K 2741849"
 */
function normalizeCircleKText(text: string): string {
  return text
    .replace(/\bCIRCLEK\b/gi, "Circle K")
    .replace(/\bC[I1L]RC[IL1]E\s*K\b/gi, "Circle K")
    .replace(/\bC[I1L]R[CE][CTL][CE]\s*K\b/gi, "Circle K")
    .replace(/\bCIRCTE\s*K\b/gi, "Circle K")
    .replace(/\bCIRELE\s*K\b/gi, "Circle K")
    .replace(/\bCIRCKE\s*K\b/gi, "Circle K");
}

function looksLikeStripesReceipt(text: string): boolean {
  // Never treat 7-Eleven as Stripes (OH THANK HEAVEN / FUEL TOTAL / PRICE/GAL)
  if (isSevenEleven(text)) return false;
  return (
    /strip|strine|sirine|5trip|vsir|welcome\s*to/i.test(text) ||
    (/\bGALLONS?\s*:/i.test(text) && /\bPRICE\s*\/\s*G|FUEL\s*SALE|CREDIT\s*DE\b/i.test(text)) ||
    (/\bweber\b|south\s*padre/i.test(text) && !/\bSTORE\s*[:#]/i.test(text))
  );
}

/** Street numbers mistaken for store IDs (6418 Weber → not store 6418). */
function isStreetNotStoreId(id: string, nearby: string): boolean {
  if (/weber|padre|rd\b|road|dr\b|drive|ave|street|hwy|spid/i.test(nearby)) return true;
  // House numbers on known fleet streets
  if (id === "6418" || id === "6814" || id === "601") return true;
  return false;
}

function isSevenEleven(text: string): boolean {
  return (
    /\b7[\s\-]?ELEVEN\b/i.test(text) ||
    /\b7\s*EL[E3]V[E3]N\b/i.test(text) ||
    // Slogan when brand OCR fails: "OH THANK HEAVEN"
    /\bTHANK\s+HEAVEN\b/i.test(text) ||
    (/\bSTORE\s*[:#]\s*\d{4,6}\b/i.test(text) && /\bPRICE\s*\/\s*GAL|FUEL\s*TOTAL\b/i.test(text))
  );
}

/** Murphy USA, Murphy Express, and same-format SITE/QTY slips. */
function isMurphyReceipt(text: string): boolean {
  return (
    /\bMURPHY\s*(?:USA|EXPRESS|DRIVE)\b/i.test(text) ||
    /\bmurphyusa\.com\b/i.test(text) ||
    /\bmurphydrive\b/i.test(text) ||
    (/\bMURPHY\b/i.test(text) && /\bSITE\s*[:#]/i.test(text)) ||
    // Same layout without brand OCR: SITE + QTY(GAL) or FUEL TOTAL + PRICE/GAL
    (/\bSITE\s*[:#]\s*\d{3,5}\b/i.test(text) &&
      (/\bQTY\s*\(\s*GAL/i.test(text) ||
        (/\bFUEL\s*TOTAL\b/i.test(text) && /\bPRICE\s*\/\s*GAL\b/i.test(text))))
  );
}

/** Printed brand on Murphy slips (Express vs USA). */
function murphyBrandLabel(text: string): string {
  if (/\bMURPHY\s*EXPRESS\b/i.test(text)) return "Murphy Express";
  if (/\bMURPHY\s*USA\b/i.test(text)) return "Murphy USA";
  if (/\bMURPHY\s*DRIVE\b/i.test(text)) return "Murphy";
  if (/\bMURPHY\b/i.test(text)) return "Murphy";
  return "Murphy";
}

/** SITE / store IDs that must never become card last-4 (Murphy, Stripes ST#, etc.). */
function extractSiteStoreIds(text: string, lines: string[]): Set<string> {
  const ids = new Set<string>();
  const push = (raw: string | undefined | null) => {
    const id = cleanStoreDigits(raw);
    if (id && id.length >= 3 && id.length <= 6) ids.add(id);
  };
  for (const m of text.matchAll(/\bSITE\s*[:#]?\s*(\d{3,5})\b/gi)) push(m[1]);
  for (const m of text.matchAll(/\bMURPHY\s*(?:USA|EXPRESS)\s*(\d{3,5})\b/gi)) push(m[1]);
  for (const m of text.matchAll(/\bST\s*#\s*(\d{3,6})\b/gi)) push(m[1]);
  for (const m of text.matchAll(/\bSTORE\s*[:#]\s*(\d{3,6})\b/gi)) push(m[1]);
  // "Murphy Express 8691" / "Murphy USA 7738" on header
  for (const line of lines.slice(0, 8)) {
    const m = line.match(/MURPHY\s*(?:USA|EXPRESS)\s*(\d{3,5})\b/i);
    if (m) push(m[1]);
  }
  return ids;
}

function parseStore(text: string, lines: string[]): { store_number: string | null; store_name: string | null } {
  // --- Brand first: never apply Stripes address hints to a 7-Eleven / Circle K / Murphy slip ---
  // (Previously Navy/NAS → Stripes 9386 ran before 7-Eleven and hijacked Kingsville slips.)

  // --- Murphy Express 8691 / Murphy USA 7738 / SITE: #### ---
  if (isMurphyReceipt(text)) {
    const brand = murphyBrandLabel(text);
    // Header brand + store id (exact as printed when possible)
    const header =
      text.match(/\bMURPHY\s*EXPRESS\s*(\d{3,5})\b/i) ||
      text.match(/\bMURPHY\s*USA\s*(\d{3,5})\b/i) ||
      text.match(/\bMURPHY\s+(\d{3,5})\b/i);
    let id = cleanStoreDigits(header?.[1]);
    if (!id) {
      const site = text.match(/\bSITE\s*[:#]?\s*(\d{3,5})\b/i);
      id = cleanStoreDigits(site?.[1]);
    }
    if (!id) {
      for (const line of lines.slice(0, 14)) {
        const m =
          line.match(/MURPHY\s*(?:USA|EXPRESS)?\s*(\d{3,5})\b/i) ||
          line.match(/SITE\s*[:#]?\s*(\d{3,5})\b/i);
        id = cleanStoreDigits(m?.[1]);
        if (id) break;
      }
    }
    if (id) return { store_number: id, store_name: `${brand} ${id}` };
    return { store_number: null, store_name: brand };
  }

  // --- 7-Eleven: STORE:42360 ---
  if (isSevenEleven(text)) {
    const storeLine =
      text.match(/\bSTORE\s*[:#]?\s*(\d{3,6})\b/i) ||
      text.match(/\bSTORE\s*[:#]?\s*(\d{3,6})\b/i);
    // Soft OCR: STORE: 42366 vs 42360
    const id = cleanStoreDigits(storeLine?.[1]);
    if (id) return { store_number: id, store_name: `7-Eleven ${id}` };
    // Line-by-line STORE
    for (const line of lines) {
      const m = line.match(/STORE\s*[:#]?\s*(\d{3,6})/i);
      const lid = cleanStoreDigits(m?.[1]);
      if (lid) return { store_number: lid, store_name: `7-Eleven ${lid}` };
    }
    return { store_number: null, store_name: "7-Eleven" };
  }

  // --- Circle K + site number (soft brand + address fallbacks) ---
  if (isCircleK(text)) {
    // Prefer address/phone when brand is weak — 2741849 is ground truth for Holly Rd
    for (const hint of CIRCLEK_LOCATION_HINTS) {
      if (hint.re.test(text)) {
        return { store_number: hint.id, store_name: `Circle K ${hint.id}` };
      }
    }
    const withNum =
      text.match(/CIRCLE\s*K\s+(\d{4,8})\b/i) ||
      text.match(/CIRCLEK\s+(\d{4,8})\b/i) ||
      text.match(/(?:C[I1L]R[CE][CTL][CE]\s*K|CIRCTE\s*K|CIRELE\s*K)\s+(\d{4,8})\b/i);
    let id = cleanStoreDigits(withNum?.[1]);
    if (!id) {
      const idx = lines.findIndex((l) => CIRCLE_K_BRAND_RE.test(l) || /CIRCLE/i.test(l));
      if (idx >= 0) {
        for (let i = idx; i < Math.min(idx + 4, lines.length); i++) {
          // Site # is 5–8 digits; skip Order Number (often 7 digits) if labeled
          if (/ORDER\s*NUM/i.test(lines[i])) continue;
          const nums = lines[i].match(/\b(\d{5,8})\b/g);
          if (!nums) continue;
          for (const n of nums) {
            // Skip phone fragments and zip-like
            if (n === "78415" || n.length === 10) continue;
            id = cleanStoreDigits(n);
            if (id) break;
          }
          if (id) break;
        }
      }
    }
    // Bare 7-digit site in header when Gallons @ layout present
    // Prefer fleet Circle K range 270xxxx / 274xxxx; never take Order Number lines
    if (!id && /\d+\.\d{2,4}\s*GALLONS?\s*@/i.test(text)) {
      const fleet = text.match(/\b(27[04]\d{4})\b/);
      id = cleanStoreDigits(fleet?.[1]);
      if (!id) {
        for (let li = 0; li < Math.min(12, lines.length); li++) {
          const line = lines[li];
          const prevLine = li > 0 ? lines[li - 1] : "";
          if (/ORDER\s*NUM|PHONE|REGISTER|ZIP|TX\s+\d{5}/i.test(line + " " + prevLine)) {
            continue;
          }
          const m = line.match(/^\s*(\d{6,8})\s*$/);
          id = cleanStoreDigits(m?.[1]);
          if (id) break;
        }
      }
    }
    if (id) return { store_number: id, store_name: `Circle K ${id}` };
    return { store_number: null, store_name: "Circle K" };
  }

  // Circle K address when brand OCR totally failed (before Stripes street hijack)
  for (const hint of CIRCLEK_LOCATION_HINTS) {
    if (hint.re.test(text)) {
      return { store_number: hint.id, store_name: `Circle K ${hint.id}` };
    }
  }

  // Address / phone when brand OCR fails ("VSirine" + "6418 Weber" → 2221)
  for (const hint of STRIPES_LOCATION_HINTS) {
    if (hint.re.test(text)) {
      return { store_number: hint.id, store_name: `Stripes ${hint.id}` };
    }
  }

  // --- Stripes ---
  // Prefer HEADER store id: "Stripes #40823" / "Welcome To Stripes 40823"
  // Footer ST#2453 is often a register/site code on this format — use only as fallback.
  const stripesPatterns = [
    /\bSTRIPES?\s*#\s*(\d{3,6})\b/i, // explicit # (strongest)
    /\bSTRIPES?\s+(\d{3,6})\b/i,
    /\bSTR[I1L]P[E3]S?\s*#?\s*(\d{3,6})\b/i,
    /\b5TRIPES?\s*#?\s*(\d{3,6})\b/i,
    /\bS\s*T\s*R\s*I\s*P\s*E\s*S\s*#?\s*(\d{3,6})\b/i,
    /\b(?:VS?IRINE|S[I1L]RINE|STRINE|STRIP)\s*#?\s*(\d{3,6})\b/i,
  ];
  // Header region only (first ~25 lines) so footer ST# never wins first
  const headerText = lines.slice(0, 25).join("\n");
  for (const re of stripesPatterns) {
    const m = headerText.match(re) || text.match(re);
    const id = cleanStoreDigits(m?.[1]);
    if (!id) continue;
    const idx = m?.index ?? 0;
    const src = headerText.includes(m![0]) ? headerText : text;
    const nearby = src.slice(Math.max(0, idx - 8), idx + (m?.[0].length || 0) + 24);
    if (isStreetNotStoreId(id, nearby)) continue;
    return { store_number: id, store_name: `Stripes ${id}` };
  }
  // Footer ST# only if no header store found
  const stHash = text.match(/\bST\s*#\s*(\d{3,6})\b/i);
  {
    const id = cleanStoreDigits(stHash?.[1]);
    if (id && !isStreetNotStoreId(id, text)) {
      return { store_number: id, store_name: `Stripes ${id}` };
    }
  }
  // Bare store id ONLY on true Stripes slips — not every GALLONS: (7-Eleven also has GALLONS)
  if (looksLikeStripesReceipt(text) && !/\bFUEL\s*TOTAL\b|\bPRICE\s*\/\s*GAL\b/i.test(text)) {
    for (const id of ["2221", "5216", "2215", "2213", "2131", "2165", "7121", "9386"]) {
      if (new RegExp(`\\b${id}\\b`).test(text)) {
        return { store_number: id, store_name: `Stripes ${id}` };
      }
    }
  }
  // Top lines: "Welcome to" / mangled brand
  for (let i = 0; i < Math.min(12, lines.length); i++) {
    const line = lines[i];
    if (/thank|heaven|diesel|gallons|price|weber|padre|christi|eleven/i.test(line)) continue;
    if (!/strip|strlpe|str1pe|5trip|sirine|strine|vsir|welcome/i.test(line)) continue;
    const same = cleanStoreDigits(line.match(/(\d{3,5})\b/)?.[1]);
    if (same && !isStreetNotStoreId(same, line + " " + (lines[i + 1] || ""))) {
      return { store_number: same, store_name: `Stripes ${same}` };
    }
    const next = lines[i + 1] || "";
    if (/weber|padre|rd\b|road|dr\b|corpus|phone|\d{3}[\s\-]\d{3}/i.test(next)) continue;
    const nextId = cleanStoreDigits(next.match(/^\s*#?\s*(\d{3,5})\s*$/)?.[1] || next.match(/\b(\d{3,5})\b/)?.[1]);
    if (nextId && !isStreetNotStoreId(nextId, next)) {
      return { store_number: nextId, store_name: `Stripes ${nextId}` };
    }
  }

  // Generic STORE:42009 — digits only
  {
    const storeColon = text.match(/\bSTORE\s*[:#]\s*(\d{3,6})\b/i);
    const id = cleanStoreDigits(storeColon?.[1]);
    if (id) {
      return { store_number: id, store_name: `Store ${id}` };
    }
  }

  return { store_number: null, store_name: null };
}

/**
 * Map OCR confusable characters on a card-pan tail into digits.
 * e.g. "()G7Q" → "0879", "O8B9" → "0889"
 * Ignores trailing OCR junk words like "Is" / "a" after the pan line.
 */
function confusableToCardDigits(raw: string): string | null {
  const tokens = String(raw || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // Prefer last mask/digit-ish token; skip short English crumbs ("Is", "a", "ju")
  let s = "";
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (/^[A-Za-z]{1,3}$/.test(t)) continue;
    if (/[0-9*()[\]{}XxKk#OoIlBGQS]/.test(t)) {
      s = t;
      break;
    }
  }
  if (!s) s = String(raw || "").trim();
  if (!s) return null;
  // () often OCR of 0 (or empty hole in star mask)
  s = s.replace(/\(\)/g, "0").replace(/[()[\]{}]/g, "0");
  s = s
    .replace(/[OoD]/g, "0")
    .replace(/[Il|!]/g, "1")
    .replace(/[Zz]/g, "2")
    .replace(/[Aa]/g, "4")
    .replace(/[Ss]/g, "5")
    .replace(/[BbGg]/g, "8")
    .replace(/[Qq]/g, "9");
  const digits = s.replace(/\D/g, "");
  if (digits.length === 4) return digits;
  if (digits.length > 4 && digits.length <= 6) return digits.slice(-4);
  return null;
}

/**
 * Last 4 of card — Stripes: line under USD$ is ************7716 (or 6069, etc.).
 * OCR mangles stars heavily; also try any 4 digits after a long mask-like run.
 */
function parseCardLast4(text: string, lines?: string[]): string | null {
  const lineList =
    lines ||
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  const fixDigits = (s: string) =>
    s
      .replace(/O/gi, "0")
      .replace(/[Il|]/g, "1")
      // only fix S/B inside a pure 4-char digit-ish token
      .replace(/S/g, "5")
      .replace(/B/g, "8");

  const siteIds = extractSiteStoreIds(text, lineList);
  const candidates: { n: string; score: number }[] = [];
  const push = (raw: string, score: number) => {
    let n = fixDigits(raw);
    if (!/^\d{4}$/.test(n)) {
      const fixed = confusableToCardDigits(raw);
      if (!fixed) return;
      n = fixed;
    }
    if (n === "0000" || n === "1111") return;
    // Never treat store / SITE / ST# as the gas card
    if (siteIds.has(n)) return;
    // Common non-card IDs on Stripes slips (store / zip fragments)
    if (n === "2221" || n === "5216" || n === "7841" || n === "8405") return;
    // Auth # 00xx style — only reject weak non-mask hits (mask pan 0058 is real on Capital One)
    if (/^00\d{2}$/.test(n) && score < 18) return;
    candidates.push({ n, score });
  };

  // Turn almost any mask glyph into * (OCR of **** often becomes x, o, ·, etc.)
  const toMask = (s: string) =>
    s
      .replace(/[xX#•·∙●○\*※＊Xx]/g, "*")
      .replace(/[oO]{2,}(?=\d)/g, (m) => "*".repeat(m.length))
      .replace(/[kKwWmMnN]{2,}(?=\d)/g, (m) => "*".repeat(m.length));

  const maskNorm = toMask(text);

  for (const m of maskNorm.matchAll(/\*{3,}\s*(\d{4})\b/g)) push(m[1], 20);
  for (const m of maskNorm.matchAll(
    /(?:ACCT|CARD|ACCOUNT|VISA|MASTERCARD)[^\n\d]{0,48}\*{2,}\s*(\d{4})\b/gi
  )) {
    push(m[1], 24);
  }
  for (const m of text.matchAll(/X{4,}(\d{4})\b/gi)) push(m[1], 20);
  // Circle K: XXXX XXXX XXXX 7716 (spaces between mask groups)
  for (const m of text.matchAll(/(?:X{4}\s+){2,3}(\d{4})\b/gi)) push(m[1], 32);
  for (const m of maskNorm.matchAll(/(?:\*{4}\s+){2,3}(\d{4})\b/g)) push(m[1], 32);
  // Circle K: Card Num : (R) then next line XXXXXXXX7716
  for (const m of text.matchAll(/Card\s*Num[^\n]{0,60}?(?:\n[^\n]{0,40})?[X*#x]{6,}(\d{4})\b/gi)) {
    push(m[1], 38);
  }
  // OCR turns stars into letter soup: "Kdxionkkk 1845" / "xxxxxxxxxxxx1845"
  for (const m of text.matchAll(/(?:USD|TOTAL|CREDIT)[^\n]{0,80}?\b[A-Za-z*#xX]{6,}\s*(\d{4})\b/gi)) {
    push(m[1], 28);
  }
  for (const m of text.matchAll(/\b[A-Za-z*#xXkK]{8,}(\d{4})\b/g)) {
    const idx = m.index ?? 0;
    const ctx = text.slice(Math.max(0, idx - 40), idx + m[0].length + 20);
    if (/USD|TOTAL|CREDIT|ENTRY|CONTACT|VISA|ICC|CAPITAL|CARD\s*NUM/i.test(ctx)) push(m[1], 30);
  }

  // Any non-digit run of length 6+ ending in 4 digits (OCR-tolerant) — not store names
  for (const m of text.matchAll(/(?:[^\d\s]){6,}(\d{4})\b/g)) {
    const idx = m.index ?? 0;
    const ctx = text.slice(Math.max(0, idx - 24), idx + m[0].length + 4);
    if (
      /STRIP|STORE|ST#|WELCOME|WEBER|PHONE|TRAN|INVOICE|AUTH\s*#|PUMP|GALLON|STAN|AID|SHIFT/i.test(
        ctx
      )
    ) {
      continue;
    }
    push(m[1], 12);
  }

  for (let i = 0; i < lineList.length; i++) {
    const raw = lineList[i];
    const prev = i > 0 ? lineList[i - 1] : "";
    const next = i + 1 < lineList.length ? lineList[i + 1] : "";
    const prev2 = i > 1 ? lineList[i - 2] : "";

    // Never treat store # / auth / invoice / SITE / merchant lines as card last 4
    if (
      /TRAN\s*#|AUTH\s*#|INVOICE|STAN:|PUMP|GALLON|PRICE\s*\/|SHIFT|PHONE|DATE\s|AID:|REF:|BATCH|SEQ:|STAN\s|STRIPES?|ST\s*#|STORE\s*#|SITE\s*[:#]|MERCH|TRACE\s*[:#]|MURPHY|WELCOME|WEBER|EVERHART|CORPUS|SELF\s*@|UNLD|DIESEL|QTY\s*\(|FUEL\s*TOTAL|NET\s*TOTAL/i.test(
        raw
      )
    ) {
      continue;
    }

    const L = toMask(raw);

    // ************7716  (or ******7716)
    let m = L.match(/\*{2,}\s*(\d{4})\b/);
    if (m) {
      let score = 20;
      if (/USD|VISA|CARD|CREDIT|ACCT|CONTACT|CHIP|ENTRY|ICC/i.test(raw + " " + prev + " " + next)) {
        score = 30;
      }
      // Classic Stripes layout: USD$40.97 then ************7716 then Entry: Contactless
      if (/USD\s*\$|TOTAL|CREDIT\s*DE|FUEL\s*SALE|CREDIT\s*DEBIT/i.test(prev + " " + prev2)) {
        score = 36;
      }
      if (/CONTACTLESS|ENTRY|CHIP|ICC|CAPITAL\s*ONE/i.test(next)) score = Math.max(score, 34);
      push(m[1], score);
      continue;
    }

    // Mask collapsed to weird chars then 7716 at end of short line
    m = raw.match(/^[^0-9]{3,}(\d{4})\s*$/);
    if (m) {
      let score = 16;
      if (/USD\s*\$|TOTAL|CREDIT|VISA/i.test(prev)) score = 28;
      if (/CONTACTLESS|ENTRY|ICC/i.test(next)) score = 30;
      push(m[1], score);
      continue;
    }

    // Bare 4 digits alone on line right after USD$ (stars completely failed OCR)
    if (
      /^\d{4}$/.test(raw.trim()) &&
      /USD\s*\$|TOTAL|CREDIT\s*DE|FUEL\s*SALE|CREDIT\s*DEBIT/i.test(prev)
    ) {
      push(raw.trim(), 26);
      continue;
    }

    // Line is only mask + last4 with spaces: * * * * 7716
    m = L.replace(/\s+/g, "").match(/^\*{4,}(\d{4})$/);
    if (m) {
      let score = 22;
      if (/USD|TOTAL|CREDIT|VISA|SALE/i.test(prev)) score = 34;
      if (/ENTRY|CHIP|CONTACT|METHOD/i.test(next)) score = Math.max(score, 36);
      push(m[1], score);
      continue;
    }

    m = L.match(/(?:ACCT|CARD)[^\d]{0,24}\*{1,}\s*(\d{4})\b/i);
    if (m) push(m[1], 26);

    // Murphy / chip: ************0058 directly under Visa / SALE
    if (/^\*{4,}\s*\d{4}\s*$/.test(L) || /^\*{6,}\d{4}$/.test(L.replace(/\s+/g, ""))) {
      const pan = L.match(/\*{2,}\s*(\d{4})\b/);
      if (pan) {
        let score = 28;
        if (/VISA|SALE|MASTERCARD|DEBIT/i.test(prev + " " + prev2)) score = 38;
        if (/ENTRY|CHIP|METHOD|INVOICE/i.test(next)) score = Math.max(score, 40);
        push(pan[1], score);
        continue;
      }
    }

    if (/VISA|MASTERCARD|CAPITAL\s*ONE/i.test(raw)) {
      const same = raw.match(/(\d{4})\s*$/);
      if (same && !/AID|AUTH|MERCH/i.test(raw)) push(same[1], 10);
      // Card last 4 is often ABOVE the VISA line on Stripes (mask line then Entry then AppName)
      const p4 =
        prev.match(/\*{2,}\s*(\d{4})\b/) ||
        prev.match(/^[^0-9]{2,}(\d{4})\s*$/) ||
        toMask(prev).match(/\*{2,}(\d{4})/);
      if (p4) push(p4[1], 28);
      // Murphy: VISA then next line is ************0058
      const n4 =
        next.match(/\*{2,}\s*(\d{4})\b/) ||
        toMask(next).match(/\*{2,}\s*(\d{4})\b/) ||
        next.match(/^[^0-9]{2,}(\d{4})\s*$/) ||
        next.match(/^(\d{4})\s*$/);
      if (n4) push(n4[1], 36);
    }

    // After USD$ amount, next non-empty line often is the pan last4
    if (/USD\s*\$?\s*\d+\.\d{2}/i.test(raw) || /^USD/i.test(raw.trim()) || /UsD\s*\$/i.test(raw)) {
      for (let j = i + 1; j < Math.min(i + 4, lineList.length); j++) {
        const lj = lineList[j];
        const L2 = toMask(lj);
        const pan =
          L2.match(/\*{2,}\s*(\d{4})\b/) ||
          lj.match(/^[^0-9]{3,}(\d{4})\s*$/) ||
          L2.replace(/\s+/g, "").match(/^\*{4,}(\d{4})$/) ||
          // Stars fully mangled to X/K soup then last4 (or confusable tail)
          lj.match(/[XxKk*#]{6,}(\d{4})\b/) ||
          lj.match(/[XxKk*#()A-Za-z]{6,}([0-9OIlBGQS()g]{3,6})\b/);
        if (pan) {
          push(pan[1], 35);
          break;
        }
        // Whole line is mask junk + tail: XKKXKXXXKXKXX()G7Q
        const tail = confusableToCardDigits(lj.replace(/^[^*0-9A-Za-z()]+/, "").slice(-6));
        if (tail && /[XxKk*#]{4,}|ENTRY|CHIP|CONTACT/i.test(lj + " " + (lineList[j + 1] || ""))) {
          push(tail, 32);
          break;
        }
        if (/ENTRY|CHIP|CONTACTLESS|ICC/i.test(lj) && !/AUTH\s*#/i.test(lj)) {
          // Card line was skipped — try previous (already handled) or same-line tail
          break;
        }
        // Stop if we hit clearly non-card content
        if (/AUTH\s*#|INVOICE|STAN|STORE\s*#|THANKS|DIESEL|TAX/i.test(lj)) break;
      }
    }

    // Line immediately before "Entry: Chip/Contactless" / "Entry Method" is almost always the pan
    if (/ENTRY\s*:|ENTRY\s*METHOD|CHIP\s*READ|CONTACTLESS/i.test(raw)) {
      const prevL = toMask(prev);
      const pan =
        prevL.match(/\*{2,}\s*(\d{4})\b/) ||
        prev.match(/[XxKk*#]{4,}(\d{4})\b/) ||
        prev.match(/([0-9OIlBGQS()g]{4,6})\s*$/);
      if (pan) push(pan[1], 40);
      else {
        const t = confusableToCardDigits(prev.slice(-8));
        if (t && !siteIds.has(t)) push(t, 33);
      }
    }

    // Circle K: "Card Num : (R)" then mask line with last4
    if (/Card\s*Num/i.test(raw)) {
      for (let j = i; j < Math.min(i + 3, lineList.length); j++) {
        const lj = lineList[j];
        const L2 = toMask(lj);
        const pan =
          L2.match(/\*{2,}\s*(\d{4})\b/) ||
          lj.match(/[Xx*#]{6,}(\d{4})\b/) ||
          lj.match(/(?:X{4}\s+){2,3}(\d{4})\b/i);
        if (pan) {
          push(pan[1], 42);
          break;
        }
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);

  // All long pan-mask last4s. When both 1716 and 7716 appear (1↔7 OCR noise),
  // prefer the last pan-mask in the slip (card section is below totals) and any
  // form that sits on a Card Num line.
  const maskMatches = [...text.matchAll(/[X*x#]{8,}(\d{4})\b/g)].filter(
    (m) => /^\d{4}$/.test(m[1]) && m[1] !== "0000"
  );
  if (maskMatches.length) {
    const uniq = [...new Set(maskMatches.map((m) => m[1]))];
    const lastIdx = new Map<string, number>();
    for (const m of maskMatches) lastIdx.set(m[1], m.index ?? 0);
    const ranked = uniq.map((dig) => {
      const cand = candidates.find((c) => c.n === dig);
      let s = cand?.score ?? 18;
      // Later on the receipt (card block under SALE/Visa) beats early misreads
      s += Math.min(15, Math.floor((lastIdx.get(dig) || 0) / 40));
      if (new RegExp(`Card\\s*Num[^\\n]{0,80}[X*x#]{6,}${dig}`, "i").test(text)) s += 25;
      if (new RegExp(`[X*x#]{6,}${dig}[^\\n]{0,20}\\n[^\\n]{0,20}Contactless`, "i").test(text)) {
        s += 12;
      }
      return { dig, s };
    });
    ranked.sort((a, b) => b.s - a.s || (lastIdx.get(b.dig) || 0) - (lastIdx.get(a.dig) || 0));
    // Confusable 1↔7 pair: force last-on-receipt when scores are close
    if (ranked.length >= 2) {
      const a = ranked[0].dig;
      const b = ranked[1].dig;
      if (a.replace(/7/g, "1") === b.replace(/7/g, "1") && a !== b) {
        const later = (lastIdx.get(a) || 0) >= (lastIdx.get(b) || 0) ? a : b;
        if (Math.abs(ranked[0].s - ranked[1].s) <= 20) return later;
      }
    }
    return ranked[0].dig;
  }

  let best = candidates[0].n;

  // 1↔7 OCR flips when only one form was captured as a candidate
  const confusable = (n: string): string[] => {
    const out = new Set<string>([n]);
    const chars = n.split("");
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === "1") {
        const c = [...chars];
        c[i] = "7";
        out.add(c.join(""));
      } else if (chars[i] === "7") {
        const c = [...chars];
        c[i] = "1";
        out.add(c.join(""));
      }
    }
    return [...out];
  };
  for (const alt of confusable(best)) {
    if (alt === best) continue;
    if (new RegExp(`[X*x#]{6,}${alt}\\b`, "i").test(text)) {
      best = alt;
      break;
    }
    const altCand = candidates.find((c) => c.n === alt);
    if (altCand && altCand.score >= candidates[0].score - 4) {
      if (/7/.test(alt) && /1/.test(best) && !/7/.test(best)) {
        best = alt;
        break;
      }
    }
  }

  return best;
}

/** Prepay / pre-auth slips (drivers should pump first — we flag these). */
export function detectPrepay(text: string): boolean {
  return (
    /\bPRE[\s\-]?PAY\b/i.test(text) ||
    /\bPRE[\s\-]?AUTH(?:ORIZ(?:ED|E|ATION)?)?\b/i.test(text) ||
    /\bPREAUTHORIZED\b/i.test(text) ||
    /\bPREAUTH\b/i.test(text) ||
    /\*\*\s*PRE[\s\-]?AUTH/i.test(text)
  );
}

function parseReceiptText(text: string): Omit<ReceiptParseResult, "raw_text"> {
  const cleaned = text.replace(/\r/g, "\n");
  // Normalize common OCR confusions for digits + Circle K brand junk
  const normalized = normalizeCircleKText(
    cleaned
      .replace(/[|]/g, "I")
      .replace(/\bO(?=\d)/g, "0")
      .replace(/(?<=\d)O\b/g, "0")
      // 25.O29 → 25.029 (O misread inside gallon decimals)
      .replace(/(\d)\.O(\d)/gi, "$1.0$2")
  );

  const lines = normalized
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const joined = normalized.replace(/,/g, "");

  const { fuel_date, fuel_time } = parseReceiptDateTime(normalized);

  // Gallons first when labeled (GALLONS: / 29.531G) — critical with total
  let gallons = parseGallons(joined, lines, null);
  // Total: labeled FUEL SALE / CREDIT DE / USD$ consensus beats pump math
  let total_cost = parseTotalCost(joined, lines, gallons);
  // If gallons still missing, derive from total ÷ price (7-Eleven / prepay follow-ups)
  if (gallons == null && total_cost != null) {
    gallons = parseGallons(joined, lines, total_cost);
  }
  // Lock labeled total if FUEL SALE + CREDIT DE + USD$ agree (never invent $50.57)
  // But repair truncated OCR ($5.76 vs $55.76) when gal × price clearly says so
  const labeledTotal = consensusLabeledTotal(lines, joined);
  if (labeledTotal != null) {
    total_cost = labeledTotal;
    const ppgFix = parsePricePerGal(joined, lines);
    if (gallons != null && ppgFix != null && labeledTotal < 12) {
      const expected = gallons * ppgFix;
      if (expected >= 15) {
        const s = labeledTotal.toFixed(2);
        for (let d = 1; d <= 9; d++) {
          const cand = parseFloat(String(d) + s);
          if (Math.abs(cand - expected) <= 0.15 || Math.abs(cand - expected) / expected <= 0.025) {
            total_cost = Math.round(cand * 100) / 100;
            break;
          }
        }
      }
    }
  } else if (gallons != null) {
    const total2 = parseTotalCost(joined, lines, gallons);
    if (total2 != null) total_cost = total2;
  }
  // Nudge gallons when OCR flipped a digit (Circle K 25.079 → 25.029 @ price×total).
  // Do NOT rewrite labeled Stripes GALLONS: when only PRICE/G OCR is wrong.
  const ppgFinal = parsePricePerGal(joined, lines);
  const hasLabeledGallonsLine = /\bGALLONS?\s*[:#]\s*\d/i.test(joined);
  const hasGallonsAtStyle = /\d+\.\d{2,4}\s*GALLONS?\s*@/i.test(joined);
  if (!hasLabeledGallonsLine || hasGallonsAtStyle) {
    gallons = refineGallonsToTotal(gallons, total_cost, ppgFinal);
  } else {
    gallons = gallons != null ? roundGallons(gallons) : null;
  }

  const { store_number, store_name } = parseStore(normalized, lines);
  let card_last4 = parseCardLast4(normalized, lines);
  // Don't use store / SITE number as card (Murphy 7738 ≠ card 0058; Stripes 2221 ≠ card)
  const siteIds = extractSiteStoreIds(normalized, lines);
  if (card_last4 && store_number && card_last4 === store_number) {
    card_last4 = null;
  }
  if (card_last4 && siteIds.has(card_last4)) {
    card_last4 = null;
  }
  if (card_last4 && store_name && new RegExp(`\\b${card_last4}\\b`).test(store_name)) {
    card_last4 = null;
  }
  // Merchant terminal tails (Merch*******5001) are not gas cards
  if (card_last4 && new RegExp(`Merch[^\\n]{0,20}${card_last4}`, "i").test(normalized)) {
    // Only kill if no real pan mask also has this last4
    const panHas =
      new RegExp(`\\*{4,}\\s*${card_last4}\\b`).test(normalized.replace(/[xX#•·]/g, "*")) ||
      new RegExp(`\\*{6,}${card_last4}\\b`).test(normalized.replace(/[xX#•·]/g, "*"));
    if (!panHas) card_last4 = null;
  }
  // Flag any prepay/pre-auth slip (even if OCR invents a gallon number)
  const is_prepay = detectPrepay(normalized);

  const missing_core: string[] = [];
  if (!fuel_date) missing_core.push("date");
  // Prepay often has no gallons yet — don't require gallons for retake
  if (gallons == null && !is_prepay) missing_core.push("gallons");
  if (total_cost == null) missing_core.push("total");

  const missing_extra: string[] = [];
  if (!fuel_time) missing_extra.push("time");
  if (!store_number && !store_name) missing_extra.push("store");
  if (!card_last4) missing_extra.push("card last 4");

  // Retake only if 2+ core fields missing (prepay: date+total are enough)
  const needs_retake = missing_core.length >= 2;
  const coreHits = (is_prepay ? 2 : 3) - missing_core.length;
  let confidence: "high" | "medium" | "low" = "low";
  if (coreHits >= 3 || (is_prepay && coreHits >= 2 && card_last4)) confidence = "high";
  else if (coreHits >= 2) confidence = "medium";
  else confidence = "low";

  // Prefer store_number display with brand when known
  // Prefer clean store label for the form, but keep digits for matching
  const storeDisplay =
    store_name ||
    (store_number ? store_number : null);

  return {
    gallons,
    total_cost,
    fuel_date,
    fuel_time,
    store_number: storeDisplay,
    card_last4,
    store_name,
    confidence,
    needs_retake,
    missing_core,
    missing_extra,
    is_prepay,
  };
}

/**
 * Crop to the bright receipt paper on dark tables/jeans so Tesseract
 * does not waste attention on wood grain / fabric (big win on phone photos).
 */
function cropToReceiptPaper(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): { sx: number; sy: number; sw: number; sh: number } | null {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // Coarse grid sample for bright pixels (paper)
  const stepX = Math.max(2, Math.floor(w / 120));
  const stepY = Math.max(2, Math.floor(h / 160));
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let bright = 0;
  for (let y = 0; y < h; y += stepY) {
    for (let x = 0; x < w; x += stepX) {
      const i = (y * w + x) * 4;
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (g < 145) continue; // dark wood / denim
      bright++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (bright < 40) return null;
  // Pad a bit; require crop to actually shrink the frame
  const padX = Math.round(w * 0.02);
  const padY = Math.round(h * 0.02);
  minX = Math.max(0, minX - padX);
  minY = Math.max(0, minY - padY);
  maxX = Math.min(w - 1, maxX + padX);
  maxY = Math.min(h - 1, maxY + padY);
  const sw = maxX - minX + 1;
  const sh = maxY - minY + 1;
  if (sw < w * 0.25 || sh < h * 0.3) return null;
  if (sw * sh > w * h * 0.92) return null; // almost full frame already
  return { sx: minX, sy: minY, sw, sh };
}

/**
 * Prepare image for OCR — small on purpose (phone Tesseract is pixel-bound).
 * ~1100px wide is usually enough for pump qty / totals and ~3–10× faster than 2k.
 */
async function preprocessImage(file: File): Promise<HTMLCanvasElement | File> {
  try {
    const bmp = await createImageBitmap(file);
    // Fast path: keep resolution modest — multi-megapixel phone photos crush OCR speed
    const maxW = 1100;
    let scale = bmp.width > maxW ? maxW / bmp.width : 1;
    // Don't upscale small images (slow + no gain)
    let w = Math.round(bmp.width * scale);
    let h = Math.round(bmp.height * scale);
    const full = document.createElement("canvas");
    full.width = w;
    full.height = h;
    const fctx = full.getContext("2d");
    if (!fctx) return file;
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = "medium";
    fctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    // Crop dark table/wood away when receipt paper is clearly brighter
    const crop = cropToReceiptPaper(fctx, w, h);
    let srcCanvas: HTMLCanvasElement = full;
    if (crop) {
      const cropped = document.createElement("canvas");
      cropped.width = crop.sw;
      cropped.height = crop.sh;
      const cctx = cropped.getContext("2d");
      if (cctx) {
        cctx.drawImage(full, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
        srcCanvas = cropped;
        w = crop.sw;
        h = crop.sh;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(srcCanvas, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    // Fast contrast: sample mean then single pass (no second full-image stats)
    let sum = 0;
    const step = Math.max(16, Math.floor(d.length / 4 / 2000)) * 4;
    let samples = 0;
    for (let i = 0; i < d.length; i += step) {
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      samples++;
    }
    const mean = samples ? sum / samples : 128;
    const contrast = mean < 140 ? 1.65 : 1.45;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      let c = (g - 128) * contrast + 128;
      if (c < 140) c *= 0.92;
      const v = Math.max(0, Math.min(255, c));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  } catch {
    return file;
  }
}

/** How complete a parse is (higher = better). Used to merge multi-pass OCR. */
function parseCompleteness(p: Omit<ReceiptParseResult, "raw_text">): number {
  let s = 0;
  if (p.fuel_date) s += 2;
  if (p.fuel_time) s += 1;
  if (p.gallons != null) s += 3;
  if (p.total_cost != null) s += 3;
  if (p.store_number || p.store_name) s += 2;
  if (p.card_last4) s += 2;
  if (p.confidence === "high") s += 2;
  else if (p.confidence === "medium") s += 1;
  // Bonus when gallons × price ≈ total (consistent slip)
  if (p.gallons != null && p.total_cost != null && p.gallons > 3 && p.total_cost > 5) {
    // rough: ppg between 1.5–8
    const implied = p.total_cost / p.gallons;
    if (implied >= 1.5 && implied <= 8) s += 2;
  }
  return s;
}

/**
 * Merge multi-pass OCR. Prefer the more complete parse overall, then fill gaps
 * from the other — never let a weak first pass (date-only) block store/gal/total.
 */
function mergeParseFields(
  a: Omit<ReceiptParseResult, "raw_text">,
  b: Omit<ReceiptParseResult, "raw_text">
): Omit<ReceiptParseResult, "raw_text"> {
  const aScore = parseCompleteness(a);
  const bScore = parseCompleteness(b);
  const primary = aScore >= bScore ? a : b;
  const secondary = aScore >= bScore ? b : a;

  const pick = <T>(x: T | null | undefined, y: T | null | undefined): T | null => {
    if (x != null && x !== "") return x as T;
    if (y != null && y !== "") return y as T;
    return (x ?? y ?? null) as T | null;
  };

  // Primary wins when set; secondary fills holes only
  let gallons = pick(primary.gallons, secondary.gallons);
  let total_cost = pick(primary.total_cost, secondary.total_cost);
  const fuel_date = pick(primary.fuel_date, secondary.fuel_date);
  const fuel_time = pick(primary.fuel_time, secondary.fuel_time);
  const store_number = pick(primary.store_number, secondary.store_number);
  const store_name = pick(primary.store_name, secondary.store_name);
  // Card: prefer longer-mask style from secondary if primary is weak confusable 1/7 pair
  let card_last4 = pick(primary.card_last4, secondary.card_last4);
  if (
    primary.card_last4 &&
    secondary.card_last4 &&
    primary.card_last4 !== secondary.card_last4
  ) {
    // Prefer secondary if it's the only difference is 1↔7 and primary is low-completeness for card alone
    const conf =
      primary.card_last4.replace(/7/g, "1") === secondary.card_last4.replace(/7/g, "1");
    if (conf && /7/.test(secondary.card_last4) && /1/.test(primary.card_last4) && !/7/.test(primary.card_last4)) {
      card_last4 = secondary.card_last4;
    }
  }

  // Re-apply pump-math refine on merged gallons/total
  if (gallons != null && total_cost != null) {
    const impliedPpg = total_cost / gallons;
    if (impliedPpg >= 1.5 && impliedPpg <= 8) {
      gallons = refineGallonsToTotal(gallons, total_cost, impliedPpg);
    }
  }

  const is_prepay = primary.is_prepay || secondary.is_prepay;
  const missing_core: string[] = [];
  if (!fuel_date) missing_core.push("date");
  if (gallons == null && !is_prepay) missing_core.push("gallons");
  if (total_cost == null) missing_core.push("total");
  const missing_extra: string[] = [];
  if (!fuel_time) missing_extra.push("time");
  if (!store_number && !store_name) missing_extra.push("store");
  if (!card_last4) missing_extra.push("card last 4");
  const needs_retake = missing_core.length >= 2;
  const coreHits = (is_prepay ? 2 : 3) - missing_core.length;
  const confidence: "high" | "medium" | "low" =
    coreHits >= 3 || (is_prepay && coreHits >= 2 && !!card_last4)
      ? "high"
      : coreHits >= 2
        ? "medium"
        : "low";

  return {
    gallons,
    total_cost,
    fuel_date,
    fuel_time,
    store_number,
    store_name,
    card_last4,
    confidence,
    needs_retake,
    missing_core,
    missing_extra,
    is_prepay,
  };
}

/** Hints learned from past manual corrections (loaded from API). */
export type OcrHints = {
  subs: Record<string, Record<string, Record<string, string>>>;
  line_labels: Record<string, Record<string, string[]>>;
  /** Extraction strategies learned from corrections (after:USD$, reject_ppg, prefer_G_token, …) */
  patterns?: Record<string, Record<string, string[]>>;
  known_values: Record<string, Record<string, string[]>>;
};

function storeKeyClient(store: string | null | undefined, raw: string): string {
  const s = (store || "").toLowerCase();
  const rawL = raw.toLowerCase();
  if (/stripe/.test(s) || /stripes?/.test(rawL)) {
    const m = (s + " " + rawL).match(/stripes?\s*#?\s*(\d{3,5})/) || s.match(/(\d{3,5})/);
    return m ? `stripes_${m[1]}` : "stripes";
  }
  if (/circle/.test(s) || /circle\s*k/.test(rawL)) {
    const m = (s + " " + rawL).match(/circle\s*k\s+(\d{4,8})/) || s.match(/(\d{4,8})/);
    return m ? `circlek_${m[1]}` : "circlek";
  }
  if (/7.?eleven|7-eleven/.test(s) || /7[\s\-]?eleven/.test(rawL)) {
    const m = rawL.match(/store\s*[:#]?\s*(\d{3,6})/) || s.match(/(\d{3,6})/);
    return m ? `7eleven_${m[1]}` : "7eleven";
  }
  if (
    /murphy/.test(s) ||
    /murphy\s*(usa|express)/.test(rawL) ||
    (/\bsite\s*[:#]/.test(rawL) && (/qty\s*\(\s*gal/.test(rawL) || /fuel\s*total/.test(rawL)))
  ) {
    const m =
      (s + " " + rawL).match(/murphy\s*(?:usa|express)\s*(\d{3,5})/) ||
      rawL.match(/\bsite\s*[:#]?\s*(\d{3,5})/) ||
      s.match(/(\d{3,5})/);
    return m ? `murphy_${m[1]}` : "murphy";
  }
  return "global";
}

function moneyFromLine(line: string): number | null {
  const m =
    line.match(/\$\s*(\d{1,4}\.\d{2})\b/) ||
    line.match(/USD\s*\$?\s*(\d{1,4}\.\d{2})\b/i) ||
    line.match(/\b(\d{1,4}\.\d{2})\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n >= 1 && n < 1000 ? n : null;
}

function gallonsFromLine(line: string): number | null {
  const m =
    line.match(/QTY\s*\(\s*GAL(?:LON)?S?\s*\)\s*[:#]?\s*(\d+\.\d{1,4})/i) ||
    line.match(/GALLONS?\s*[:#]?\s*(\d+\.\d{1,4})/i) ||
    line.match(/\b(\d{1,2}\.\d{2,4})\s*G\b/i) ||
    line.match(/\b(\d{1,2}\.\d{2,4})G\b/i) ||
    line.match(/(\d+\.\d{1,4})\s*GALLONS?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n > 0.5 && n < 120 ? n : null;
}

function cardFromLine(line: string): string | null {
  const L = line.replace(/[xX#•·]/g, "*");
  const m = L.match(/\*{2,}\s*(\d{4})\b/) || line.match(/(?:[^\d\s]){4,}(\d{4})\b/);
  return m && /^\d{4}$/.test(m[1]) ? m[1] : null;
}

/**
 * Apply past correction memory so the scanner gets smarter after bad reads are fixed.
 * Uses wrong→right subs, learned line labels, and structural patterns (where to look).
 */
export function applyOcrLearning(
  parsed: Omit<ReceiptParseResult, "raw_text"> | ReceiptParseResult,
  rawText: string,
  hints: OcrHints | null | undefined
): Omit<ReceiptParseResult, "raw_text"> {
  if (!hints) return parsed;
  const out = { ...parsed };
  const storeKey = storeKeyClient(out.store_number, rawText);
  const keys = [storeKey, "global"];
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const patternsFor = (field: string): string[] => {
    const outP: string[] = [];
    for (const sk of keys) {
      for (const p of hints.patterns?.[sk]?.[field] || []) {
        if (!outP.includes(p)) outP.push(p);
      }
    }
    return outP;
  };

  const applySub = (field: string, current: string | number | null | undefined) => {
    if (current == null || current === "") return current;
    const cur = String(current);
    for (const sk of keys) {
      const map = hints.subs[sk]?.[field];
      if (map?.[cur] != null) return map[cur];
      if (map) {
        const n = parseFloat(cur);
        if (!Number.isNaN(n)) {
          for (const [wrong, right] of Object.entries(map)) {
            if (Math.abs(parseFloat(wrong) - n) < 0.001) return right;
          }
        }
      }
    }
    return current;
  };

  // 1) Direct substitutions from prior fixes (e.g. gallons 2.659 → 15.408, total 5.76 → 55.76)
  const g0 = applySub("gallons", out.gallons);
  out.gallons = g0 == null || g0 === "" ? out.gallons : parseFloat(String(g0));
  const t0 = applySub("total_cost", out.total_cost);
  out.total_cost = t0 == null || t0 === "" ? out.total_cost : parseFloat(String(t0));
  const c0 = applySub("card_last4", out.card_last4);
  out.card_last4 = c0 == null || c0 === "" ? out.card_last4 : String(c0);
  const s0 = applySub("store_number", out.store_number);
  out.store_number = s0 == null || s0 === "" ? out.store_number : String(s0);
  const d0 = applySub("fuel_date", out.fuel_date);
  out.fuel_date = d0 == null || d0 === "" ? out.fuel_date : String(d0);

  // 2) Pattern: gallons OCR was $/gal — re-scan for xx.xxxG / QTY(GAL) in product lines
  const gPatterns = patternsFor("gallons");
  const rejectPpg = gPatterns.includes("reject_ppg") || gPatterns.includes("prefer_G_token");
  const preferQtyGal = gPatterns.includes("prefer_qty_gal");
  const galLooksPpg =
    out.gallons != null && out.gallons >= 1.2 && out.gallons <= 9.5;
  // Murphy: always prefer explicit QTY(GAL) when present
  if (preferQtyGal || /QTY\s*\(\s*GAL/i.test(rawText)) {
    for (const line of lines) {
      const m = line.match(/QTY\s*\(\s*GAL(?:LON)?S?\s*\)\s*[:#]?\s*(\d+\.\d{1,4})/i);
      if (m) {
        const n = parseFloat(m[1]);
        if (n > 0.5 && n < 120) {
          out.gallons = Math.round(n * 1000) / 1000;
          break;
        }
      }
    }
  }
  if (rejectPpg || galLooksPpg || out.gallons == null) {
    const gCandidates: number[] = [];
    for (const line of lines) {
      if (/SELF\s*@|PRICE\s*\/|\/\s*G(?:AL)?\b/i.test(line) && !/\d+\.\d+\s*G\b|QTY\s*\(/i.test(line)) {
        continue;
      }
      const qty = line.match(/QTY\s*\(\s*GAL(?:LON)?S?\s*\)\s*[:#]?\s*(\d+\.\d{1,4})/i);
      if (qty) {
        const n = parseFloat(qty[1]);
        if (n > 0.5 && n < 120) gCandidates.push(n);
        continue;
      }
      const m =
        line.match(/\b(\d{1,2}\.\d{2,4})\s*G\b/i) ||
        line.match(/\b(\d{1,2}\.\d{2,4})G\b/i) ||
        line.match(/(?:UNLD|DSL|DIESEL|CR\s*#|RUL)[^\n]{0,40}?\b(\d{1,2}\.\d{2,4})\b/i);
      if (m) {
        const n = parseFloat(m[1]);
        if (n > 5 && n < 100 && !(n >= 1.2 && n <= 9.5)) gCandidates.push(n);
        else if (n > 5 && n < 100) gCandidates.push(n);
      }
    }
    // Also any xx.xxxG in full text
    for (const m of rawText.matchAll(/\b(\d{1,2}\.\d{2,4})\s*G\b/gi)) {
      const n = parseFloat(m[1]);
      if (n > 5 && n < 100) gCandidates.push(n);
    }
    if (gCandidates.length) {
      gCandidates.sort((a, b) => b - a);
      // If current is ppg-like or missing, take best G-token
      if (out.gallons == null || galLooksPpg || rejectPpg) {
        out.gallons = Math.round(gCandidates[0] * 1000) / 1000;
      }
    } else if (galLooksPpg && out.gallons != null && out.total_cost != null && out.total_cost > 5) {
      // Derive gallons from total ÷ misread ppg
      const derived = out.total_cost / out.gallons;
      if (derived > 5 && derived < 100) {
        out.gallons = Math.round(derived * 1000) / 1000;
      }
    }
  }

  // 2b) Card was store/SITE number — force pan-mask re-read
  const cardPatsEarly = patternsFor("card_last4");
  if (
    cardPatsEarly.includes("reject_site_as_card") ||
    (out.card_last4 &&
      (out.store_number?.includes(out.card_last4) ||
        new RegExp(`SITE\\s*[:#]?\\s*${out.card_last4}\\b`, "i").test(rawText) ||
        new RegExp(`MURPHY\\s*USA\\s*${out.card_last4}\\b`, "i").test(rawText)))
  ) {
    const siteIds = extractSiteStoreIds(rawText, lines);
    if (out.card_last4 && siteIds.has(out.card_last4)) {
      out.card_last4 = null;
    }
    // Prefer ************XXXX near Visa / Entry Method
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i].replace(/[xX#•·]/g, "*");
      if (/SITE|MERCH|TRACE|MURPHY|TRAN\s*#|AUTH/i.test(lines[i])) continue;
      const pan = L.match(/\*{3,}\s*(\d{4})\b/);
      if (!pan) continue;
      const ctx = `${lines[i - 1] || ""} ${lines[i]} ${lines[i + 1] || ""}`;
      if (/VISA|ENTRY|CHIP|SALE|MASTERCARD/i.test(ctx) && !siteIds.has(pan[1])) {
        out.card_last4 = pan[1];
        break;
      }
    }
  }

  // 3) Re-read fields from lines matching learned labels
  for (const sk of keys) {
    const labels = hints.line_labels[sk]?.total_cost || [];
    for (const lab of labels) {
      if (lab === "1" || /^\d/.test(lab)) continue;
      const line = lines.find((l) => l.toUpperCase().includes(lab.toUpperCase()));
      if (!line) continue;
      const m = moneyFromLine(line);
      if (m != null && m >= 8) {
        out.total_cost = m;
        break;
      }
    }
    const gLabels = hints.line_labels[sk]?.gallons || [];
    for (const lab of gLabels) {
      if (lab === "1" || lab === "QTY_G") {
        // QTY_G: any line with xx.xxxG
        for (const line of lines) {
          const g = gallonsFromLine(line);
          if (g != null && g > 5) {
            out.gallons = g;
            break;
          }
        }
        continue;
      }
      const line = lines.find((l) => l.toUpperCase().includes(lab.toUpperCase()));
      if (!line) continue;
      const g = gallonsFromLine(line);
      if (g != null && g > 5) {
        out.gallons = g;
        break;
      }
    }
    const cLabels = hints.line_labels[sk]?.card_last4 || [];
    for (const lab of cLabels) {
      if (lab === "1" || lab === "PAN_MASK") continue;
      const idx = lines.findIndex((l) => l.toUpperCase().includes(lab.toUpperCase()));
      if (idx < 0) continue;
      for (const line of [lines[idx], lines[idx + 1], lines[idx + 2], lines[idx - 1]].filter(Boolean)) {
        const c = cardFromLine(line);
        if (c) {
          out.card_last4 = c;
          break;
        }
      }
      if (out.card_last4) break;
    }
  }

  // 4) Card patterns: after USD$, pan mask, before Entry/Contactless
  const cPatterns = patternsFor("card_last4");
  if (!out.card_last4 || cPatterns.length) {
    const tryPan = (line: string | undefined): string | null => {
      if (!line) return null;
      return cardFromLine(line);
    };
    if (cPatterns.some((p) => p === "after_usd" || p.startsWith("after:USD"))) {
      for (let i = 0; i < lines.length; i++) {
        if (!/USD\s*\$|USD\$/i.test(lines[i])) continue;
        for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
          const c = tryPan(lines[j]);
          if (c) {
            out.card_last4 = c;
            break;
          }
        }
        if (out.card_last4) break;
      }
    }
    if (!out.card_last4 && cPatterns.some((p) => p === "pan_mask" || p === "PAN_MASK")) {
      for (const line of lines) {
        const c = tryPan(line);
        if (c) {
          out.card_last4 = c;
          break;
        }
      }
    }
    for (const p of cPatterns) {
      if (!p.startsWith("after:") || out.card_last4) continue;
      const lab = p.slice(6);
      const idx = lines.findIndex((l) => l.toUpperCase().includes(lab.toUpperCase()));
      if (idx < 0) continue;
      for (let j = idx; j <= Math.min(idx + 3, lines.length - 1); j++) {
        const c = tryPan(lines[j]);
        if (c) {
          out.card_last4 = c;
          break;
        }
      }
    }
    for (const p of cPatterns) {
      if (!p.startsWith("before:") || out.card_last4) continue;
      const lab = p.slice(7);
      const idx = lines.findIndex((l) => l.toUpperCase().includes(lab.toUpperCase()));
      if (idx <= 0) continue;
      for (let j = idx - 1; j >= Math.max(0, idx - 3); j--) {
        const c = tryPan(lines[j]);
        if (c) {
          out.card_last4 = c;
          break;
        }
      }
    }
  }

  // 5) Store: ST# is a WEAK signal on many Stripes slips (footer register id ≠ store #).
  // Prefer existing header store (e.g. Stripes #40823). Only fill ST# if store missing,
  // or explicitly learned prefer_st_hash AND ST# is longer/better.
  {
    const st = rawText.match(/\bST\s*#\s*(\d{3,6})\b/i);
    const header =
      rawText.match(/\bSTRIPES?\s*#\s*(\d{3,6})\b/i) ||
      rawText.match(/\bSTRIPES?\s+(\d{4,6})\b/i);
    if (header?.[1]) {
      const hid = header[1];
      out.store_number = `Stripes ${hid}`;
      out.store_name = `Stripes ${hid}`;
    } else if (st && patternsFor("store_number").includes("prefer_st_hash")) {
      const id = st[1];
      if (!out.store_number || String(out.store_number).replace(/\D/g, "").length < id.length) {
        out.store_number = `Stripes ${id}`;
        out.store_name = `Stripes ${id}`;
      }
    } else if (st && !out.store_number) {
      out.store_number = `Stripes ${st[1]}`;
      out.store_name = `Stripes ${st[1]}`;
    }
  }

  // 6) Known values: only when present in THIS raw text
  //    - totals: fix truncated OCR
  //    - gallons: only xx.xxxG style tokens present in text
  //    - cards: only if on a mask line (never grab first fleet card from memory)
  for (const sk of keys) {
    const knownTotals = hints.known_values[sk]?.total_cost || [];
    for (const v of knownTotals) {
      if (!(rawText.includes(v) || rawText.includes(v.replace(".", "")))) continue;
      const n = parseFloat(v);
      if (Number.isNaN(n) || n < 8) continue;
      if (out.total_cost == null || out.total_cost < 12 || out.total_cost * 5 < n) {
        out.total_cost = n;
        break;
      }
    }
    const knownGals = hints.known_values[sk]?.gallons || [];
    for (const v of knownGals) {
      const re = new RegExp(`\\b${v.replace(".", "\\.")}\\s*G\\b`, "i");
      if (re.test(rawText) || rawText.includes(v + "G")) {
        const n = parseFloat(v);
        if (!Number.isNaN(n) && n > 5 && (out.gallons == null || (out.gallons >= 1.2 && out.gallons <= 9.5))) {
          out.gallons = n;
          break;
        }
      }
    }
    if (!out.card_last4) {
      const knownCards = hints.known_values[sk]?.card_last4 || [];
      for (const v of knownCards) {
        if (!/^\d{4}$/.test(v)) continue;
        // Must appear on a masked pan-like line in THIS receipt
        const hit = lines.some((l) => {
          const L = l.replace(/[xX#•·]/g, "*");
          return (
            (/\*{2,}/.test(L) && L.includes(v)) ||
            new RegExp(`[*xX#]{4,}\\s*${v}\\b`).test(l)
          );
        });
        if (hit) {
          out.card_last4 = v;
          break;
        }
      }
    }
  }

  // Recompute confidence after learning
  const missing_core: string[] = [];
  if (!out.fuel_date) missing_core.push("date");
  if (out.gallons == null && !out.is_prepay) missing_core.push("gallons");
  if (out.total_cost == null) missing_core.push("total");
  out.missing_core = missing_core;
  out.needs_retake = missing_core.length >= 2;
  const coreHits = (out.is_prepay ? 2 : 3) - missing_core.length;
  out.confidence = coreHits >= 3 ? "high" : coreHits >= 2 ? "medium" : "low";

  return out;
}

let cachedHints: OcrHints | null = null;
let hintsLoadedAt = 0;

export async function loadOcrHints(fetcher: (path: string) => Promise<OcrHints>): Promise<OcrHints | null> {
  const now = Date.now();
  if (cachedHints && now - hintsLoadedAt < 10 * 60 * 1000) return cachedHints;
  try {
    cachedHints = await fetcher("/ocr/hints");
    hintsLoadedAt = now;
    return cachedHints;
  } catch {
    return cachedHints;
  }
}

export function clearOcrHintsCache() {
  cachedHints = null;
  hintsLoadedAt = 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tesseractScriptPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ocrWorkerPromise: Promise<any> | null = null;

/** Load Tesseract CDN once (call on Fuel page mount to warm up). */
async function loadTesseractLib(): Promise<// eslint-disable-next-line @typescript-eslint/no-explicit-any
any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Tesseract: any = (window as any).Tesseract;
  if (Tesseract) return Tesseract;
  if (!tesseractScriptPromise) {
    tesseractScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      s.async = true;
      s.onload = () => resolve((window as any).Tesseract);
      s.onerror = () => {
        tesseractScriptPromise = null;
        reject(new Error("Could not load OCR engine"));
      };
      document.head.appendChild(s);
    });
  }
  return tesseractScriptPromise;
}

/**
 * One shared worker for the session — createWorker is expensive; reusing it
 * is the biggest speed win after the first receipt.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getOcrWorker(): Promise<any> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const Tesseract = await loadTesseractLib();
      const worker = await Tesseract.createWorker("eng", 1, {
        logger: () => {},
      });
      // Uniform block of text — best speed/accuracy for thermal receipts
      await worker.setParameters({
        tessedit_pageseg_mode: "6",
      });
      return worker;
    })().catch((err) => {
      ocrWorkerPromise = null;
      throw err;
    });
  }
  return ocrWorkerPromise;
}

/** Preload OCR engine on the fuel page so the first photo is faster. */
export async function warmOcrEngine(): Promise<void> {
  try {
    await getOcrWorker();
  } catch {
    /* optional warm-up */
  }
}

/**
 * Fast single-pass OCR → raw text (packing slips, generic).
 * Reuses the shared worker; downscales for speed.
 */
export async function recognizeImageText(file: File): Promise<string> {
  const worker = await getOcrWorker();
  try {
    const bmp = await createImageBitmap(file);
    const maxW = 1200;
    const scale = bmp.width > maxW ? maxW / bmp.width : 1;
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bmp.close?.();
      const r = await worker.recognize(file);
      return String(r?.data?.text || "");
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    // Mild contrast for embossed/metal nameplates
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      let c = (g - 128) * 1.55 + 128;
      const v = Math.max(0, Math.min(255, c));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    const r = await worker.recognize(canvas);
    return String(r?.data?.text || "");
  } catch {
    const r = await worker.recognize(file);
    return String(r?.data?.text || "");
  }
}

/** Draw bitmap scaled into a canvas (caller owns cleanup of bmp if needed). */
function drawScaledBitmap(
  bmp: ImageBitmap,
  maxW: number
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const scale = bmp.width > maxW ? maxW / bmp.width : 1;
  // Prefer slight upscale for small phone crops of nameplates
  const up = bmp.width < 900 ? Math.min(2.5, 1600 / bmp.width) : scale;
  const w = Math.round(bmp.width * up);
  const h = Math.round(bmp.height * up);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0, w, h);
  return { canvas, ctx, w, h };
}

function applyGreyscaleContrast(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  contrast: number,
  threshold: number | null
) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let c = (g - 128) * contrast + 128;
    c = Math.max(0, Math.min(255, c));
    if (threshold != null) c = c >= threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Multi-pass OCR tuned for HVAC nameplates (Lennox etc.).
 * Metal stickers OCR poorly on a single mild-contrast pass — run soft +
 * several binarized thresholds and a top crop focused on M/N + S/N lines.
 */
export async function recognizeNameplateImageText(file: File): Promise<string> {
  const worker = await getOcrWorker();
  const chunks: string[] = [];

  try {
    const bmp = await createImageBitmap(file);
    const maxW = 1800;

    // Pass A: soft contrast full plate (preserves thin strokes)
    {
      const drawn = drawScaledBitmap(bmp, maxW);
      if (drawn) {
        applyGreyscaleContrast(drawn.ctx, drawn.w, drawn.h, 1.65, null);
        const r = await worker.recognize(drawn.canvas);
        chunks.push(String(r?.data?.text || ""));
      }
    }

    // Passes B–D: hard thresholds (M/N and S/N ink varies with lighting)
    for (const thr of [130, 150, 170]) {
      const drawn = drawScaledBitmap(bmp, maxW);
      if (!drawn) continue;
      applyGreyscaleContrast(drawn.ctx, drawn.w, drawn.h, 1.45, thr);
      const r = await worker.recognize(drawn.canvas);
      chunks.push(String(r?.data?.text || ""));
    }

    // Pass E: top ~42% only (header + M/N + S/N) at higher effective scale
    {
      const topH = Math.max(80, Math.round(bmp.height * 0.42));
      const canvas = document.createElement("canvas");
      const scale = Math.min(3, 2000 / bmp.width);
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(topH * scale);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(
          bmp,
          0,
          0,
          bmp.width,
          topH,
          0,
          0,
          canvas.width,
          canvas.height
        );
        applyGreyscaleContrast(ctx, canvas.width, canvas.height, 1.5, 155);
        const r = await worker.recognize(canvas);
        chunks.push(String(r?.data?.text || ""));
      }
    }

    bmp.close?.();
  } catch {
    /* fall through */
  }

  if (!chunks.some((t) => t.trim())) {
    try {
      const r = await worker.recognize(file);
      return String(r?.data?.text || "");
    } catch {
      return "";
    }
  }

  // Join all passes — parser picks best M/N and S/N across noise
  return chunks.join("\n---\n");
}

function normMoney(t: string): string {
  return t.replace(/(\d)\s+\.\s*(\d)/g, "$1.$2").replace(/(\d)\.\s+(\d{2})\b/g, "$1.$2");
}

/**
 * Fast receipt OCR for techs in the field.
 * - 1 recognize pass on a downscaled/cropped image (typical: seconds, not minutes)
 * - At most 1 rescue pass if gallons+total both missing
 * - Reuses a single Tesseract worker
 */
export async function ocrReceiptImage(
  file: File,
  hints?: OcrHints | null
): Promise<ReceiptParseResult> {
  const worker = await getOcrWorker();
  const source = await preprocessImage(file);

  const result = await worker.recognize(source);
  let text = normMoney(result?.data?.text || "");
  let parsed = parseReceiptText(text);

  // Rescue only when we still lack both pump qty and total (one extra pass, not 6)
  const needsRescue =
    (parsed.gallons == null && parsed.total_cost == null) ||
    (parsed.missing_core.length >= 2 && !parsed.is_prepay);

  if (needsRescue) {
    try {
      // Different view: raw file lightly scaled (no contrast) in case preprocess hurt ink
      const bmp = await createImageBitmap(file);
      const maxW = 1000;
      const scale = bmp.width > maxW ? maxW / bmp.width : 1;
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close?.();
        const r2 = await worker.recognize(c);
        const t2 = normMoney(r2?.data?.text || "");
        if (t2.trim()) {
          text = `${text}\n${t2}`;
          parsed = mergeParseFields(parsed, parseReceiptText(t2));
          parsed = mergeParseFields(parsed, parseReceiptText(text));
        }
      } else {
        bmp.close?.();
      }
    } catch {
      /* rescue optional */
    }
  }

  if (hints) {
    parsed = applyOcrLearning(parsed, text, hints);
  }
  return { ...parsed, raw_text: text };
}

export { parseReceiptText };
