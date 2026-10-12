/**
 * Repair common UTF-8-as-Windows-1252 mojibake (e.g. • shown/stored as â€¢).
 * Apply at API read/write boundaries and UI display of free-text fields.
 * Leaves clean UTF-8 alone (fast gate on â€ / Ã¢ / Â· telltales).
 */

function looksMojibake(s: string): boolean {
  return (
    s.includes("\u00e2\u20ac") ||
    s.includes("\u00e2\u2020") ||
    s.includes("\u00c3\u00a2") ||
    s.includes("\u00c2\u00b7")
  );
}

/** CP1252 byte (0x80-0x9F) -> Unicode. */
const CP1252_BYTE_TO_UNICODE: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

const CP1252_UNICODE_TO_BYTE: Record<number, number> = Object.fromEntries(
  Object.entries(CP1252_BYTE_TO_UNICODE).map(([b, u]) => [u, Number(b)])
) as Record<number, number>;

function buildPairs(): Array<[string, string]> {
  const chars = [
    "\u2022",
    "\u2019",
    "\u2018",
    "\u201c",
    "\u201d",
    "\u2014",
    "\u2013",
    "\u2026",
    "\u00b7",
    "\u2192",
    "\u2039",
    "\u203a",
  ];
  const pairs: Array<[string, string]> = [];
  for (const ch of chars) {
    const utf8 = new TextEncoder().encode(ch);
    let bad = "";
    let ok = true;
    for (const b of utf8) {
      if (b <= 0x7f || b >= 0xa0) bad += String.fromCharCode(b);
      else if (CP1252_BYTE_TO_UNICODE[b] != null) {
        bad += String.fromCharCode(CP1252_BYTE_TO_UNICODE[b]);
      } else {
        ok = false;
        break;
      }
    }
    if (ok && bad && bad !== ch) pairs.push([bad, ch]);
  }
  pairs.push(["\u00c2\u00b7", "\u00b7"]); // Â· -> ·
  return pairs;
}

const PAIRS = buildPairs();

function tryCp1252Utf8RoundTrip(s: string): string | null {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let b: number | undefined;
    if (c <= 0xff && (c < 0x80 || c >= 0xa0)) b = c;
    else b = CP1252_UNICODE_TO_BYTE[c];
    if (b === undefined) return null;
    bytes[i] = b;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Repair a string; no-op when clean. */
export function repairUtf8Mojibake(input: string | null | undefined): string {
  if (input == null || input === "") return input ?? "";
  if (!looksMojibake(input)) return input;

  let out = input;
  for (const [bad, good] of PAIRS) {
    if (out.includes(bad)) out = out.split(bad).join(good);
  }

  if (looksMojibake(out)) {
    const round = tryCp1252Utf8RoundTrip(out);
    if (round != null && !looksMojibake(round)) out = round;
  }

  return out;
}

const AUDIT_STATUS_WORDS: Record<string, string> = {
  dropped_off: "dropped off",
  claim_submitted: "claim submitted",
  return_to_vendor: "return to vendor",
  not_warranty: "not a warranty",
};

/** Done-today and change history: repair the broken arrow, then plain words. */
export function plainAuditSummary(input: string | null | undefined): string {
  let s = repairUtf8Mojibake(input);
  s = s.replace(/[\u2190-\u21FF]/g, " - ");
  s = s.replace(
    /\b(dropped_off|claim_submitted|return_to_vendor|not_warranty)\b/g,
    (word) => AUDIT_STATUS_WORDS[word] || word
  );
  return s.replace(/[ \t]{2,}/g, " ").trim();
}

/** Mojibake repair, then store/show ASCII punctuation only (no em-dash, bullet, or middle dot). */
export function toAsciiUiText(input: string | null | undefined): string {
  if (input == null || input === "") return input ?? "";
  let s = repairUtf8Mojibake(input);
  s = s.replace(/â€“|â€”|â€•|â€"/g, "-");
  s = s.replace(/â€¢/g, "*");
  s = s.replace(/â€™|â€˜/g, "'");
  s = s.replace(/â€œ|â€\u009d/g, '"');
  s = s.replace(/â€¦/g, "...");
  s = s.replace(/Â·/g, " - ");
  s = s.replace(/[\u2012\u2013\u2014\u2015]/g, "-");
  s = s.replace(/\u2022/g, "*");
  s = s.replace(/\u00b7/g, " - ");
  s = s.replace(/[\u2018\u2019]/g, "'");
  s = s.replace(/[\u201C\u201D]/g, '"');
  s = s.replace(/\u2026/g, "...");
  s = s.replace(/[ \t]+/g, " ");
  return s.trim();
}

/** Repair known text fields on a fuel entry row. */
export function repairFuelEntryTextFields<T extends Record<string, unknown>>(row: T): T {
  const keys = [
    "station_notes",
    "ocr_raw_text",
    "employee_name",
    "entered_by_name",
    "reviewed_by_name",
  ];
  const out: Record<string, unknown> = { ...row };
  for (const key of keys) {
    if (typeof out[key] === "string") out[key] = repairUtf8Mojibake(out[key] as string);
  }
  return out as T;
}

export function repairTextFields<T extends Record<string, unknown>>(row: T, keys: string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const key of keys) {
    if (typeof out[key] === "string") out[key] = repairUtf8Mojibake(out[key] as string);
  }
  return out as T;
}
