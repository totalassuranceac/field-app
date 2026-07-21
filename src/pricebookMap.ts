/**
 * ServiceTitan Pricebook column map (Materials sheet).
 * Import / export use these exact headers so round-trips stay consistent.
 *
 * Workbook sheets (yours): Categories, Equipment, Services, DiscountsAndFees,
 * Materials, links, Assets, variants…
 * Inventory parts come from the **Materials** sheet only.
 */

/** Preferred sheet for stocked parts */
export const ST_MATERIALS_SHEET = "Materials";

/** One vendor quote (app part_vendors or ST [Vendor] block) */
export interface VendorQuote {
  vendor_name: string;
  vendor_part_number?: string | null;
  cost?: number | null;
  available?: boolean | number;
  is_primary?: boolean;
  notes?: string | null;
}

export interface ImportRow {
  external_st_id?: string | number | null;
  code: string;
  name: string;
  description_text?: string | null;
  category?: string | null;
  cost?: number | null;
  price?: number | null;
  unit_of_measure?: string | null;
  is_inventory?: boolean | number | null;
  active?: boolean | number | null;
  primary_vendor?: string | null;
  /** Product photo URL (ST Image1) — kept for display; ST code stays in `code` for export */
  image_url?: string | null;
  /** All vendor quotes from ST columns or app */
  vendors?: VendorQuote[];
}

/** Canonical ST Materials columns we read / write */
export const ST_MATERIALS_COLUMNS = {
  id: "Id",
  categoryId: "Category.Id",
  categoryName: "Category.Name",
  code: "Code",
  name: "Name",
  description: "Description",
  cost: "Cost",
  price: "Price",
  memberPrice: "MemberPrice",
  unitOfMeasure: "UnitOfMeasure",
  isInventory: "IsInventory",
  active: "Active",
  image1: "Image1",
  externalId: "ExternalId",
  source: "Source",
  /** Vendor block pattern: `{VendorName}[Vendor] Active?` / `Part #` / `Price` / `Primary Vendor?` */
  vendorActiveSuffix: "[Vendor] Active?",
  vendorPartSuffix: "[Vendor] Part #",
  vendorPriceSuffix: "[Vendor] Price",
  vendorPrimarySuffix: "[Vendor] Primary Vendor?",
} as const;

export type ColumnMappingDisplay = {
  field: string;
  stColumn: string;
  sample?: string;
};

function pickKey(row: Record<string, unknown>, candidates: string[]): string | null {
  const keys = Object.keys(row);
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, "");
  const map = new Map(keys.map((k) => [norm(k), k]));
  for (const c of candidates) {
    const hit = map.get(norm(c));
    if (hit) return hit;
  }
  return null;
}

function val(row: Record<string, unknown>, key: string | null): unknown {
  if (!key) return undefined;
  return row[key];
}

function asBool(v: unknown, defaultVal = true): boolean {
  if (v === null || v === undefined || v === "") return defaultVal;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return defaultVal;
}

function asNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const t = String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
}

/** First usable image path from Image1 / Image2 / Image3 (ST may stack paths with newlines). */
export function firstStImagePath(row: Record<string, unknown>): string | null {
  for (const key of ["Image1", "Image2", "Image3", "Image", "ImageUrl", "Photo"]) {
    const raw = row[key];
    if (raw == null || String(raw).trim() === "") continue;
    // Split multi-path cells (seen in ST exports)
    const parts = String(raw)
      .split(/[\n\r;|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of parts) {
      if (
        /^https?:\/\//i.test(s) ||
        s.startsWith("/") ||
        s.startsWith("Images/") ||
        s.startsWith("Pricebook/") ||
        /\.(png|jpe?g|webp|gif)$/i.test(s)
      ) {
        return s;
      }
    }
  }
  return null;
}

/** Discover vendor names from ST-style `[Vendor]` column headers. */
export function discoverVendorNames(headers: string[]): string[] {
  const names = new Set<string>();
  const re = /^(.+)\[Vendor\]\s*Primary Vendor\?$/i;
  const re2 = /^(.+)\[Vendor\]\s*Price$/i;
  for (const h of headers) {
    const m = h.match(re) || h.match(re2);
    if (m) {
      const name = m[1].trim();
      // Skip empty / junk
      if (name && !/deactivated/i.test(name)) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function vendorCol(
  keys: string[],
  vendor: string,
  kind: "Active?" | "Part #" | "Price" | "Primary Vendor?" | "Memo"
): string | null {
  const needle = `${vendor}[Vendor] ${kind}`.toLowerCase();
  return keys.find((k) => k.trim().toLowerCase() === needle) || null;
}

/**
 * Read all ST `[Vendor]` blocks on a Materials row (Active / Part # / Price / Primary).
 */
export function extractAllVendors(
  row: Record<string, unknown>,
  vendorNames: string[]
): VendorQuote[] {
  const keys = Object.keys(row);
  const out: VendorQuote[] = [];
  for (const v of vendorNames) {
    const aKey = vendorCol(keys, v, "Active?");
    const pKey = vendorCol(keys, v, "Primary Vendor?");
    const priceK = vendorCol(keys, v, "Price");
    const partK = vendorCol(keys, v, "Part #");
    const memoK = vendorCol(keys, v, "Memo");
    const cost = priceK ? asNum(row[priceK]) : null;
    const part =
      partK && row[partK] != null && String(row[partK]).trim() !== ""
        ? String(row[partK]).trim()
        : null;
    const primary = pKey ? asBool(row[pKey], false) : false;
    const active = aKey ? asBool(row[aKey], false) : cost != null || !!part || primary;
    // Skip empty vendor blocks
    if (!active && cost == null && !part && !primary) continue;
    out.push({
      vendor_name: v,
      vendor_part_number: part,
      cost,
      available: active || primary || cost != null,
      is_primary: primary,
      notes: memoK && row[memoK] != null && String(row[memoK]).trim() ? String(row[memoK]).trim() : null,
    });
  }
  return out;
}

/**
 * Pick primary vendor + cost from ST vendor blocks on a Materials row.
 * Prefers Primary Vendor?=1, else cheapest available quote, else Cost column.
 */
export function extractPrimaryVendor(
  row: Record<string, unknown>,
  vendorNames: string[]
): { vendor: string | null; vendorPart: string | null; vendorCost: number | null; vendors: VendorQuote[] } {
  const vendors = extractAllVendors(row, vendorNames);
  const primary = vendors.find((v) => v.is_primary);
  if (primary) {
    return {
      vendor: primary.vendor_name,
      vendorPart: primary.vendor_part_number || null,
      vendorCost: primary.cost ?? null,
      vendors,
    };
  }
  const available = vendors.filter((v) => v.available && v.cost != null);
  available.sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0));
  if (available[0]) {
    return {
      vendor: available[0].vendor_name,
      vendorPart: available[0].vendor_part_number || null,
      vendorCost: available[0].cost ?? null,
      vendors,
    };
  }
  return { vendor: null, vendorPart: null, vendorCost: null, vendors };
}

export function resolveMaterialsSheetName(sheetNames: string[]): string | null {
  const exact = sheetNames.find((n) => n.trim().toLowerCase() === "materials");
  if (exact) return exact;
  const fuzzy = sheetNames.find((n) => /material/i.test(n));
  return fuzzy || null;
}

/**
 * Map one ST Materials row using known column names.
 * Returns null if Code or Name missing.
 */
export function mapMaterialsRow(
  row: Record<string, unknown>,
  vendorNames: string[]
): ImportRow | null {
  const idK = pickKey(row, [ST_MATERIALS_COLUMNS.id, "MaterialId"]);
  const codeK = pickKey(row, [ST_MATERIALS_COLUMNS.code, "ItemCode", "SKU"]);
  const nameK = pickKey(row, [ST_MATERIALS_COLUMNS.name, "DisplayName", "ItemName"]);
  if (!codeK || !nameK) return null;
  const code = String(val(row, codeK) ?? "").trim();
  const name = String(val(row, nameK) ?? "").trim();
  if (!code || !name) return null;

  const catK = pickKey(row, [ST_MATERIALS_COLUMNS.categoryName, "Category", "Categories"]);
  const descK = pickKey(row, [ST_MATERIALS_COLUMNS.description, "LongDescription"]);
  const costK = pickKey(row, [ST_MATERIALS_COLUMNS.cost, "UnitCost"]);
  const priceK = pickKey(row, [ST_MATERIALS_COLUMNS.price, "MemberPrice", "UnitPrice"]);
  const uomK = pickKey(row, [ST_MATERIALS_COLUMNS.unitOfMeasure, "UOM", "Unit"]);
  const invK = pickKey(row, [ST_MATERIALS_COLUMNS.isInventory, "Is Inventory"]);
  const actK = pickKey(row, [ST_MATERIALS_COLUMNS.active, "IsActive"]);
  const extK = pickKey(row, [ST_MATERIALS_COLUMNS.externalId, "External Id"]);

  const { vendor, vendorCost, vendors } = extractPrimaryVendor(row, vendorNames);
  const costFromCol = asNum(val(row, costK));
  const cost = costFromCol != null ? costFromCol : vendorCost;
  // ST may put multiple paths in Image1 separated by newlines; also check Image2/3
  const image_url = firstStImagePath(row);

  return {
    external_st_id: val(row, idK) != null && String(val(row, idK)).trim() !== ""
      ? (val(row, idK) as string | number)
      : null,
    code,
    name,
    description_text: stripHtml(val(row, descK) != null ? String(val(row, descK)) : null),
    category: val(row, catK) != null && String(val(row, catK)).trim() ? String(val(row, catK)).trim() : null,
    cost,
    price: asNum(val(row, priceK)),
    unit_of_measure:
      val(row, uomK) != null && String(val(row, uomK)).trim() ? String(val(row, uomK)).trim() : null,
    is_inventory: asBool(val(row, invK), true),
    active: asBool(val(row, actK), true),
    primary_vendor: vendor,
    image_url,
    vendors,
  };
}

/** Human-readable mapping for UI after file load */
export function describeMaterialsMapping(
  sampleRow: Record<string, unknown> | null,
  sheetName: string,
  vendorNames: string[]
): ColumnMappingDisplay[] {
  if (!sampleRow) {
    return [
      { field: "Sheet", stColumn: sheetName },
      { field: "ST Id", stColumn: ST_MATERIALS_COLUMNS.id },
      { field: "Code", stColumn: ST_MATERIALS_COLUMNS.code },
      { field: "Name", stColumn: ST_MATERIALS_COLUMNS.name },
      { field: "Category", stColumn: ST_MATERIALS_COLUMNS.categoryName },
      { field: "Cost", stColumn: ST_MATERIALS_COLUMNS.cost },
      { field: "Price", stColumn: ST_MATERIALS_COLUMNS.price },
      { field: "Is inventory", stColumn: ST_MATERIALS_COLUMNS.isInventory },
      { field: "Active", stColumn: ST_MATERIALS_COLUMNS.active },
      { field: "Vendor", stColumn: `{Name}[Vendor] Primary / Price` },
    ];
  }
  const idK = pickKey(sampleRow, [ST_MATERIALS_COLUMNS.id]) || ST_MATERIALS_COLUMNS.id;
  const codeK = pickKey(sampleRow, [ST_MATERIALS_COLUMNS.code]) || ST_MATERIALS_COLUMNS.code;
  const nameK = pickKey(sampleRow, [ST_MATERIALS_COLUMNS.name]) || ST_MATERIALS_COLUMNS.name;
  const catK = pickKey(sampleRow, [ST_MATERIALS_COLUMNS.categoryName]) || ST_MATERIALS_COLUMNS.categoryName;
  const costK = pickKey(sampleRow, [ST_MATERIALS_COLUMNS.cost]) || ST_MATERIALS_COLUMNS.cost;
  const priceK = pickKey(sampleRow, [ST_MATERIALS_COLUMNS.price]) || ST_MATERIALS_COLUMNS.price;
  const invK = pickKey(sampleRow, [ST_MATERIALS_COLUMNS.isInventory]) || ST_MATERIALS_COLUMNS.isInventory;
  const samp = (k: string) => {
    const v = sampleRow[k];
    if (v == null || v === "") return "—";
    const s = String(v).replace(/<[^>]+>/g, " ").trim();
    return s.length > 40 ? s.slice(0, 40) + "…" : s;
  };
  return [
    { field: "Sheet", stColumn: sheetName, sample: sheetName },
    { field: "ServiceTitan Id", stColumn: idK, sample: samp(idK) },
    { field: "Code", stColumn: codeK, sample: samp(codeK) },
    { field: "Name", stColumn: nameK, sample: samp(nameK) },
    { field: "Category", stColumn: catK, sample: samp(catK) },
    { field: "Cost", stColumn: costK, sample: samp(costK) },
    { field: "Sell price", stColumn: priceK, sample: samp(priceK) },
    { field: "Is inventory", stColumn: invK, sample: samp(invK) },
    {
      field: "Primary vendor",
      stColumn: vendorNames.length
        ? vendorNames.join(", ")
        : "No vendor columns found",
      sample: vendorNames[0] || "—",
    },
  ];
}

export function parseStPricebookFromSheetJson(
  sheetName: string,
  raw: Record<string, unknown>[],
  allSheetNames: string[],
  opts?: { inventoryOnly?: boolean }
): {
  sheetName: string;
  rows: ImportRow[];
  mapping: ColumnMappingDisplay[];
  inventoryOnlyCount: number;
  totalMaterials: number;
  vendorNames: string[];
  allSheetNames: string[];
} {
  const inventoryOnly = opts?.inventoryOnly !== false;
  const headers = raw[0] ? Object.keys(raw[0]) : [];
  const vendorNames = discoverVendorNames(headers);
  const mapped: ImportRow[] = [];
  let inventoryOnlyCount = 0;

  for (const row of raw) {
    const m = mapMaterialsRow(row, vendorNames);
    if (!m) continue;
    if (m.is_inventory) inventoryOnlyCount++;
    if (inventoryOnly && !m.is_inventory) continue;
    mapped.push(m);
  }

  return {
    sheetName,
    rows: mapped,
    mapping: describeMaterialsMapping(raw[0] || null, sheetName, vendorNames),
    inventoryOnlyCount,
    totalMaterials: raw.length,
    vendorNames,
    allSheetNames,
  };
}

export type ExportPart = {
  external_st_id?: string | number | null;
  code: string;
  name: string;
  description_text?: string | null;
  category?: string | null;
  cost?: number | null;
  price?: number | null;
  unit_of_measure?: string | null;
  is_inventory?: number | boolean | null;
  active?: number | boolean | null;
  primary_vendor?: string | null;
  /** Quotes from part_vendors — written as ST [Vendor] columns for re-import */
  vendors?: VendorQuote[];
};

/**
 * Export catalog to ST Materials-style rows including every vendor quote.
 * All vendor names across the export share the same columns so ST can add
 * new vendors / part numbers when the file is imported there.
 */
export function partsToStMaterialsExportRows(parts: ExportPart[]): Record<string, unknown>[] {
  const vendorNames = new Set<string>();
  for (const p of parts) {
    for (const v of p.vendors || []) {
      if (v.vendor_name?.trim()) vendorNames.add(v.vendor_name.trim());
    }
    if (p.primary_vendor?.trim()) vendorNames.add(p.primary_vendor.trim());
  }
  const vendorsSorted = [...vendorNames].sort((a, b) => a.localeCompare(b));

  return parts.map((p) => {
    const row: Record<string, unknown> = {
      [ST_MATERIALS_COLUMNS.id]: p.external_st_id ?? "",
      [ST_MATERIALS_COLUMNS.categoryName]: p.category ?? "",
      [ST_MATERIALS_COLUMNS.code]: p.code,
      [ST_MATERIALS_COLUMNS.name]: p.name,
      [ST_MATERIALS_COLUMNS.description]: p.description_text ?? "",
      [ST_MATERIALS_COLUMNS.cost]: p.cost ?? "",
      [ST_MATERIALS_COLUMNS.price]: p.price ?? "",
      [ST_MATERIALS_COLUMNS.unitOfMeasure]: p.unit_of_measure ?? "",
      [ST_MATERIALS_COLUMNS.isInventory]: p.is_inventory ? 1 : 0,
      [ST_MATERIALS_COLUMNS.active]: p.active === 0 || p.active === false ? 0 : 1,
      [ST_MATERIALS_COLUMNS.externalId]: "",
      [ST_MATERIALS_COLUMNS.source]: "TotalAssuranceFleet",
    };

    const quotes = new Map<string, VendorQuote>();
    for (const v of p.vendors || []) {
      if (v.vendor_name?.trim()) quotes.set(v.vendor_name.trim(), v);
    }
    // Ensure primary_vendor appears even if no part_vendors row yet
    if (p.primary_vendor?.trim() && !quotes.has(p.primary_vendor.trim())) {
      quotes.set(p.primary_vendor.trim(), {
        vendor_name: p.primary_vendor.trim(),
        cost: p.cost ?? null,
        available: true,
        is_primary: true,
        vendor_part_number: null,
      });
    }

    const defaultName =
      p.primary_vendor?.trim() ||
      [...quotes.values()].find((q) => q.is_primary)?.vendor_name ||
      [...quotes.values()].sort((a, b) => (a.cost ?? 1e12) - (b.cost ?? 1e12))[0]?.vendor_name ||
      null;

    for (const name of vendorsSorted) {
      const q = quotes.get(name);
      const isPrimary = defaultName === name || Boolean(q?.is_primary);
      const active = q
        ? q.available === false || q.available === 0
          ? 0
          : 1
        : 0;
      row[`${name}[Vendor] Active?`] = q ? active : 0;
      row[`${name}[Vendor] Part #`] = q?.vendor_part_number ?? "";
      row[`${name}[Vendor] Memo`] = q?.notes ?? "";
      row[`${name}[Vendor] Price`] = q?.cost != null ? q.cost : "";
      row[`${name}[Vendor] Primary Vendor?`] = q && isPrimary ? 1 : 0;
    }
    return row;
  });
}
