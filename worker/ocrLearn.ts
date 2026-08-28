/** Persist and serve receipt OCR learning from user corrections. */

export type OcrFieldSnapshot = {
  fuel_date?: string | null;
  fuel_time?: string | null;
  gallons?: number | null;
  total_cost?: number | null;
  store_number?: string | null;
  card_last4?: string | null;
  /** Parts / invoice receipts (also mapped via store_number for vendor name) */
  vendor_name?: string | null;
  invoice_number?: string | null;
  purchase_date?: string | null;
  /** Equipment nameplate (warranty drop-off) */
  model_number?: string | null;
  serial_number?: string | null;
};

export type OcrHints = {
  /** store_key → field → ocrValue → correctValue */
  subs: Record<string, Record<string, Record<string, string>>>;
  /** store_key → field → preferred line labels (e.g. "UNLD", "USD$") sorted by hits */
  line_labels: Record<string, Record<string, string[]>>;
  /**
   * store_key → field → extraction anchors:
   *  after:USD$ | before:ENTRY | token:G | reject_ppg
   */
  patterns: Record<string, Record<string, string[]>>;
  /** store_key → field → values often correct when present in text (use carefully) */
  known_values: Record<string, Record<string, string[]>>;
};

export function storeKeyFrom(store: string | null | undefined, rawText?: string | null): string {
  const s = (store || "").toLowerCase();
  // Equipment nameplates (warranty model/serial OCR) — brand sub-keys when text known
  if (s === "nameplate" || s.startsWith("nameplate")) {
    const raw = (rawText || "").toUpperCase();
    if (s.startsWith("nameplate_") && s.length > 10) return s.slice(0, 48);
    if (/\bLENNOX\b/.test(raw) || /DALLAS\s*,?\s*TEXAS/.test(raw)) return "nameplate_lennox";
    if (/\bCARRIER\b/.test(raw)) return "nameplate_carrier";
    if (/\bTRANE\b/.test(raw)) return "nameplate_trane";
    if (/\bGOODMAN\b/.test(raw)) return "nameplate_goodman";
    if (/\bRHEEM\b|\bRUUD\b/.test(raw)) return "nameplate_rheem";
    return "nameplate";
  }
  // Dump / landfill tickets
  if (s === "dump" || s.startsWith("dump_")) return s.slice(0, 48) || "dump";
  // Explicit parts-purchase vendor keys (parts_johnstone, etc.)
  if (s.startsWith("parts_")) return s.slice(0, 48);
  if (/stripe/.test(s) || /\b2221\b/.test(s) || /\b2213\b/.test(s) || /\b2215\b/.test(s)) {
    const m = s.match(/(\d{3,5})/);
    return m ? `stripes_${m[1]}` : "stripes";
  }
  if (/circle/.test(s)) {
    const m = s.match(/(\d{4,8})/);
    return m ? `circlek_${m[1]}` : "circlek";
  }
  if (/7.?eleven|7-eleven/.test(s)) {
    const m = s.match(/(\d{3,6})/);
    return m ? `7eleven_${m[1]}` : "7eleven";
  }
  if (/murphy/.test(s)) {
    const m = s.match(/(\d{3,5})/);
    return m ? `murphy_${m[1]}` : "murphy";
  }
  const raw = (rawText || "").toLowerCase();
  // Parts invoice layout signatures (invoice # / packing slip — not fuel)
  if (
    /invoice\s*(no|#|number)|packing\s*slip|pack\s*slip/i.test(raw) &&
    !/gallons?\s*@|price\s*\/\s*g|fuel\s*sale|self\s*@/i.test(raw)
  ) {
    const slug = (store || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40);
    if (slug) return `parts_${slug}`;
    for (const name of [
      "johnstone",
      "ferguson",
      "carrier",
      "home_depot",
      "lowes",
      "united_refrigeration",
      "winsupply",
      "grainger",
    ]) {
      if (raw.includes(name.replace(/_/g, " ")) || raw.includes(name)) return `parts_${name}`;
    }
    return "parts_global";
  }
  if (/stripes?/.test(raw) || /\bst\s*#\s*\d{3,5}\b/.test(raw)) {
    const m =
      raw.match(/stripes?\s*#?\s*(\d{3,5})/) ||
      raw.match(/\bst\s*#\s*(\d{3,5})\b/) ||
      raw.match(/\bst#\s*(\d{3,5})\b/);
    return m ? `stripes_${m[1]}` : "stripes";
  }
  if (/circle\s*k/.test(raw)) {
    const m = raw.match(/circle\s*k\s+(\d{4,8})/);
    return m ? `circlek_${m[1]}` : "circlek";
  }
  if (/7[\s\-]?eleven/.test(raw)) {
    const m = raw.match(/store\s*[:#]?\s*(\d{3,6})/);
    return m ? `7eleven_${m[1]}` : "7eleven";
  }
  if (
    /murphy\s*(usa|express)/.test(raw) ||
    (/\bsite\s*[:#]/.test(raw) && (/qty\s*\(\s*gal/.test(raw) || /fuel\s*total/.test(raw)))
  ) {
    const m =
      raw.match(/murphy\s*(?:usa|express)\s*(\d{3,5})/) ||
      raw.match(/\bsite\s*[:#]?\s*(\d{3,5})/);
    return m ? `murphy_${m[1]}` : "murphy";
  }
  // Vendor name alone (parts purchase feedback without invoice keywords in raw)
  if (s && !/^\d+$/.test(s) && s.length >= 3 && !/stripe|circle|murphy|eleven|fuel/.test(s)) {
    const slug = s.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
    if (slug && /[a-z]/.test(slug)) return `parts_${slug}`;
  }
  return "global";
}

function normVal(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return String(Math.round(v * 1000) / 1000);
  }
  return String(v).trim();
}

function valsDiffer(a: unknown, b: unknown): boolean {
  const na = normVal(a);
  const nb = normVal(b);
  if (!nb) return false; // no correction if final empty
  if (!na) return true; // OCR missing, user filled
  const fa = parseFloat(na);
  const fb = parseFloat(nb);
  if (!Number.isNaN(fa) && !Number.isNaN(fb)) {
    return Math.abs(fa - fb) > 0.001;
  }
  return na.toLowerCase() !== nb.toLowerCase();
}

function findLineWithValue(raw: string, value: string): string | null {
  if (!raw || !value) return null;
  // Prefer exact token match for money/gal
  const variants = [value];
  if (/^\d+\.\d+$/.test(value)) {
    variants.push(value + "G", value + " G", "$" + value, "USD$" + value);
  }
  for (const v of variants) {
    const needle = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(needle, "i");
    for (const line of raw.split(/\r?\n/)) {
      if (re.test(line)) return line.trim().slice(0, 120);
    }
  }
  // Fuzzy: value digits appear in line
  const digits = value.replace(/[^\d.]/g, "");
  if (digits.length >= 3) {
    for (const line of raw.split(/\r?\n/)) {
      if (line.includes(digits)) return line.trim().slice(0, 120);
    }
  }
  return null;
}

function lineLabelHint(line: string, field?: string): string | null {
  const labels = [
    // Dump / scale tickets (check before generic TOTAL)
    "NET WEIGHT",
    "NET WT",
    "NET WGT",
    "NET LBS",
    "NET POUNDS",
    "GROSS WT",
    "GROSS WEIGHT",
    "TARE WT",
    "TARE WEIGHT",
    "AMOUNT DUE",
    "TOTAL AMOUNT",
    "TICKET TOTAL",
    "UNLD CR",
    "UNLD",
    "DSL",
    "DIESEL",
    "SELF @",
    "SELF@",
    "FUEL SALE",
    "CREDIT DEBIT",
    "CREDIT DE",
    "TOTAL SALE",
    "TOTAL FUEL",
    "FUEL TOTAL",
    "NET TOTAL",
    "CARD AMT",
    "FUEL TO",
    "USD$",
    "USD",
    "GALLONS",
    "QTY(GAL)",
    "QTY",
    "PRICE/G",
    "PRICE/GAL",
    "SUBTOTAL",
    "CONTACTLESS",
    "ENTRY METHOD",
    "ENTRY:",
    "CAPITAL ONE",
    "VISA",
    "AMOUNT",
    "CREDIT",
    "TOTAL",
    "ST#",
    "STORE",
    "SITE",
    "MURPHY EXPRESS",
    "MURPHY USA",
    "MURPHY",
    "NET",
    "GROSS",
    "TARE",
  ];
  const u = line.toUpperCase();
  for (const l of labels) {
    if (u.includes(l.toUpperCase())) {
      // For gallons (also dump net weight), prefer product / NET labels over TOTAL / price
      if (
        field === "gallons" &&
        /TOTAL|SUBTOTAL|CREDIT|USD|VISA|ENTRY|CONTACT|PRICE|SITE|MURPHY|CARD AMT|AMOUNT DUE|TICKET TOTAL/i.test(
          l
        ) &&
        !/^NET/i.test(l)
      ) {
        continue;
      }
      if (field === "card_last4" && /UNLD|DSL|SELF|GALLON|QTY|AMOUNT|ST#|SITE|MURPHY|PRICE|FUEL TOTAL|NET TOTAL|NET WT|GROSS|TARE/i.test(l)) {
        continue;
      }
      if (field === "store_number" && /VISA|GALLON|QTY|CARD AMT|ENTRY|NET WT|GROSS|TARE/i.test(l)) {
        continue;
      }
      if (field === "total_cost" && /NET WT|NET WEIGHT|GROSS|TARE|GALLON|QTY|UNLD|SELF/i.test(l)) {
        continue;
      }
      return l;
    }
  }
  // Gallons often on lines with "xx.xxxG" or Murphy QTY(GAL)
  if (field === "gallons" && /\d+\.\d{2,4}\s*G\b/i.test(line)) return "QTY_G";
  if (field === "gallons" && /QTY\s*\(\s*GAL/i.test(line)) return "QTY(GAL)";
  // Dump net weight lines
  if (field === "gallons" && /NET/i.test(line) && /([\d,]+\.?\d*)/.test(line)) return "NET WT";
  // Card mask lines
  if (field === "card_last4" && /[*xX#•·]{4,}\s*\d{4}/.test(line)) return "PAN_MASK";
  return null;
}

function isDumpStoreKey(storeKey: string): boolean {
  return storeKey === "dump" || storeKey.startsWith("dump_");
}

function neighborLabels(
  raw: string,
  value: string
): { after: string[]; before: string[] } {
  const after: string[] = [];
  const before: string[] = [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const needle = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(needle, "i");
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i]) && !lines[i].includes(value.replace(/[^\d.]/g, ""))) continue;
    for (let j = Math.max(0, i - 2); j < i; j++) {
      const lab = lineLabelHint(lines[j]);
      if (lab && !after.includes(lab)) after.push(lab); // value is after these labels
    }
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 2); j++) {
      const lab = lineLabelHint(lines[j]);
      if (lab && !before.includes(lab)) before.push(lab); // value is before these labels
    }
  }
  return { after, before };
}

async function bumpMemory(
  db: D1Database,
  storeKey: string,
  field: string,
  memoryType: string,
  keyText: string,
  valueText: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ocr_memory (store_key, field_name, memory_type, key_text, value_text, hits, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(store_key, field_name, memory_type, key_text, value_text)
       DO UPDATE SET hits = hits + 1, updated_at = datetime('now')`
    )
    .bind(storeKey, field, memoryType, keyText.slice(0, 80), valueText.slice(0, 80))
    .run();
}

const LEARN_FIELDS = [
  "fuel_date",
  "fuel_time",
  "gallons",
  "total_cost",
  "store_number",
  "card_last4",
  "vendor_name",
  "invoice_number",
  "purchase_date",
  "model_number",
  "serial_number",
] as const;

function looksLikePpg(n: number): boolean {
  return n >= 1.2 && n <= 9.5;
}

export async function recordOcrFeedback(
  db: D1Database,
  userId: number,
  rawText: string | null | undefined,
  ocr: OcrFieldSnapshot,
  final: OcrFieldSnapshot
): Promise<{ corrections: number }> {
  const storeKey = storeKeyFrom(final.store_number || ocr.store_number, rawText);
  let n = 0;

  for (const field of LEARN_FIELDS) {
    const ocrV = ocr[field];
    const finV = final[field];
    if (!valsDiffer(ocrV, finV)) continue;
    const correct = normVal(finV);
    if (!correct) continue;
    const ocrS = normVal(ocrV);

    await db
      .prepare(
        `INSERT INTO ocr_corrections (user_id, store_key, field_name, ocr_value, correct_value, raw_text)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(userId, storeKey, field, ocrS || null, correct, rawText ? rawText.slice(0, 4000) : null)
      .run();
    n++;

    // Substitution memory (same wrong OCR → same fix)
    if (ocrS) {
      await bumpMemory(db, storeKey, field, "sub", ocrS, correct);
      // Do not pollute global fuel learning with dump weight/total misreads
      if (!isDumpStoreKey(storeKey)) {
        await bumpMemory(db, "global", field, "sub", ocrS, correct);
      }

      // Gallons: OCR took $/gal — teach reject_ppg + prefer G token (fuel only)
      if (field === "gallons" && !isDumpStoreKey(storeKey)) {
        const wrongN = parseFloat(ocrS);
        const rightN = parseFloat(correct);
        if (!Number.isNaN(wrongN) && looksLikePpg(wrongN) && rightN > 8) {
          await bumpMemory(db, storeKey, field, "pattern", "reject_ppg", "1");
          await bumpMemory(db, "global", field, "pattern", "reject_ppg", "1");
          await bumpMemory(db, storeKey, field, "pattern", "prefer_G_token", "1");
          await bumpMemory(db, "global", field, "pattern", "prefer_G_token", "1");
        }
        if (storeKey.startsWith("murphy") || /murphy|qty\s*\(\s*gal/i.test(rawText || "")) {
          await bumpMemory(db, storeKey, field, "pattern", "prefer_qty_gal", "1");
          await bumpMemory(db, "global", field, "pattern", "prefer_qty_gal", "1");
          await bumpMemory(db, storeKey, field, "line_label", "QTY(GAL)", "1");
        }
      }
      // Dump tickets: teach WHERE weight/total live (labels), not the specific numbers
      if (isDumpStoreKey(storeKey) && (field === "gallons" || field === "total_cost")) {
        if (field === "gallons") {
          for (const lab of ["NET WT", "NET WEIGHT", "NET WGT", "NET LBS", "NET"]) {
            await bumpMemory(db, "dump", field, "line_label", lab, "1");
          }
          await bumpMemory(db, "dump", field, "pattern", "layout:dump_net", "1");
        }
        if (field === "total_cost") {
          for (const lab of ["TOTAL AMOUNT", "AMOUNT DUE", "TICKET TOTAL", "TOTAL", "AMOUNT"]) {
            await bumpMemory(db, "dump", field, "line_label", lab, "1");
          }
          await bumpMemory(db, "dump", field, "pattern", "layout:dump_total", "1");
        }
      }
      // Card: SITE/store number misread as last4 (Murphy 7738 → 0058)
      if (field === "card_last4" && /^\d{4}$/.test(ocrS) && /^\d{4}$/.test(correct)) {
        await bumpMemory(db, storeKey, field, "pattern", "reject_site_as_card", "1");
        await bumpMemory(db, "global", field, "pattern", "reject_site_as_card", "1");
        await bumpMemory(db, storeKey, field, "pattern", "pan_mask", "1");
        await bumpMemory(db, storeKey, field, "pattern", "after:VISA", "1");
        await bumpMemory(db, storeKey, field, "pattern", "before:ENTRY METHOD", "1");
      }
      if (field === "store_number") {
        if (storeKey.startsWith("murphy") || /murphy|site\s*[:#]/i.test(rawText || "")) {
          await bumpMemory(db, storeKey, field, "pattern", "prefer_site", "1");
          await bumpMemory(db, storeKey, field, "line_label", "MURPHY USA", "1");
          await bumpMemory(db, storeKey, field, "line_label", "SITE", "1");
        }
      }
      // Parts invoice / packing slip — learn labels near invoice numbers
      if (field === "invoice_number") {
        await bumpMemory(db, storeKey, field, "line_label", "INVOICE", "1");
        await bumpMemory(db, storeKey, field, "line_label", "PACKING SLIP", "1");
        await bumpMemory(db, "parts_global", field, "line_label", "INVOICE", "1");
        await bumpMemory(db, storeKey, field, "value_in_text", correct, "1");
        await bumpMemory(db, storeKey, field, "pattern", "after:INVOICE", "1");
      }
      if (field === "vendor_name") {
        await bumpMemory(db, storeKey, field, "value_in_text", correct, "1");
        await bumpMemory(db, "parts_global", field, "sub", ocrS, correct);
        // Mirror to store_number so fuel-style applyOcrLearning can help
        await bumpMemory(db, storeKey, "store_number", "sub", ocrS, correct);
      }
      // Nameplate model / serial — learn labels and known values
      // Lennox condensers: model on M/N line, serial on S/N line immediately below
      if (field === "model_number") {
        await bumpMemory(db, "nameplate", field, "line_label", "MODEL", "1");
        await bumpMemory(db, "nameplate", field, "line_label", "M/N", "1");
        await bumpMemory(db, storeKey, field, "line_label", "M/N", "1");
        await bumpMemory(db, storeKey, field, "value_in_text", correct, "1");
        await bumpMemory(db, "nameplate", field, "sub", ocrS, correct);
        if (storeKey === "nameplate_lennox" || /lennox/i.test(rawText || "")) {
          await bumpMemory(db, "nameplate_lennox", field, "line_label", "M/N", "1");
          await bumpMemory(db, "nameplate_lennox", field, "pattern", "layout:mn_line", "1");
          await bumpMemory(db, "nameplate_lennox", field, "value_in_text", correct, "1");
        }
      }
      if (field === "serial_number") {
        await bumpMemory(db, "nameplate", field, "line_label", "SERIAL", "1");
        await bumpMemory(db, "nameplate", field, "line_label", "S/N", "1");
        await bumpMemory(db, storeKey, field, "line_label", "S/N", "1");
        await bumpMemory(db, storeKey, field, "value_in_text", correct, "1");
        await bumpMemory(db, "nameplate", field, "sub", ocrS, correct);
        if (storeKey === "nameplate_lennox" || /lennox/i.test(rawText || "")) {
          await bumpMemory(db, "nameplate_lennox", field, "line_label", "S/N", "1");
          await bumpMemory(db, "nameplate_lennox", field, "pattern", "layout:sn_below_mn", "1");
          await bumpMemory(db, "nameplate_lennox", field, "value_in_text", correct, "1");
        }
      }
      if (field === "fuel_time" && (storeKey.startsWith("murphy") || /murphy/i.test(rawText || ""))) {
        await bumpMemory(db, storeKey, field, "pattern", "date_time_same_line", "1");
      }
    } else {
      // OCR missed field entirely — still learn where the answer lives
      if (field === "card_last4") {
        await bumpMemory(db, storeKey, field, "pattern", "after_usd", "1");
        await bumpMemory(db, "global", field, "pattern", "after_usd", "1");
        await bumpMemory(db, storeKey, field, "pattern", "pan_mask", "1");
        await bumpMemory(db, "global", field, "pattern", "pan_mask", "1");
        await bumpMemory(db, storeKey, field, "pattern", "after:VISA", "1");
        await bumpMemory(db, storeKey, field, "pattern", "before:ENTRY METHOD", "1");
      }
      if (field === "gallons" && isDumpStoreKey(storeKey)) {
        for (const lab of ["NET WT", "NET WEIGHT", "NET WGT", "NET LBS", "NET"]) {
          await bumpMemory(db, "dump", field, "line_label", lab, "1");
        }
        await bumpMemory(db, "dump", field, "pattern", "layout:dump_net", "1");
      } else if (field === "gallons") {
        await bumpMemory(db, storeKey, field, "pattern", "prefer_G_token", "1");
        await bumpMemory(db, "global", field, "pattern", "prefer_G_token", "1");
        if (storeKey.startsWith("murphy") || /murphy|qty\s*\(\s*gal/i.test(rawText || "")) {
          await bumpMemory(db, storeKey, field, "pattern", "prefer_qty_gal", "1");
          await bumpMemory(db, "global", field, "pattern", "prefer_qty_gal", "1");
          await bumpMemory(db, storeKey, field, "line_label", "QTY(GAL)", "1");
        }
      }
      if (field === "total_cost" && isDumpStoreKey(storeKey)) {
        for (const lab of ["TOTAL AMOUNT", "AMOUNT DUE", "TICKET TOTAL", "TOTAL", "AMOUNT"]) {
          await bumpMemory(db, "dump", field, "line_label", lab, "1");
        }
        await bumpMemory(db, "dump", field, "pattern", "layout:dump_total", "1");
      }
      if (field === "store_number") {
        await bumpMemory(db, storeKey, field, "pattern", "prefer_st_hash", "1");
        await bumpMemory(db, "global", field, "pattern", "prefer_st_hash", "1");
        if (storeKey.startsWith("murphy") || /murphy|site\s*[:#]/i.test(rawText || "")) {
          await bumpMemory(db, storeKey, field, "pattern", "prefer_site", "1");
          await bumpMemory(db, storeKey, field, "line_label", "MURPHY USA", "1");
          await bumpMemory(db, storeKey, field, "line_label", "SITE", "1");
        }
      }
      if (field === "fuel_time" && (storeKey.startsWith("murphy") || /murphy/i.test(rawText || ""))) {
        await bumpMemory(db, storeKey, field, "pattern", "date_time_same_line", "1");
      }
    }

    // Line label + neighbor anchors from raw OCR text
    if (rawText) {
      const line = findLineWithValue(rawText, correct);
      if (line) {
        const label = lineLabelHint(line, field);
        if (label) {
          await bumpMemory(db, storeKey, field, "line_label", label, "1");
          await bumpMemory(db, "global", field, "line_label", label, "1");
        }
        // Only store known value for card/store when it appears under a mask/pattern
        // (avoid auto-filling wrong fleet cards on every receipt)
        // Dump tickets: weight/total change every trip — never memorize the number itself
        if (field === "card_last4") {
          if (/[*xX#•·]{3,}/.test(line) || /\d{4}/.test(line)) {
            await bumpMemory(db, storeKey, field, "value_in_text", correct, correct);
          }
        } else if (
          (field === "gallons" || field === "total_cost") &&
          !isDumpStoreKey(storeKey)
        ) {
          await bumpMemory(db, storeKey, field, "value_in_text", correct, correct);
        } else if (field === "store_number") {
          await bumpMemory(db, storeKey, field, "value_in_text", correct, correct);
        }

        const neigh = neighborLabels(rawText, correct);
        for (const lab of neigh.after.slice(0, 4)) {
          await bumpMemory(db, storeKey, field, "pattern", `after:${lab}`, "1");
          if (!isDumpStoreKey(storeKey)) {
            await bumpMemory(db, "global", field, "pattern", `after:${lab}`, "1");
          }
        }
        for (const lab of neigh.before.slice(0, 4)) {
          await bumpMemory(db, storeKey, field, "pattern", `before:${lab}`, "1");
          if (!isDumpStoreKey(storeKey)) {
            await bumpMemory(db, "global", field, "pattern", `before:${lab}`, "1");
          }
        }
      } else if (field === "card_last4" && /^\d{4}$/.test(correct)) {
        // Value might be in OCR with spaces/noise — still reinforce pan patterns
        await bumpMemory(db, storeKey, field, "pattern", "after_usd", "1");
        await bumpMemory(db, "global", field, "pattern", "pan_mask", "1");
      }
    }
  }

  return { corrections: n };
}

/**
 * One-time bootstrap: re-walk past corrections so older saves teach patterns
 * (not only wrong→right substitutions).
 */
export async function bootstrapPatternsFromCorrections(db: D1Database): Promise<number> {
  try {
    const existing = await db
      .prepare(`SELECT COUNT(*) as c FROM ocr_memory WHERE memory_type = 'pattern'`)
      .first<{ c: number }>();
    if ((existing?.c ?? 0) > 5) return 0;

    const rows = await db
      .prepare(
        `SELECT store_key, field_name, ocr_value, correct_value, raw_text
         FROM ocr_corrections
         ORDER BY id DESC
         LIMIT 200`
      )
      .all<{
        store_key: string;
        field_name: string;
        ocr_value: string | null;
        correct_value: string;
        raw_text: string | null;
      }>();

    let n = 0;
    for (const r of rows.results || []) {
      const sk = r.store_key || "global";
      const field = r.field_name;
      const ocrS = r.ocr_value || "";
      const correct = r.correct_value;
      if (!correct) continue;

      if (field === "gallons" && ocrS) {
        const wrongN = parseFloat(ocrS);
        const rightN = parseFloat(correct);
        if (!Number.isNaN(wrongN) && looksLikePpg(wrongN) && rightN > 8) {
          await bumpMemory(db, sk, field, "pattern", "reject_ppg", "1");
          await bumpMemory(db, "global", field, "pattern", "reject_ppg", "1");
          await bumpMemory(db, sk, field, "pattern", "prefer_G_token", "1");
          await bumpMemory(db, "global", field, "pattern", "prefer_G_token", "1");
          n += 4;
        }
      }
      if (field === "card_last4") {
        await bumpMemory(db, sk, field, "pattern", "after_usd", "1");
        await bumpMemory(db, sk, field, "pattern", "pan_mask", "1");
        await bumpMemory(db, "global", field, "pattern", "after_usd", "1");
        await bumpMemory(db, "global", field, "pattern", "pan_mask", "1");
        n += 4;
      }
      if (field === "store_number") {
        await bumpMemory(db, sk, field, "pattern", "prefer_st_hash", "1");
        n += 1;
      }
      if (r.raw_text) {
        const line = findLineWithValue(r.raw_text, correct);
        if (line) {
          const lab = lineLabelHint(line, field);
          if (lab) {
            await bumpMemory(db, sk, field, "line_label", lab, "1");
            n += 1;
          }
          const neigh = neighborLabels(r.raw_text, correct);
          for (const a of neigh.after.slice(0, 3)) {
            await bumpMemory(db, sk, field, "pattern", `after:${a}`, "1");
            n += 1;
          }
          for (const b of neigh.before.slice(0, 3)) {
            await bumpMemory(db, sk, field, "pattern", `before:${b}`, "1");
            n += 1;
          }
        }
      }
    }
    return n;
  } catch {
    return 0;
  }
}

export async function getOcrHints(db: D1Database): Promise<OcrHints> {
  // Teach from historical corrections if patterns empty
  try {
    await bootstrapPatternsFromCorrections(db);
  } catch {
    /* ignore */
  }

  const hints: OcrHints = { subs: {}, line_labels: {}, patterns: {}, known_values: {} };
  try {
    const rows = await db
      .prepare(
        `SELECT store_key, field_name, memory_type, key_text, value_text, hits
         FROM ocr_memory
         WHERE hits >= 1
         ORDER BY hits DESC
         LIMIT 800`
      )
      .all<{
        store_key: string;
        field_name: string;
        memory_type: string;
        key_text: string;
        value_text: string;
        hits: number;
      }>();

    for (const r of rows.results || []) {
      if (r.memory_type === "sub") {
        if (!hints.subs[r.store_key]) hints.subs[r.store_key] = {};
        if (!hints.subs[r.store_key][r.field_name]) hints.subs[r.store_key][r.field_name] = {};
        if (!hints.subs[r.store_key][r.field_name][r.key_text]) {
          hints.subs[r.store_key][r.field_name][r.key_text] = r.value_text;
        }
      } else if (r.memory_type === "line_label") {
        if (!hints.line_labels[r.store_key]) hints.line_labels[r.store_key] = {};
        if (!hints.line_labels[r.store_key][r.field_name]) {
          hints.line_labels[r.store_key][r.field_name] = [];
        }
        const arr = hints.line_labels[r.store_key][r.field_name];
        // key_text is the label; value_text may be "1" (count) or legacy correct value
        const lab = r.key_text;
        if (!arr.includes(lab) && arr.length < 12) arr.push(lab);
      } else if (r.memory_type === "pattern") {
        if (!hints.patterns[r.store_key]) hints.patterns[r.store_key] = {};
        if (!hints.patterns[r.store_key][r.field_name]) {
          hints.patterns[r.store_key][r.field_name] = [];
        }
        const arr = hints.patterns[r.store_key][r.field_name];
        if (!arr.includes(r.key_text) && arr.length < 16) arr.push(r.key_text);
      } else if (r.memory_type === "value_in_text") {
        if (!hints.known_values[r.store_key]) hints.known_values[r.store_key] = {};
        if (!hints.known_values[r.store_key][r.field_name]) {
          hints.known_values[r.store_key][r.field_name] = [];
        }
        const arr = hints.known_values[r.store_key][r.field_name];
        if (!arr.includes(r.value_text) && arr.length < 30) arr.push(r.value_text);
      }
    }
  } catch {
    // tables may not exist yet
  }
  return hints;
}
