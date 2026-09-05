/**
 * Office invoice lookup — fuzzy address → model/serial.
 * PRIMARY = buy/warranty local records (vendor invoice serials).
 * SECONDARY = ST Location installed equipment (may differ from buy invoice).
 * Never invents serials/models. Never silently picks when buy ≠ ST.
 */

import type { Env } from "./types";
import { stApiGet, stTenantId } from "./servicetitan";
import {
  normalizeAddress,
  pickDidYouMean,
  scoreAddressMatch,
} from "./addressFuzzy";

export type InvoiceLookupEquipment = {
  model: string | null;
  serial: string | null;
  label?: string | null;
};

/** buy = Field App buy/warranty records; st_installed = ST Location Equipment */
export type InvoiceLookupSection = "buy" | "st_installed";

export type InvoiceLookupResult = {
  source: "st" | "warranty" | "receipt";
  /** UI / print label — never mix unlabeled */
  source_label: string;
  section: InvoiceLookupSection;
  customer_name: string | null;
  address: string;
  equipment: InvoiceLookupEquipment[];
  invoice_number?: string | null;
  st_location_id?: number | null;
  warranty_log?: string | null;
  notes?: string | null;
  /** True when address matched but no model/serial to print */
  equipment_missing?: boolean;
};

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function asDataArray(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== "object") return [];
  const o = json as { data?: unknown };
  if (Array.isArray(o.data)) return o.data as Record<string, unknown>[];
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  return [];
}

function locationAddress(loc: Record<string, unknown>): string {
  const addr = (loc.address && typeof loc.address === "object"
    ? (loc.address as Record<string, unknown>)
    : loc) as Record<string, unknown>;
  const parts = [
    str(addr.street) || str(addr.addressLine1) || str(addr.line1),
    str(addr.unit) || str(addr.addressLine2) || str(addr.line2),
    str(addr.city),
    str(addr.state),
    str(addr.zip) || str(addr.postalCode),
  ].filter(Boolean);
  if (parts.length) return parts.join(", ");
  return str(loc.name) || str(loc.address) || "";
}

function customerNameFromLoc(loc: Record<string, unknown>): string | null {
  const c = loc.customer;
  if (c && typeof c === "object") {
    const n = str((c as Record<string, unknown>).name);
    if (n) return n;
  }
  const n = str(loc.customerName) || str(loc.name);
  return n || null;
}

async function stSearchLocations(
  env: Env,
  db: D1Database,
  tenantId: string,
  q: string
): Promise<Record<string, unknown>[]> {
  // ST global search is contains-only (townhouse ≠ town house) — Field App fuzzy still applies after
  const encoded = encodeURIComponent(q);
  const paths = [
    `/crm/v2/tenant/${encodeURIComponent(tenantId)}/locations?pageSize=50&street=${encoded}`,
    `/crm/v2/tenant/${encodeURIComponent(tenantId)}/locations?pageSize=50&name=${encoded}`,
    `/crm/v2/tenant/${encodeURIComponent(tenantId)}/locations?pageSize=50&address=${encoded}`,
  ];
  const byId = new Map<number, Record<string, unknown>>();
  for (const path of paths) {
    try {
      const got = await stApiGet(env, db, path);
      if (!got.ok) continue;
      for (const row of asDataArray(got.json)) {
        const id = Number(row.id);
        if (!id) continue;
        byId.set(id, row);
      }
    } catch {
      /* skip path */
    }
  }
  return [...byId.values()];
}

type EquipFetch = {
  equipment: InvoiceLookupEquipment[];
  /** True if every equipment path returned 403 / forbidden */
  scopeDenied: boolean;
  /** True if we got a successful empty list (no equipment on location) */
  okEmpty: boolean;
};

async function stInstalledEquipment(
  env: Env,
  db: D1Database,
  tenantId: string,
  locationId: number
): Promise<EquipFetch> {
  const paths = [
    `/crm/v2/tenant/${encodeURIComponent(tenantId)}/installed-equipment?locationIds=${locationId}&pageSize=50`,
    `/equipmentsystems/v2/tenant/${encodeURIComponent(tenantId)}/installed-equipment?locationId=${locationId}&pageSize=50`,
  ];
  let sawOk = false;
  let saw403 = false;
  const out: InvoiceLookupEquipment[] = [];
  for (const path of paths) {
    try {
      const got = await stApiGet(env, db, path);
      if (got.status === 403) {
        saw403 = true;
        continue;
      }
      if (!got.ok) continue;
      sawOk = true;
      for (const row of asDataArray(got.json)) {
        const model =
          str(row.model) ||
          str(row.modelNumber) ||
          str(row.manufacturerModel) ||
          null;
        const serial =
          str(row.serialNumber) ||
          str(row.serial) ||
          str(row.serial_number) ||
          null;
        const label =
          str(row.name) ||
          str(row.typeName) ||
          str(row.equipmentType) ||
          str(row.manufacturer) ||
          null;
        if (!model && !serial) continue;
        out.push({ model: model || null, serial: serial || null, label });
      }
      if (out.length) {
        return { equipment: out, scopeDenied: false, okEmpty: false };
      }
    } catch {
      /* try next path */
    }
  }
  return {
    equipment: out,
    scopeDenied: !sawOk && saw403,
    okEmpty: sawOk && out.length === 0,
  };
}

function dedupeKey(r: InvoiceLookupResult): string {
  const serials = r.equipment
    .map((e) => (e.serial || "").toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
  return `${r.section}::${normalizeAddress(r.address)}::${
    serials || r.source + ":" + (r.st_location_id || r.warranty_log || r.invoice_number || "")
  }`;
}

export async function runInvoiceLookup(
  env: Env,
  db: D1Database,
  rawQuery: string
): Promise<{
  query: string;
  normalized: string;
  results: InvoiceLookupResult[];
  suggestions: string[];
  st_error?: string | null;
  /** Equipment Systems / Installed Equipment API missing or 403 */
  st_installed_unavailable?: boolean;
  st_installed_banner?: string | null;
}> {
  const query = rawQuery.trim();
  const normalized = normalizeAddress(query);
  const results: InvoiceLookupResult[] = [];
  const suggestionPool: string[] = [];
  let stError: string | null = null;
  let stInstalledUnavailable = false;

  // ——— 1) PRIMARY: buy / warranty / local records ———
  try {
    const rows = await db
      .prepare(
        `SELECT id, log_number, status, part_name, vendor_name, service_address,
                customer_name, model_number, serial_number, notes
         FROM warranty_claims
         WHERE service_address IS NOT NULL AND trim(service_address) != ''
         ORDER BY dropped_off_at DESC
         LIMIT 400`
      )
      .all<{
        id: number;
        log_number: string;
        status: string;
        part_name: string;
        vendor_name: string | null;
        service_address: string;
        customer_name: string | null;
        model_number: string | null;
        serial_number: string | null;
        notes: string | null;
      }>();
    for (const w of rows.results || []) {
      suggestionPool.push(w.service_address);
      const scored = scoreAddressMatch(w.service_address, query);
      if (!scored || scored.match === "near") continue;
      const model = (w.model_number || "").trim() || null;
      const serial = (w.serial_number || "").trim() || null;
      const missing = !model && !serial;
      results.push({
        source: "warranty",
        source_label: "From buy / warranty records",
        section: "buy",
        customer_name: w.customer_name,
        address: w.service_address,
        equipment: missing
          ? []
          : [
              {
                model,
                serial,
                label: w.part_name || null,
              },
            ],
        invoice_number: null,
        st_location_id: null,
        warranty_log: w.log_number,
        notes: missing
          ? `Buy/warranty address matched — no model/serial on card (${w.log_number})`
          : `Warranty ${w.log_number} · ${w.status}${w.vendor_name ? ` · ${w.vendor_name}` : ""}`,
        equipment_missing: missing,
      });
    }
  } catch {
    /* table optional */
  }

  try {
    const rows = await db
      .prepare(
        `SELECT id, vendor_name, invoice_number, notes, purchase_date, created_at
         FROM parts_purchase_receipts
         WHERE notes IS NOT NULL AND trim(notes) != ''
         ORDER BY created_at DESC
         LIMIT 250`
      )
      .all<{
        id: number;
        vendor_name: string;
        invoice_number: string | null;
        notes: string;
        purchase_date: string | null;
      }>();
    for (const r of rows.results || []) {
      const note = String(r.notes || "");
      if (!/\d+\s+\w+/.test(note)) continue;
      const addrLine = note.split(/[\n;|]/)[0]?.trim() || note.trim();
      suggestionPool.push(addrLine);
      const scored = scoreAddressMatch(note, query);
      if (!scored || scored.match === "near") continue;
      const inv = (r.invoice_number || "").trim() || null;
      results.push({
        source: "receipt",
        source_label: "From buy / warranty records",
        section: "buy",
        customer_name: null,
        address: addrLine,
        equipment: [],
        invoice_number: inv,
        st_location_id: null,
        warranty_log: null,
        notes: `Buy receipt · ${r.vendor_name}${
          r.purchase_date ? ` · ${r.purchase_date}` : ""
        }${inv ? ` · Inv ${inv}` : ""} · no model/serial on receipt row`,
        equipment_missing: true,
      });
    }
  } catch {
    /* optional */
  }

  // Part pickup tickets — job address (no serial usually; still useful address hits)
  try {
    const rows = await db
      .prepare(
        `SELECT id, vendor_name, notes, purchase_order, needed_for_date, status
         FROM part_pickup_tickets
         WHERE notes IS NOT NULL AND trim(notes) != ''
         ORDER BY id DESC
         LIMIT 200`
      )
      .all<{
        id: number;
        vendor_name: string;
        notes: string;
        purchase_order: string | null;
        status: string;
      }>();
    for (const t of rows.results || []) {
      const addr = String(t.notes || "").trim();
      if (!/\d+\s+\w+/.test(addr)) continue;
      suggestionPool.push(addr);
      const scored = scoreAddressMatch(addr, query);
      if (!scored || scored.match === "near") continue;
      // Pull line part names for context (still no invented serial)
      let lineParts: string[] = [];
      try {
        const lines = await db
          .prepare(
            `SELECT part_name, part_code FROM part_pickup_ticket_lines
             WHERE ticket_id = ? ORDER BY line_no ASC LIMIT 8`
          )
          .bind(t.id)
          .all<{ part_name: string | null; part_code: string | null }>();
        lineParts = (lines.results || [])
          .map((l) => (l.part_name || l.part_code || "").trim())
          .filter(Boolean);
      } catch {
        /* ignore */
      }
      results.push({
        source: "receipt",
        source_label: "From buy / warranty records",
        section: "buy",
        customer_name: (t.purchase_order || "").trim() || null,
        address: addr,
        equipment: [],
        invoice_number: null,
        st_location_id: null,
        warranty_log: null,
        notes: `Part pickup · ${t.vendor_name}${
          lineParts.length ? ` · ${lineParts.slice(0, 3).join(", ")}` : ""
        } · no model/serial on pickup (buy invoice may be separate)`,
        equipment_missing: true,
      });
    }
  } catch {
    /* optional */
  }

  // ——— 2) SECONDARY: ST Location → installed equipment ———
  try {
    const tenantId = await stTenantId(env, db);
    if (tenantId) {
      // Also try fuzzy-expanded query variants for ST contains-only search
      const variants = [
        query,
        normalized,
        normalized.replace(/\btownhouse\b/g, "town house"),
      ].filter((v, i, a) => v && a.indexOf(v) === i);

      const locById = new Map<number, Record<string, unknown>>();
      for (const v of variants) {
        const locs = await stSearchLocations(env, db, tenantId, v);
        for (const loc of locs) {
          const id = Number(loc.id);
          if (id) locById.set(id, loc);
        }
      }

      for (const loc of locById.values()) {
        const address = locationAddress(loc);
        if (!address) continue;
        suggestionPool.push(address);
        const scored = scoreAddressMatch(address, query);
        if (!scored || scored.match === "near") continue;

        const locId = Number(loc.id) || null;
        let equipment: InvoiceLookupEquipment[] = [];
        if (locId) {
          const fetched = await stInstalledEquipment(env, db, tenantId, locId);
          if (fetched.scopeDenied) stInstalledUnavailable = true;
          equipment = fetched.equipment;
        }
        const missing = !equipment.some((e) => e.model || e.serial);
        results.push({
          source: "st",
          source_label: "From ST installed equipment",
          section: "st_installed",
          customer_name: customerNameFromLoc(loc),
          address,
          equipment: missing ? [] : equipment,
          invoice_number: null,
          st_location_id: locId,
          warranty_log: null,
          notes: missing
            ? "ST location matched — no installed equipment model/serial returned (may differ from buy invoice)"
            : "ST installed equipment may differ from the buy-vendor invoice serial",
          equipment_missing: missing,
        });
      }

      for (const loc of locById.values()) {
        const address = locationAddress(loc);
        if (!address) continue;
        const scored = scoreAddressMatch(address, query);
        if (scored?.match === "near") suggestionPool.push(address);
      }
    } else {
      stError = "ServiceTitan not configured";
    }
  } catch (e) {
    stError = e instanceof Error ? e.message : String(e);
  }

  // Dedupe within section+address+serial
  const seen = new Set<string>();
  const deduped: InvoiceLookupResult[] = [];
  for (const r of results) {
    const k = dedupeKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }

  // Buy section first, then ST; within each, prefer rows that have equipment
  deduped.sort((a, b) => {
    const sec = (s: InvoiceLookupSection) => (s === "buy" ? 0 : 1);
    if (sec(a.section) !== sec(b.section)) return sec(a.section) - sec(b.section);
    const ae = a.equipment_missing ? 1 : 0;
    const be = b.equipment_missing ? 1 : 0;
    return ae - be;
  });

  const hitAddrs = new Set(deduped.map((r) => normalizeAddress(r.address)));
  const suggestions = pickDidYouMean(
    suggestionPool.filter((a) => !hitAddrs.has(normalizeAddress(a))),
    query,
    5
  );

  const banner = stInstalledUnavailable
    ? "ST installed equipment not available (API scope) — using buy records only"
    : null;

  return {
    query,
    normalized,
    results: deduped,
    suggestions,
    st_error: stError,
    st_installed_unavailable: stInstalledUnavailable,
    st_installed_banner: banner,
  };
}

export function invoiceLookupPrintHtml(opts: {
  company?: string;
  address: string;
  customer_name?: string | null;
  equipment: InvoiceLookupEquipment[];
  invoice_number?: string | null;
  warranty_log?: string | null;
  printed_by: string;
  notes?: string | null;
  source_label?: string | null;
  section?: InvoiceLookupSection | null;
}): string {
  const company = opts.company || "Total Assurance A/C & Heating";
  const esc = (s: string) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const when = new Date().toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const sourceLine =
    opts.source_label ||
    (opts.section === "st_installed"
      ? "From ST installed equipment"
      : opts.section === "buy"
        ? "From buy / warranty records"
        : "");
  const equipBlocks =
    opts.equipment.filter((e) => e.model || e.serial).length > 0
      ? opts.equipment
          .filter((e) => e.model || e.serial)
          .map(
            (e) => `<div class="equip">
        ${e.label ? `<div class="label">${esc(e.label)}</div>` : ""}
        <div class="field"><span>Model</span><strong>${esc(e.model || "—")}</strong></div>
        <div class="field"><span>Serial</span><strong>${esc(e.serial || "—")}</strong></div>
      </div>`
          )
          .join("")
      : `<div class="equip missing"><p>No model/serial on this record. Ask tech or check the buy-vendor invoice.</p></div>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Invoice lookup — ${esc(opts.address)}</title>
<style>
  @page { margin: 0.55in; size: letter; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #0f172a; margin: 0; }
  .sheet { max-width: 7.5in; margin: 0 auto; }
  .head { border-bottom: 3px solid #0c1f4a; padding-bottom: 0.65rem; margin-bottom: 1rem; }
  .brand { font-size: 1.15rem; font-weight: 800; color: #0c1f4a; }
  .sub { font-size: 0.9rem; color: #475569; margin-top: 0.15rem; }
  .meta { font-size: 0.8rem; color: #64748b; margin-top: 0.45rem; }
  .source { display: inline-block; margin-top: 0.45rem; padding: 0.2rem 0.5rem; border: 1.5px solid #0c1f4a; border-radius: 6px; font-size: 0.78rem; font-weight: 750; text-transform: uppercase; letter-spacing: 0.04em; }
  .addr { font-size: 1.15rem; font-weight: 700; margin: 0.75rem 0 0.25rem; }
  .cust { font-size: 1rem; margin-bottom: 0.85rem; }
  .equip { border: 2px solid #0c1f4a; border-radius: 10px; padding: 0.85rem 1rem; margin: 0.65rem 0; }
  .equip.missing { border-style: dashed; color: #64748b; }
  .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-bottom: 0.35rem; font-weight: 700; }
  .field { margin: 0.45rem 0; }
  .field span { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; font-weight: 700; }
  .field strong { display: block; font-size: 1.65rem; letter-spacing: -0.02em; line-height: 1.2; word-break: break-word; }
  .inv { margin-top: 0.85rem; font-size: 1.05rem; }
  .actions { margin: 0.75rem 0 1rem; }
  @media print { .actions { display: none !important; } }
</style></head><body>
  <div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="sheet">
    <div class="head">
      <div class="brand">${esc(company)}</div>
      <div class="sub">Invoice lookup — model &amp; serial</div>
      <div class="meta">Printed ${esc(when)} · ${esc(opts.printed_by)}</div>
      ${sourceLine ? `<div class="source">${esc(sourceLine)}</div>` : ""}
    </div>
    <div class="addr">${esc(opts.address)}</div>
    ${opts.customer_name ? `<div class="cust">${esc(opts.customer_name)}</div>` : ""}
    ${equipBlocks}
    ${
      opts.invoice_number
        ? `<div class="inv"><strong>Invoice #</strong> ${esc(opts.invoice_number)}</div>`
        : ""
    }
    ${
      opts.warranty_log
        ? `<div class="meta">Warranty log ${esc(opts.warranty_log)}</div>`
        : ""
    }
  </div>
  <script>window.onload=function(){setTimeout(function(){window.print();},280);};</script>
</body></html>`;
}
