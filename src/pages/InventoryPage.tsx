import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { api, can } from "../api";
import { useAuth } from "../auth";
import {
  parseStPricebookFromSheetJson,
  partsToStMaterialsExportRows,
  resolveMaterialsSheetName,
  type ColumnMappingDisplay,
  type ImportRow,
} from "../pricebookMap";
import { partImageSrc } from "../partImage";
import { PickupPanel } from "../components/PickupPanel";
import { VendorRunPanel } from "../components/VendorRunPanel";
import { LogItem, LogList } from "../components/CollapsibleLog";
import { BarcodeScanButton } from "../components/BarcodeScan";

type Tab =
  | "stock"
  | "pickup"
  | "vendor"
  | "order"
  | "stage"
  | "catalog"
  | "history"
  | "sections";

interface StockLocation {
  id: number;
  type: "warehouse" | "attic" | "vehicle";
  vehicle_id: number | null;
  name: string;
  unit_number?: string | null;
  zone?: string | null;
  notes?: string | null;
  sort_order?: number | null;
}

interface PartRow {
  id: number;
  code: string;
  name: string;
  category: string | null;
  cost: number | null;
  unit_of_measure: string | null;
  primary_vendor: string | null;
  image_url?: string | null;
  is_inventory: number;
  truck_stock?: number;
  total_qty: number;
  min_qty?: number | null;
  max_qty?: number | null;
  home_location_id?: number | null;
  home_location_name?: string | null;
  home_zone?: string | null;
  home_type?: string | null;
  external_st_id?: string | null;
}

/**
 * Product thumbnail.
 * Same-origin /api/* URLs send session cookies automatically via <img> —
 * no fetch/blob (that path was flaky with cache + StrictMode).
 */
function PartThumb({
  src,
  name,
  size = 52,
}: {
  src?: string | null;
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const resolved = partImageSrc(src);
  const [trySrc, setTrySrc] = useState<string | null>(resolved);

  useEffect(() => {
    setFailed(false);
    setTrySrc(resolved);
  }, [resolved]);

  const showImg = Boolean(trySrc) && !failed;
  return (
    <div
      className="inv-thumb"
      style={{ width: size, height: size, minWidth: size }}
      aria-hidden={!showImg}
    >
      {showImg ? (
        <img
          src={trySrc!}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => {
            // One hard cache-bust retry, then fall back to initials
            if (trySrc && !trySrc.includes("cb=")) {
              setTrySrc(`${trySrc}${trySrc.includes("?") ? "&" : "?"}cb=${Date.now()}`);
              return;
            }
            setFailed(true);
          }}
        />
      ) : (
        <span className="inv-thumb-placeholder">{(name || "?").slice(0, 2).toUpperCase()}</span>
      )}
    </div>
  );
}

interface PartBalance {
  qty: number;
  location_id: number;
  type: string;
  location_name: string;
  unit_number?: string | null;
  zone?: string | null;
  location_notes?: string | null;
  min_qty?: number | null;
  max_qty?: number | null;
  loc_min_qty?: number | null;
  loc_max_qty?: number | null;
  is_home?: number | boolean;
  is_overstock?: number | boolean;
}

function zoneLabel(zone?: string | null, type?: string): string {
  const z = (zone || "").toLowerCase();
  if (z === "overhead") return "Overhead";
  if (z === "attic" || type === "attic") return "Attic";
  if (z === "main") return "Main floor";
  if (z === "truck" || type === "vehicle") return "Truck";
  if (z === "other") return "Other";
  if (type === "warehouse") return "Warehouse";
  return type || "Location";
}

function locationDisplayName(l: {
  type: string;
  name: string;
  unit_number?: string | null;
  zone?: string | null;
}): string {
  if (l.type === "vehicle") {
    return l.unit_number ? `Unit ${l.unit_number}` : l.name;
  }
  const z = zoneLabel(l.zone, l.type);
  // Avoid "Main floor · Warehouse" noise when name already is Warehouse
  if (!l.zone || l.name.toLowerCase() === z.toLowerCase()) return l.name;
  return `${l.name} · ${z}`;
}

interface PartVendor {
  id: number;
  part_id: number;
  vendor_name: string;
  vendor_part_number: string | null;
  cost: number | null;
  available: number;
  notes: string | null;
}

interface ReorderItem {
  id: number;
  code: string;
  name: string;
  category: string | null;
  cost: number | null;
  unit_of_measure: string | null;
  primary_vendor: string | null;
  min_qty: number | null;
  max_qty: number | null;
  total_qty: number;
  order_qty: number;
  est_cost: number | null;
}

interface MovementRow {
  id: number;
  part_id: number;
  qty: number;
  reason: string;
  notes: string | null;
  created_at: string;
  part_code: string;
  part_name: string;
  user_name: string | null;
  from_name: string | null;
  to_name: string | null;
}

export type PreviewStatus = "new" | "exists" | "dup_file";

export interface PreviewRow extends ImportRow {
  key: string;
  selected: boolean;
  status: PreviewStatus;
  /** Local photo matched from multi-file pick (for upload on submit) */
  localPhoto?: File | null;
  /** Object URL for thumb preview */
  localPreviewUrl?: string | null;
}

/** De-dupe file rows + mark against existing catalog codes. */
export function buildImportPreview(
  rows: ImportRow[],
  existingCodes: Set<string>,
  existingExternal: Set<string>
): PreviewRow[] {
  const seen = new Set<string>();
  const out: PreviewRow[] = [];
  let i = 0;
  for (const row of rows) {
    const codeKey = row.code.trim().toLowerCase();
    const ext =
      row.external_st_id != null && String(row.external_st_id).trim() !== ""
        ? String(row.external_st_id).trim()
        : "";
    let status: PreviewStatus = "new";
    if (seen.has(codeKey) || (ext && seen.has(`e:${ext}`))) {
      status = "dup_file";
    } else if (existingCodes.has(codeKey) || (ext && existingExternal.has(ext))) {
      status = "exists";
    }
    seen.add(codeKey);
    if (ext) seen.add(`e:${ext}`);
    out.push({
      ...row,
      key: `${codeKey}-${i++}`,
      status,
      selected: status === "new",
      localPhoto: null,
      localPreviewUrl: null,
    });
  }
  return out;
}

function imagePathBasename(path: string | null | undefined): string {
  if (!path) return "";
  const s = String(path).trim().split(/[\n\r]/)[0].trim();
  const base = s.split(/[/\\]/).pop() || "";
  return base.toLowerCase();
}

function isLow(p: { total_qty: number; min_qty?: number | null }): boolean {
  return p.min_qty != null && Number(p.total_qty) < Number(p.min_qty);
}

export function InventoryPage() {
  const { user } = useAuth();
  const canView = can(user, "viewInventory");
  const canManage = can(user, "manageInventory");
  const canLevels = can(user, "manageInventoryLevels");

  const [tab, setTab] = useState<Tab>("stock");
  const [summary, setSummary] = useState({
    parts: 0,
    locations: 0,
    lines_with_stock: 0,
    needs_order: 0,
    ready: true,
  });
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [parts, setParts] = useState<PartRow[]>([]);
  const [q, setQ] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  /** Ignore stale search responses when typing quickly */
  const searchSeq = useRef(0);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewReady, setPreviewReady] = useState(false);
  const [parseBusy, setParseBusy] = useState(false);
  const [columnMapping, setColumnMapping] = useState<ColumnMappingDisplay[]>([]);
  const [importSheetName, setImportSheetName] = useState("");
  const [vendorNamesFound, setVendorNamesFound] = useState<string[]>([]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedPart, setSelectedPart] = useState<PartRow | null>(null);
  const [balances, setBalances] = useState<PartBalance[]>([]);
  const [setLocId, setSetLocId] = useState("");
  const [setQty, setSetQty] = useState("");
  const [adjustDelta, setAdjustDelta] = useState("1");
  const [stockNotes, setStockNotes] = useState("");
  const [minQty, setMinQty] = useState("");
  const [maxQty, setMaxQty] = useState("");
  const [moveFromLocId, setMoveFromLocId] = useState("");
  const [moveToLocId, setMoveToLocId] = useState("");
  const [moveQty, setMoveQty] = useState("1");
  const [moveBusy, setMoveBusy] = useState(false);
  const [locLevelBusy, setLocLevelBusy] = useState(false);
  const [pushStBusy, setPushStBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [homeBusy, setHomeBusy] = useState(false);
  const [vendors, setVendors] = useState<PartVendor[]>([]);
  const [newVendorName, setNewVendorName] = useState("");
  const [newVendorCost, setNewVendorCost] = useState("");
  const [newVendorSku, setNewVendorSku] = useState("");
  const [newVendorAvail, setNewVendorAvail] = useState(true);
  const [vendorBusy, setVendorBusy] = useState(false);
  const [stockBusy, setStockBusy] = useState(false);
  const [levelsBusy, setLevelsBusy] = useState(false);
  const [truckStockBusy, setTruckStockBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [syncImagesBusy, setSyncImagesBusy] = useState(false);
  const [sectionName, setSectionName] = useState("");
  const [sectionZone, setSectionZone] = useState<"main" | "overhead" | "attic" | "other">("main");
  const [sectionBusy, setSectionBusy] = useState(false);
  const [listLoading, setListLoading] = useState(true);

  const [reorder, setReorder] = useState<ReorderItem[]>([]);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [vendorFilter, setVendorFilter] = useState("");
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [stageWh, setStageWh] = useState<
    Array<{
      part_id: number;
      code: string;
      name: string;
      location_id: number;
      location_name: string;
      qty: number;
      min_qty: number;
      order_qty: number;
    }>
  >([]);
  type StageTruckRow = {
    part_id: number;
    code: string;
    name: string;
    image_url?: string | null;
    location_id: number;
    location_name: string;
    unit_number: string | null;
    qty: number;
    min_qty: number;
    max_qty?: number | null;
    stage_qty: number;
  };
  const [stageTrucks, setStageTrucks] = useState<StageTruckRow[]>([]);
  const [stageBusy, setStageBusy] = useState(false);

  /** Group stage lines by unit for pull sheets (unit order already sorted). */
  const stageByUnit = useMemo(() => {
    const map = new Map<
      string,
      { key: string; label: string; unit_number: string | null; lines: StageTruckRow[] }
    >();
    for (const r of stageTrucks) {
      const key = String(r.location_id);
      const label = r.unit_number ? `Unit ${r.unit_number}` : r.location_name || `Loc ${r.location_id}`;
      let g = map.get(key);
      if (!g) {
        g = { key, label, unit_number: r.unit_number, lines: [] };
        map.set(key, g);
      }
      g.lines.push(r);
    }
    return [...map.values()];
  }, [stageTrucks]);

  function printTruckPullSheet(
    groups: Array<{ label: string; unit_number: string | null; lines: StageTruckRow[] }>,
    opts?: { title?: string }
  ) {
    const printedBy = user?.display_name || user?.username || "Warehouse";
    const when = new Date().toLocaleString();
    const origin = typeof window !== "undefined" ? window.location.origin : "";

    function absImg(raw?: string | null, partId?: number): string {
      const src = partImageSrc(raw);
      if (src) {
        if (/^https?:\/\//i.test(src) || src.startsWith("data:") || src.startsWith("blob:")) {
          return src;
        }
        return `${origin}${src.startsWith("/") ? src : `/${src}`}`;
      }
      if (partId) return `${origin}/api/inventory/parts/${partId}/image`;
      return "";
    }

    const sheets = groups
      .map((g) => {
        const rows = g.lines
          .map((r) => {
            const img = absImg(r.image_url, r.part_id);
            const hi =
              r.max_qty != null && Number.isFinite(Number(r.max_qty))
                ? String(r.max_qty)
                : "—";
            const photo = img
              ? `<img class="photo" src="${escapeHtml(img)}" alt="" />`
              : `<div class="photo ph-empty">${escapeHtml((r.code || r.name || "?").slice(0, 2).toUpperCase())}</div>`;
            return `
          <tr>
            <td class="photo-cell">${photo}</td>
            <td class="part-cell">
              <div class="pn">${escapeHtml(r.code || "—")}</div>
              <div class="pname">${escapeHtml(r.name || "")}</div>
            </td>
            <td class="num levels">${escapeHtml(String(r.min_qty))} / ${escapeHtml(hi)}</td>
            <td class="num curr">${escapeHtml(String(r.qty))}</td>
            <td class="count-box"><div class="write-in"></div></td>
          </tr>`;
          })
          .join("");
        return `
        <section class="sheet">
          <header>
            <div>
              <h1>Truck stock count sheet</h1>
              <p class="sub">${escapeHtml(g.label)}</p>
              <p class="hint">Write the physical count in the last column. Turn in for warehouse adjustments.</p>
            </div>
            <div class="meta">
              <div>${escapeHtml(when)}</div>
              <div>Prepared: ${escapeHtml(printedBy)}</div>
              <div>${g.lines.length} part${g.lines.length === 1 ? "" : "s"}</div>
            </div>
          </header>
          <table>
            <thead>
              <tr>
                <th class="photo-cell">Photo</th>
                <th>Part # / name</th>
                <th class="num">Low / hi</th>
                <th class="num">System qty</th>
                <th class="count-box">Count</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <footer>
            <div class="sign-row">
              <div>Counted by: ________________________</div>
              <div>Date: ______________</div>
            </div>
            <div class="sign-row">
              <div>Entered by (office / warehouse): ________________________</div>
              <div>Date: ______________</div>
            </div>
            <label class="confirm">☐ I confirm this count is accurate</label>
          </footer>
        </section>`;
      })
      .join("");

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(opts?.title || "Truck stock count sheet")}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, "Segoe UI", sans-serif; margin: 0.45in; color: #111; font-size: 11px; }
    .sheet { page-break-after: always; }
    .sheet:last-child { page-break-after: auto; }
    header { display: flex; justify-content: space-between; gap: 1rem; border-bottom: 2px solid #111; padding-bottom: 0.45rem; margin-bottom: 0.55rem; }
    h1 { margin: 0; font-size: 1.25rem; letter-spacing: -0.01em; }
    .sub { margin: 0.2rem 0 0; font-size: 1.1rem; font-weight: 800; }
    .hint { margin: 0.25rem 0 0; font-size: 0.8rem; color: #444; max-width: 22rem; }
    .meta { text-align: right; font-size: 0.8rem; color: #333; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #ccc; padding: 0.35rem 0.3rem; text-align: left; vertical-align: middle; }
    th { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; color: #444; background: #f4f4f5; }
    .photo-cell { width: 2.6rem; }
    .photo {
      width: 2.35rem; height: 2.35rem; object-fit: contain;
      border: 1px solid #ddd; border-radius: 6px; background: #fff; display: block;
    }
    .ph-empty {
      width: 2.35rem; height: 2.35rem; border-radius: 6px; border: 1px dashed #bbb;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.65rem; font-weight: 800; color: #888; background: #fafafa;
    }
    .part-cell { min-width: 0; }
    .pn { font-weight: 800; font-size: 0.95rem; font-family: ui-monospace, Consolas, monospace; letter-spacing: 0.02em; }
    .pname { color: #444; font-size: 0.78rem; margin-top: 0.1rem; line-height: 1.25; }
    .num { text-align: center; white-space: nowrap; width: 4.5rem; font-variant-numeric: tabular-nums; }
    .levels { font-weight: 600; color: #222; }
    .curr { font-weight: 700; }
    .count-box { width: 3.6rem; text-align: center; }
    .write-in {
      width: 2.6rem; height: 1.65rem; margin: 0 auto;
      border: 1.5px solid #111; border-radius: 4px; background: #fff;
    }
    footer { margin-top: 1rem; padding-top: 0.65rem; border-top: 1px solid #999; font-size: 0.88rem; }
    .sign-row { display: flex; flex-wrap: wrap; gap: 1.25rem 2rem; margin-bottom: 0.55rem; }
    .confirm { display: block; font-weight: 700; margin-top: 0.35rem; }
    @media print {
      body { margin: 0.4in; }
      .sheet { break-after: page; }
      .sheet:last-child { break-after: auto; }
      .photo, .ph-empty { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>${sheets}
<script>window.onload = function () { window.focus(); setTimeout(function(){ window.print(); }, 400); };</script>
</body>
</html>`;

    const w = window.open("", "_blank");
    if (!w) {
      setError("Allow pop-ups to print the pull sheet.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  function escapeHtml(s: string) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const loadSummary = useCallback(async () => {
    const s = await api<{
      parts: number;
      locations: number;
      lines_with_stock: number;
      needs_order?: number;
      ready?: boolean;
    }>("/inventory/summary");
    setSummary({
      parts: s.parts || 0,
      locations: s.locations || 0,
      lines_with_stock: s.lines_with_stock || 0,
      needs_order: s.needs_order || 0,
      ready: s.ready !== false,
    });
  }, []);

  const loadLocations = useCallback(async () => {
    const loc = await api<{ locations: StockLocation[] }>("/inventory/locations");
    setLocations(loc.locations || []);
    setSetLocId((prev) => {
      if (prev) return prev;
      const wh =
        loc.locations?.find((l) => l.type === "warehouse") || loc.locations?.[0];
      return wh ? String(wh.id) : "";
    });
  }, []);

  const loadSummaryAndLocations = useCallback(async () => {
    await Promise.all([loadSummary(), loadLocations()]);
  }, [loadSummary, loadLocations]);

  const searchParts = useCallback(async (query: string) => {
    const seq = ++searchSeq.current;
    setSearchBusy(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      // Typeahead: show more when searching so "pvc" surfaces the family
      params.set("limit", query.trim() ? "100" : "40");
      const d = await api<{ parts: PartRow[] }>(`/inventory/parts?${params}`);
      // Drop outdated responses (user already typed further)
      if (seq !== searchSeq.current) return;
      setParts(d.parts || []);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      if (seq === searchSeq.current) {
        setSearchBusy(false);
        setListLoading(false);
      }
    }
  }, []);

  // Live search as you type — list updates without pressing Go
  useEffect(() => {
    if (tab !== "stock" || selectedPart) return;
    const delay = q.trim().length === 0 ? 0 : q.trim().length <= 2 ? 60 : 100;
    const handle = window.setTimeout(() => {
      void searchParts(q);
    }, delay);
    return () => window.clearTimeout(handle);
  }, [q, tab, selectedPart, searchParts]);

  const loadReorder = useCallback(async (vendor = "") => {
    setReorderBusy(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (vendor.trim()) params.set("vendor", vendor.trim());
      const d = await api<{ items: ReorderItem[] }>(`/inventory/reorder?${params}`);
      setReorder(d.items || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load order list");
      setReorder([]);
    } finally {
      setReorderBusy(false);
    }
  }, []);

  const loadMovements = useCallback(async () => {
    try {
      const d = await api<{ movements: MovementRow[] }>("/inventory/movements?limit=50");
      setMovements(d.movements || []);
    } catch {
      setMovements([]);
    }
  }, []);

  const loadStageReport = useCallback(async () => {
    setStageBusy(true);
    setError("");
    try {
      const d = await api<{
        warehouse: typeof stageWh;
        trucks: typeof stageTrucks;
      }>("/inventory/low-stock-report");
      // Unit first so each truck’s staging needs read as a block (not by part #)
      const trucks = [...(d.trucks || [])].sort((a, b) => {
        const au = String(a.unit_number || a.location_name || "");
        const bu = String(b.unit_number || b.location_name || "");
        const byUnit = au.localeCompare(bu, undefined, { numeric: true, sensitivity: "base" });
        if (byUnit !== 0) return byUnit;
        return (a.name || a.code || "").localeCompare(b.name || b.code || "", undefined, {
          sensitivity: "base",
        });
      });
      setStageWh(d.warehouse || []);
      setStageTrucks(trucks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load staging report");
      setStageWh([]);
      setStageTrucks([]);
    } finally {
      setStageBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!canView) return;
    setListLoading(true);
    // Parallel: parts list must not wait on summary/locations
    void Promise.all([
      searchParts(""),
      loadSummary().catch(() => undefined),
      loadLocations().catch(() => undefined),
    ]).catch((e) =>
      setError(e instanceof Error ? e.message : "Could not load inventory")
    );
    // Background: promote any leftover ST-path photos to permanent storage (silent)
    if (canManage) {
      void api<{ promoted: number }>("/inventory/persist-images", {
        method: "POST",
        body: JSON.stringify({ limit: 80 }),
      })
        .then((r) => {
          if (r.promoted > 0) void searchParts(q);
        })
        .catch(() => {
          /* silent — list must keep working */
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, [canView, canManage]);

  useEffect(() => {
    if (!canView) return;
    if (tab === "order") void loadReorder(vendorFilter);
    if (tab === "stage") void loadStageReport();
    if (tab === "history") void loadMovements();
  }, [tab, canView, loadReorder, loadStageReport, loadMovements, vendorFilter]);

  async function openPart(p: PartRow) {
    setSelectedId(p.id);
    setSelectedPart(p);
    setError("");
    setOk("");
    try {
      const d = await api<{ part: PartRow; balances: PartBalance[]; vendors?: PartVendor[] }>(
        `/inventory/parts/${p.id}`
      );
      const bals = d.balances || [];
      const totalFromBal = bals.reduce((s, b) => s + (Number(b.qty) || 0), 0);
      const merged = {
        ...p,
        ...d.part,
        total_qty: totalFromBal,
      };
      setSelectedPart(merged);
      setBalances(bals);
      setVendors(d.vendors || []);
      setMinQty(merged.min_qty != null ? String(merged.min_qty) : "");
      setMaxQty(merged.max_qty != null ? String(merged.max_qty) : "");
      setNewVendorName("");
      setNewVendorCost("");
      setNewVendorSku("");
      setNewVendorAvail(true);
      const wh = locations.find((l) => l.type === "warehouse");
      const locId = setLocId
        ? Number(setLocId)
        : wh?.id || locations[0]?.id;
      if (locId) setSetLocId(String(locId));
      if (wh?.id) setMoveFromLocId(String(wh.id));
      const existing = bals.find((b) => b.location_id === locId);
      setSetQty(existing != null ? String(existing.qty) : "0");
      setTab("stock");
      // Scroll detail into view on mobile
      requestAnimationFrame(() => {
        document.getElementById("inv-part-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load part");
    }
  }

  function closePartDetail() {
    setSelectedId(null);
    setSelectedPart(null);
    setBalances([]);
    setVendors([]);
  }

  async function applyStock(mode: "set" | "in" | "out") {
    if (!selectedId || !setLocId) return;
    setStockBusy(true);
    setError("");
    setOk("");
    try {
      if (mode === "set") {
        await api("/inventory/stock/set", {
          method: "POST",
          body: JSON.stringify({
            part_id: selectedId,
            location_id: Number(setLocId),
            qty: Number(setQty),
            notes: stockNotes || undefined,
          }),
        });
        setOk("Count saved.");
      } else {
        const n = Math.abs(Number(adjustDelta) || 0);
        if (!n) throw new Error("Enter a quantity to add or remove");
        const delta = mode === "in" ? n : -n;
        await api("/inventory/stock/adjust", {
          method: "POST",
          body: JSON.stringify({
            part_id: selectedId,
            location_id: Number(setLocId),
            delta,
            reason: mode === "in" ? "receive" : "issue",
            notes: stockNotes || undefined,
          }),
        });
        setOk(mode === "in" ? `Received +${n}.` : `Issued −${n}.`);
      }
      setStockNotes("");
      const p = parts.find((x) => x.id === selectedId) || selectedPart;
      if (p) await openPart(p);
      await searchParts(q);
      await loadSummaryAndLocations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stock update failed");
    } finally {
      setStockBusy(false);
    }
  }

  /** Move stock between any two locations (warehouse ↔ truck, etc.) */
  async function moveStock() {
    if (!selectedId || !canManage) return;
    const wh = locations.find((l) => l.type === "warehouse");
    const fromId = Number(moveFromLocId) || wh?.id || Number(setLocId);
    const toId = Number(moveToLocId);
    const n = Math.abs(Number(moveQty) || 0);
    if (!fromId || !toId || !n) {
      setError("Pick From, To, and a quantity.");
      return;
    }
    if (fromId === toId) {
      setError("From and To must be different locations.");
      return;
    }
    setMoveBusy(true);
    setError("");
    setOk("");
    try {
      await api("/inventory/stock/transfer", {
        method: "POST",
        body: JSON.stringify({
          part_id: selectedId,
          from_location_id: fromId,
          to_location_id: toId,
          qty: n,
          notes: stockNotes || "Moved stock",
        }),
      });
      const fromName =
        locations.find((l) => l.id === fromId)?.name ||
        (locations.find((l) => l.id === fromId)?.unit_number
          ? `Unit ${locations.find((l) => l.id === fromId)!.unit_number}`
          : "source");
      const toLoc = locations.find((l) => l.id === toId);
      const toName = toLoc?.unit_number ? `Unit ${toLoc.unit_number}` : toLoc?.name || "destination";
      setOk(`Moved ${n}: ${fromName} → ${toName}.`);
      setMoveQty("1");
      setStockNotes("");
      const p = parts.find((x) => x.id === selectedId) || selectedPart;
      if (p) await openPart(p);
      await searchParts(q);
      await loadSummaryAndLocations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Move failed");
    } finally {
      setMoveBusy(false);
    }
  }

  async function saveLocLevels(locationId: number, min: string, max: string) {
    if (!selectedId || !canLevels) return;
    setLocLevelBusy(true);
    setError("");
    try {
      await api(`/inventory/parts/${selectedId}/location-levels`, {
        method: "PUT",
        body: JSON.stringify({
          location_id: locationId,
          min_qty: min === "" ? null : Number(min),
          max_qty: max === "" ? null : Number(max),
        }),
      });
      setOk("Truck / location levels saved.");
      const p = parts.find((x) => x.id === selectedId) || selectedPart;
      if (p) await openPart(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save location levels");
    } finally {
      setLocLevelBusy(false);
    }
  }

  async function pushPartToSt() {
    if (!selectedId || !canManage) return;
    setPushStBusy(true);
    setError("");
    setOk("");
    try {
      const r = await api<{ ok: boolean; detail?: string; st_id?: string | number }>(
        `/inventory/parts/${selectedId}/push-st`,
        { method: "POST", body: "{}" }
      );
      setOk(r.detail || `Pushed to ServiceTitan${r.st_id ? ` (${r.st_id})` : ""}`);
      const p = parts.find((x) => x.id === selectedId) || selectedPart;
      if (p) await openPart(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ST push failed");
    } finally {
      setPushStBusy(false);
    }
  }

  async function deletePart() {
    if (!selectedId || !selectedPart || !canManage) return;
    const stNote = selectedPart.external_st_id
      ? "\n\nThis will also deactivate the material in the ServiceTitan pricebook (ST does not hard-delete items)."
      : "\n\nNo ServiceTitan id on this part — removes from this app only.";
    if (
      !confirm(
        `Delete “${selectedPart.name}” (${selectedPart.code}) from inventory?${stNote}\n\nIt will no longer appear in the catalog.`
      )
    ) {
      return;
    }
    setDeleteBusy(true);
    setError("");
    setOk("");
    try {
      const r = await api<{ ok: boolean; message?: string; st?: { ok: boolean; detail: string } }>(
        `/inventory/parts/${selectedId}?st=1`,
        { method: "DELETE" }
      );
      setOk(r.message || "Part removed.");
      if (r.st && r.st.ok === false) {
        setError(`ServiceTitan: ${r.st.detail}`);
      }
      closePartDetail();
      await searchParts(q);
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function saveHomeLocation(locationId: string) {
    if (!selectedId || !canManage) return;
    setHomeBusy(true);
    setError("");
    setOk("");
    try {
      const home_location_id = locationId === "" ? null : Number(locationId);
      await api(`/inventory/parts/${selectedId}`, {
        method: "PATCH",
        body: JSON.stringify({ home_location_id }),
      });
      setOk(
        home_location_id
          ? "Home bin saved — techs see this first; other warehouse stock is overstock."
          : "Home bin cleared."
      );
      const p = parts.find((x) => x.id === selectedId) || selectedPart;
      if (p) await openPart(p);
      await searchParts(q);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save home location");
    } finally {
      setHomeBusy(false);
    }
  }

  async function createSection(e: FormEvent) {
    e.preventDefault();
    if (!canManage || !sectionName.trim()) return;
    setSectionBusy(true);
    setError("");
    setOk("");
    try {
      await api("/inventory/locations", {
        method: "POST",
        body: JSON.stringify({
          name: sectionName.trim(),
          zone: sectionZone,
          type: sectionZone === "attic" ? "attic" : "warehouse",
        }),
      });
      setOk(`Section “${sectionName.trim()}” added.`);
      setSectionName("");
      await loadLocations();
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add section");
    } finally {
      setSectionBusy(false);
    }
  }

  async function removeSection(loc: StockLocation) {
    if (!canManage) return;
    if (
      !confirm(
        `Remove section “${loc.name}”? Stock history stays; counts on this section remain but the section is hidden. Parts using it as home will clear home.`
      )
    ) {
      return;
    }
    setSectionBusy(true);
    setError("");
    try {
      await api(`/inventory/locations/${loc.id}`, { method: "DELETE" });
      setOk(`Section “${loc.name}” removed.`);
      await loadLocations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove section");
    } finally {
      setSectionBusy(false);
    }
  }

  async function onSaveLevels(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setLevelsBusy(true);
    setError("");
    setOk("");
    try {
      const min = minQty.trim() === "" ? null : Number(minQty);
      const max = maxQty.trim() === "" ? null : Number(maxQty);
      if (min != null && Number.isNaN(min)) throw new Error("Low must be a number");
      if (max != null && Number.isNaN(max)) throw new Error("High must be a number");
      if (min != null && max != null && max < min) {
        throw new Error("High should be greater than or equal to Low");
      }
      const res = await api<{ part: PartRow }>(`/inventory/parts/${selectedId}`, {
        method: "PATCH",
        body: JSON.stringify({
          min_qty: min,
          max_qty: max,
        }),
      });
      setOk("Low / high levels saved. Parts below low show on Need to order.");
      if (selectedPart) {
        setSelectedPart({
          ...selectedPart,
          ...res.part,
          total_qty: selectedPart.total_qty,
        });
      }
      await searchParts(q);
      await loadSummaryAndLocations();
      if (tab === "order") await loadReorder(vendorFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save levels");
    } finally {
      setLevelsBusy(false);
    }
  }

  /** Upload a product photo into the thumbnail box (stored on server). */
  async function onUploadPartPhoto(file: File) {
    if (!selectedId || !selectedPart) return;
    setPhotoBusy(true);
    setError("");
    setOk("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api<{ ok: boolean; image_url: string; part: PartRow }>(
        `/inventory/parts/${selectedId}/image`,
        { method: "POST", body: fd }
      );
      setSelectedPart({
        ...selectedPart,
        ...res.part,
        image_url: res.image_url,
        total_qty: selectedPart.total_qty,
      });
      setOk("Photo saved — it will show next to this part in the list.");
      await searchParts(q);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo upload failed");
    } finally {
      setPhotoBusy(false);
    }
  }

  /**
   * Pull product photos from ServiceTitan for all parts that still need them.
   * Runs automatically in batches until done (one button press).
   */
  async function onSyncImagesFromSt() {
    if (!canManage) return;
    setSyncImagesBusy(true);
    setError("");
    setOk("Starting photo sync…");
    const batchSize = 15;
    const maxBatches = 80; // safety: up to ~1200 parts
    let totalSaved = 0;
    let totalFailed = 0;
    let totalAttempted = 0;
    let batches = 0;
    let emptyRuns = 0;
    let lastError = "";

    try {
      while (batches < maxBatches) {
        batches++;
        setOk(
          `Syncing photos… batch ${batches}` +
            (totalSaved || totalFailed
              ? ` · ${totalSaved} saved, ${totalFailed} skipped so far`
              : "")
        );
        let res: {
          ok: boolean;
          attempted: number;
          saved: number;
          failed: number;
          details?: string[];
        };
        try {
          res = await api("/inventory/sync-images", {
            method: "POST",
            body: JSON.stringify({ limit: batchSize, only_missing: true }),
          });
        } catch (err) {
          lastError = err instanceof Error ? err.message : "batch failed";
          // brief pause and retry once on network blip
          await new Promise((r) => setTimeout(r, 1200));
          try {
            res = await api("/inventory/sync-images", {
              method: "POST",
              body: JSON.stringify({ limit: batchSize, only_missing: true }),
            });
          } catch (err2) {
            lastError = err2 instanceof Error ? err2.message : lastError;
            break;
          }
        }

        totalSaved += res.saved || 0;
        totalFailed += res.failed || 0;
        totalAttempted += res.attempted || 0;

        // Nothing left to try
        if (!res.attempted) {
          emptyRuns++;
          break;
        }
        // Partial batch = last page
        if (res.attempted < batchSize) break;
        // All failed this batch twice in a row with no progress — stop
        if ((res.saved || 0) === 0) {
          emptyRuns++;
          if (emptyRuns >= 2) {
            lastError =
              res.details?.[0]?.replace(/^[^:]+:\s*/, "") ||
              "no photos saved in last batches";
            break;
          }
        } else {
          emptyRuns = 0;
        }

        // small gap between batches so Worker/ST aren't hammered
        await new Promise((r) => setTimeout(r, 400));
      }

      // Auto-promote any leftover ST cache paths into permanent /api/uploads URLs
      try {
        await api<{ promoted: number }>("/inventory/persist-images", {
          method: "POST",
          body: JSON.stringify({ limit: 200 }),
        });
      } catch {
        /* already saved on sync; promote is best-effort */
      }
      setOk(
        `Photo sync finished: ${totalSaved} saved permanently` +
          (totalFailed ? `, ${totalFailed} skipped` : "") +
          (batches >= maxBatches ? " (batch limit — tap Sync again if more remain)" : "") +
          (lastError && totalSaved === 0 ? `. Note: ${lastError.slice(0, 100)}` : "") +
          "."
      );

      if (totalSaved === 0 && totalAttempted === 0 && lastError) {
        setError(lastError);
        setOk("");
      } else if (totalSaved === 0 && totalFailed > 0) {
        setError(
          `No photos saved (${totalFailed} tried). ${lastError || "Check ST API / Pricebook Images scope."}`.slice(
            0,
            200
          )
        );
      }

      await searchParts(q);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "ST photo sync failed — configure Admin → ServiceTitan API first."
      );
    } finally {
      setSyncImagesBusy(false);
    }
  }

  /** Sync one part photo from ServiceTitan (uses external_st_id). */
  async function onSyncOnePartImage() {
    if (!selectedId || !selectedPart || !canManage) return;
    setPhotoBusy(true);
    setError("");
    setOk("");
    try {
      const res = await api<{
        ok: boolean;
        image_url?: string;
        detail: string;
        part?: PartRow;
      }>(`/inventory/parts/${selectedId}/sync-image`, {
        method: "POST",
        body: "{}",
      });
      if (res.part) {
        setSelectedPart({
          ...selectedPart,
          ...res.part,
          total_qty: selectedPart.total_qty,
        });
      }
      if (res.ok) {
        setOk(res.detail || "Photo pulled from ServiceTitan.");
        await searchParts(q);
      } else {
        setError(res.detail || "Could not get photo from ServiceTitan.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "ST photo sync failed");
    } finally {
      setPhotoBusy(false);
    }
  }

  /** Mark part as truck stock: add to all trucks (or remove from all trucks). */
  async function onToggleTruckStock(enabled: boolean) {
    if (!selectedId || !selectedPart) return;
    if (
      !enabled &&
      !confirm(
        `Remove “${selectedPart.name}” from all truck stock lists? Warehouse and attic counts stay. Truck counts for this part will be cleared.`
      )
    ) {
      return;
    }
    setTruckStockBusy(true);
    setError("");
    setOk("");
    try {
      const res = await api<{ part: PartRow }>(`/inventory/parts/${selectedId}`, {
        method: "PATCH",
        body: JSON.stringify({ truck_stock: enabled }),
      });
      setOk(
        enabled
          ? "Truck stock ON — this part is on every truck list (start at 0; set counts per unit)."
          : "Truck stock OFF — removed from all trucks. Warehouse/attic unchanged."
      );
      // Reload detail so location list updates
      const base = { ...selectedPart, ...res.part };
      await openPart(base);
      await searchParts(q);
      await loadSummaryAndLocations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update truck stock");
    } finally {
      setTruckStockBusy(false);
    }
  }

  async function reloadSelectedPart() {
    if (!selectedId) return;
    const base = parts.find((x) => x.id === selectedId) || selectedPart;
    if (base) await openPart(base);
  }

  async function onAddVendor(e: FormEvent) {
    e.preventDefault();
    if (!selectedId || !newVendorName.trim()) return;
    setVendorBusy(true);
    setError("");
    setOk("");
    try {
      const cost = newVendorCost.trim() === "" ? null : Number(newVendorCost);
      if (cost != null && Number.isNaN(cost)) throw new Error("Cost must be a number");
      await api(`/inventory/parts/${selectedId}/vendors`, {
        method: "POST",
        body: JSON.stringify({
          vendor_name: newVendorName.trim(),
          cost,
          vendor_part_number: newVendorSku.trim() || null,
          available: newVendorAvail,
        }),
      });
      setOk("Vendor saved. Default is the cheapest available quote.");
      setNewVendorName("");
      setNewVendorCost("");
      setNewVendorSku("");
      setNewVendorAvail(true);
      await reloadSelectedPart();
      await searchParts(q);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save vendor");
    } finally {
      setVendorBusy(false);
    }
  }

  async function toggleVendorAvailable(v: PartVendor) {
    if (!selectedId) return;
    setVendorBusy(true);
    setError("");
    try {
      await api(`/inventory/parts/${selectedId}/vendors/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify({ available: !v.available }),
      });
      setOk(
        !v.available
          ? `${v.vendor_name} marked available — default may switch if cheaper.`
          : `${v.vendor_name} marked unavailable — default picks next cheapest available.`
      );
      await reloadSelectedPart();
      await searchParts(q);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setVendorBusy(false);
    }
  }

  async function saveVendorCost(v: PartVendor, costStr: string) {
    if (!selectedId) return;
    setVendorBusy(true);
    setError("");
    try {
      const cost = costStr.trim() === "" ? null : Number(costStr);
      if (cost != null && Number.isNaN(cost)) throw new Error("Cost must be a number");
      await api(`/inventory/parts/${selectedId}/vendors/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify({ cost }),
      });
      setOk("Cost updated — default vendor recalculated.");
      await reloadSelectedPart();
      await searchParts(q);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setVendorBusy(false);
    }
  }

  async function removeVendor(v: PartVendor) {
    if (!selectedId) return;
    if (!confirm(`Remove ${v.vendor_name} from this part?`)) return;
    setVendorBusy(true);
    setError("");
    try {
      await api(`/inventory/parts/${selectedId}/vendors/${v.id}`, { method: "DELETE" });
      setOk("Vendor removed.");
      await reloadSelectedPart();
      await searchParts(q);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setVendorBusy(false);
    }
  }

  function clearImportPreview() {
    setImportFile(null);
    setImportFileName("");
    setPreviewRows([]);
    setPreviewReady(false);
    setColumnMapping([]);
    setImportSheetName("");
    setVendorNamesFound([]);
  }

  /** Step 1: choose file (does not import yet). */
  function onPickImportFile(file: File) {
    setError("");
    setOk("");
    setImportFile(file);
    setImportFileName(file.name);
    setPreviewRows([]);
    setPreviewReady(false);
    setColumnMapping([]);
    setImportSheetName("");
    setVendorNamesFound([]);
  }

  /**
   * Step 2: parse ServiceTitan pricebook.
   * Uses the Materials sheet (not the first sheet Categories).
   */
  async function onBuildPreview() {
    if (!importFile) {
      setError("Choose your ServiceTitan Pricebook .xlsx first.");
      return;
    }
    setParseBusy(true);
    setError("");
    setOk("");
    try {
      const buf = await importFile.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      if (!wb.SheetNames.length) throw new Error("Empty workbook — no sheets found.");

      const materialsName = resolveMaterialsSheetName(wb.SheetNames);
      if (!materialsName) {
        throw new Error(
          `No Materials sheet found. This file has: ${wb.SheetNames.join(", ")}. Export a full ServiceTitan Pricebook.`
        );
      }

      const sheet = wb.Sheets[materialsName];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      if (!raw.length) {
        throw new Error(`Sheet “${materialsName}” has no data rows.`);
      }

      let parsed = parseStPricebookFromSheetJson(materialsName, raw, wb.SheetNames, {
        inventoryOnly: true,
      });
      let note = "";
      if (!parsed.rows.length) {
        parsed = parseStPricebookFromSheetJson(materialsName, raw, wb.SheetNames, {
          inventoryOnly: false,
        });
        note =
          " No IsInventory=1 rows — showing all Materials rows so you can choose.";
      }
      if (!parsed.rows.length) {
        throw new Error(
          `Could not map Code/Name on sheet “${materialsName}”. Expected ServiceTitan Materials columns.`
        );
      }

      setImportSheetName(parsed.sheetName);
      setColumnMapping(parsed.mapping);
      setVendorNamesFound(parsed.vendorNames);

      const existing = await api<{ codes: string[]; external_ids: string[] }>(
        "/inventory/parts/codes"
      );
      const codeSet = new Set((existing.codes || []).map((c) => c.toLowerCase()));
      const extSet = new Set(existing.external_ids || []);
      // Alphabetical by name so duplicates are easy to spot
      const sorted = [...parsed.rows].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
      const preview = buildImportPreview(sorted, codeSet, extSet);
      setPreviewRows(preview);
      setPreviewReady(true);
      const nNew = preview.filter((r) => r.status === "new").length;
      const nEx = preview.filter((r) => r.status === "exists").length;
      const nDup = preview.filter((r) => r.status === "dup_file").length;
      const nPhoto = preview.filter((r) => r.image_url).length;
      setOk(
        `Loaded ${preview.length} parts A–Z · ${nNew} new (checked) · ${nPhoto} have a photo path in ST.` +
          ` Excel does not include the actual image files — use “Match photos” (select image files) or open a part and tap Photo.${note}`
      );
      setTab("catalog");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read file");
      setPreviewReady(false);
      setPreviewRows([]);
      setColumnMapping([]);
    } finally {
      setParseBusy(false);
    }
  }

  /**
   * Download catalog for ServiceTitan re-import.
   * Includes every vendor quote + part # added in-app as ST [Vendor] columns.
   */
  async function onExportCatalog() {
    setError("");
    setOk("");
    try {
      const full = await api<{
        parts: Array<
          PartRow & {
            external_st_id?: string | number | null;
            price?: number | null;
            active?: number;
            description_text?: string | null;
            vendors?: Array<{
              vendor_name: string;
              vendor_part_number?: string | null;
              cost?: number | null;
              available?: number | boolean;
              is_primary?: boolean;
              notes?: string | null;
            }>;
          }
        >;
        vendor_names?: string[];
        count?: number;
      }>("/inventory/export");
      const all = full.parts || [];
      if (!all.length) {
        setError("No parts in catalog to export yet.");
        return;
      }
      const rows = partsToStMaterialsExportRows(
        all.map((p) => ({
          external_st_id: p.external_st_id,
          code: p.code,
          name: p.name,
          description_text: p.description_text,
          category: p.category,
          cost: p.cost,
          price: p.price ?? null,
          unit_of_measure: p.unit_of_measure,
          is_inventory: p.is_inventory,
          primary_vendor: p.primary_vendor,
          active: p.active ?? 1,
          vendors: (p.vendors || []).map((v) => ({
            vendor_name: v.vendor_name,
            vendor_part_number: v.vendor_part_number,
            cost: v.cost,
            available: v.available,
            is_primary: v.is_primary,
            notes: v.notes,
          })),
        }))
      );
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Materials");
      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `Fleet_Materials_Export_${stamp}.xlsx`);
      const vCount = full.vendor_names?.length || 0;
      const vLabel = vCount === 1 ? '1 vendor group' : vCount + ' vendor groups';
      setOk(
        'Exported ' +
          rows.length +
          ' parts with ' +
          vLabel +
          '. ST vendor columns included (Active, Part #, Price, Primary). Import Materials into ServiceTitan to push new vendors and part numbers.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    }
  }

  function setPreviewSelected(key: string, selected: boolean) {
    setPreviewRows((rows) => rows.map((r) => (r.key === key ? { ...r, selected } : r)));
  }

  function selectAllNew() {
    setPreviewRows((rows) => rows.map((r) => ({ ...r, selected: r.status === "new" })));
  }

  function clearAllChecks() {
    setPreviewRows((rows) => rows.map((r) => ({ ...r, selected: false })));
  }

  /** Match local image files to ST Image1 basenames (e.g. guid.png). */
  function onMatchPhotos(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    const byName = new Map<string, File>();
    for (const f of list) {
      byName.set(f.name.toLowerCase(), f);
    }
    let matched = 0;
    setPreviewRows((rows) =>
      rows.map((r) => {
        const base = imagePathBasename(r.image_url);
        if (!base) return r;
        const file = byName.get(base);
        if (!file) return r;
        matched++;
        if (r.localPreviewUrl) {
          try {
            URL.revokeObjectURL(r.localPreviewUrl);
          } catch {
            /* ok */
          }
        }
        return {
          ...r,
          localPhoto: file,
          localPreviewUrl: URL.createObjectURL(file),
        };
      })
    );
    setOk(
      matched
        ? `Matched ${matched} photo(s) to parts. Submit to save them into the catalog thumbs.`
        : "No filenames matched ST photo paths. File names must match the end of the Image1 path (e.g. 36c99c83-….png)."
    );
  }

  /** Step 3: import only checked rows (insert_only — no duplicates), then upload matched photos.
   *  Small batches + resume: already-in-DB codes are skipped server-side so re-Submit is safe.
   */
  async function onSubmitApproved() {
    const approved = previewRows.filter((r) => r.selected && r.status !== "dup_file");
    if (!approved.length) {
      setError("Check at least one item to add (or clear the list).");
      return;
    }
    setImportBusy(true);
    setError("");
    setOk("");
    try {
      let inserted = 0;
      let skipped = 0;
      let duplicates = 0;
      let totalParts = 0;
      let photosUploaded = 0;
      let failedBatches = 0;
      // Small batches avoid Worker/D1 timeout (was 200 → Internal Server Error mid-run)
      const batchSize = 35;
      const codeToPhoto = new Map<string, File>();
      for (const r of approved) {
        if (r.localPhoto) codeToPhoto.set(r.code.trim().toLowerCase(), r.localPhoto);
      }

      // Slim payload: drop huge descriptions that blow body size / CPU
      const payload = approved.map(
        ({
          key: _k,
          selected: _s,
          status: _st,
          localPhoto: _lp,
          localPreviewUrl: _lpu,
          description_text,
          ...part
        }) => ({
          ...part,
          description_text:
            description_text && String(description_text).length > 1500
              ? String(description_text).slice(0, 1500)
              : description_text,
        })
      );

      type ImportRes = {
        inserted: number;
        updated: number;
        skipped: number;
        duplicates?: number;
        errors?: number;
        total_parts: number;
        results?: Array<{ code: string; id: number | null; status: string }>;
        error?: string;
      };

      const allResults: Array<{ code: string; id: number | null }> = [];
      const totalBatches = Math.ceil(payload.length / batchSize) || 1;

      for (let i = 0; i < payload.length; i += batchSize) {
        const batchNum = Math.floor(i / batchSize) + 1;
        setOk(
          `Importing batch ${batchNum} of ${totalBatches}… (+${inserted} new so far, ${totalParts || "…"} in catalog)`
        );
        const batch = payload.slice(i, i + batchSize);
        let attempt = 0;
        let batchOk = false;
        while (attempt < 3 && !batchOk) {
          attempt++;
          try {
            const res = await api<ImportRes>("/inventory/parts/import", {
              method: "POST",
              body: JSON.stringify({ parts: batch, mode: "insert_only" }),
            });
            inserted += res.inserted || 0;
            skipped += res.skipped || 0;
            duplicates += res.duplicates || 0;
            totalParts = res.total_parts || totalParts;
            for (const r of res.results || []) {
              if (r.id) allResults.push({ code: r.code, id: r.id });
            }
            batchOk = true;
          } catch (err) {
            if (attempt >= 3) {
              failedBatches++;
              setError(
                `Batch ${batchNum}/${totalBatches} failed after retries: ${
                  err instanceof Error ? err.message : "error"
                }. Already-saved parts stay — tap Submit again to continue.`
              );
            } else {
              // brief pause then retry
              await new Promise((r) => setTimeout(r, 800 * attempt));
            }
          }
        }
      }

      // Upload any matched local photos onto created/found parts
      for (const r of allResults) {
        const file = codeToPhoto.get(r.code.trim().toLowerCase());
        if (!file || !r.id) continue;
        try {
          const fd = new FormData();
          fd.append("file", file);
          await api(`/inventory/parts/${r.id}/image`, { method: "POST", body: fd });
          photosUploaded++;
        } catch {
          /* continue — counts still work without photo */
        }
      }

      // Refresh catalog count
      try {
        await loadSummaryAndLocations();
      } catch {
        /* ignore */
      }

      if (failedBatches === 0) {
        setOk(
          `Catalog ready: +${inserted} parts` +
            (skipped || duplicates ? `, ${skipped || duplicates} already had / skipped` : "") +
            (photosUploaded ? `, ${photosUploaded} photos saved` : "") +
            `. ${totalParts} total in catalog — go to Find parts to start counts.`
        );
        clearImportPreview();
        await searchParts("");
        setTab("stock");
      } else {
        setOk(
          `Partial import: +${inserted} this run` +
            (skipped ? `, ${skipped} skipped (already in catalog)` : "") +
            `. ${totalParts} total in catalog. ${failedBatches} batch(es) failed — keep the list and tap Submit again (already-added parts are skipped).`
        );
        // Mark successfully imported rows as exists so re-submit is clearer
        setPreviewRows((prev) =>
          prev.map((row) => {
            const hit = allResults.find(
              (r) => r.code.trim().toLowerCase() === row.code.trim().toLowerCase()
            );
            if (hit?.id) {
              return { ...row, status: "exists" as PreviewStatus, selected: false };
            }
            return row;
          })
        );
      }
    } catch (err) {
      setError(
        (err instanceof Error ? err.message : "Import failed") +
          " Parts already saved stay in the catalog — Submit again to continue."
      );
    } finally {
      setImportBusy(false);
    }
  }

  const previewCounts = useMemo(() => {
    const selected = previewRows.filter((r) => r.selected).length;
    const neu = previewRows.filter((r) => r.status === "new").length;
    const exists = previewRows.filter((r) => r.status === "exists").length;
    const dups = previewRows.filter((r) => r.status === "dup_file").length;
    return { selected, neu, exists, dups, total: previewRows.length };
  }, [previewRows]);

  const locationOptions = useMemo(() => {
    return locations.map((l) => ({
      id: l.id,
      label: locationDisplayName(l),
      type: l.type,
      zone: l.zone,
    }));
  }, [locations]);

  const warehouseSections = useMemo(
    () => locations.filter((l) => l.type === "warehouse" || l.type === "attic"),
    [locations]
  );

  const reorderByVendor = useMemo(() => {
    const map = new Map<string, ReorderItem[]>();
    for (const item of reorder) {
      const v = item.primary_vendor?.trim() || "No vendor listed";
      if (!map.has(v)) map.set(v, []);
      map.get(v)!.push(item);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [reorder]);

  const orderEstTotal = useMemo(
    () => reorder.reduce((s, r) => s + (r.est_cost || 0), 0),
    [reorder]
  );

  if (!canView) {
    return (
      <div className="error">
        Inventory is for admin and warehouse. Ask an admin for a warehouse login.
      </div>
    );
  }

  return (
    <div className="inv-page inv-compact home-clean">
      <header className="home-hero no-print inv-page-header">
        <div>
          <p className="home-kicker">Warehouse · trucks</p>
          <h1 className="home-title">Inventory</h1>
          <p className="home-sub">
            {summary.parts} parts · {summary.lines_with_stock} in stock
            {summary.needs_order ? ` · ${summary.needs_order} to order` : ""}
          </p>
        </div>
      </header>

      <div className="print-only order-print-header">
        <h1>Parts order request</h1>
        <p>
          Total Assurance A/C &amp; Heating · {new Date().toLocaleDateString()} · Prepared by{" "}
          {user?.display_name || "—"}
        </p>
      </div>

      {ok && <div className="success no-print inv-flash">{ok}</div>}
      {error && <div className="error no-print inv-flash">{error}</div>}

      {!summary.ready && (
        <div className="error no-print inv-flash">
          Inventory tables are not on the server yet. Run migration 015 first.
        </div>
      )}

      {/* Same size/layout as Home quick actions */}
      <div className="home-actions no-print inv-nav-actions" role="tablist">
        <button
          type="button"
          role="tab"
          className={`home-action${tab === "stock" ? " primary" : ""}`}
          aria-selected={tab === "stock"}
          onClick={() => {
            setTab("stock");
          }}
        >
          <span className="home-action-icon" aria-hidden>
            🔎
          </span>
          <span className="home-action-text">
            <strong>Find parts</strong>
            <span>{summary.parts} in catalog</span>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          className={`home-action${tab === "pickup" ? " primary" : ""}`}
          aria-selected={tab === "pickup"}
          onClick={() => {
            setTab("pickup");
            closePartDetail();
          }}
        >
          <span className="home-action-icon" aria-hidden>
            📦
          </span>
          <span className="home-action-text">
            <strong>Pickup / custody</strong>
            <span>Scan · approve · notify</span>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          className={`home-action${tab === "vendor" ? " primary" : ""}`}
          aria-selected={tab === "vendor"}
          onClick={() => {
            setTab("vendor");
            closePartDetail();
          }}
        >
          <span className="home-action-icon" aria-hidden>
            🏪
          </span>
          <span className="home-action-text">
            <strong>Part pickup</strong>
            <span>Parts ready at supply house</span>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          className={`home-action${tab === "order" ? " primary" : ""}${
            summary.needs_order ? " status-tile tone-warn" : ""
          }`}
          aria-selected={tab === "order"}
          onClick={() => {
            setTab("order");
            closePartDetail();
          }}
        >
          <span className="home-action-icon status-tile-icon" aria-hidden>
            {summary.needs_order}
          </span>
          <span className="home-action-text">
            <strong>Need to order</strong>
            <span>Below min stock</span>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          className={`home-action${tab === "stage" ? " primary" : ""}${
            stageTrucks.length ? " status-tile tone-warn" : ""
          }`}
          aria-selected={tab === "stage"}
          onClick={() => {
            setTab("stage");
            closePartDetail();
          }}
        >
          <span className="home-action-icon status-tile-icon" aria-hidden>
            {stageTrucks.length || "📦"}
          </span>
          <span className="home-action-text">
            <strong>Stage for trucks</strong>
            <span>Print pickup list</span>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          className={`home-action${tab === "history" ? " primary" : ""}`}
          aria-selected={tab === "history"}
          onClick={() => {
            setTab("history");
            closePartDetail();
          }}
        >
          <span className="home-action-icon" aria-hidden>
            📋
          </span>
          <span className="home-action-text">
            <strong>History</strong>
            <span>Counts & moves</span>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          className={`home-action${tab === "catalog" ? " primary" : ""}`}
          aria-selected={tab === "catalog"}
          onClick={() => {
            setTab("catalog");
            closePartDetail();
          }}
        >
          <span className="home-action-icon" aria-hidden>
            ⇅
          </span>
          <span className="home-action-text">
            <strong>Import / export</strong>
            <span>ServiceTitan · photos</span>
          </span>
        </button>
        {canManage ? (
          <button
            type="button"
            role="tab"
            className={`home-action${tab === "sections" ? " primary" : ""}`}
            aria-selected={tab === "sections"}
            onClick={() => {
              setTab("sections");
              closePartDetail();
            }}
          >
            <span className="home-action-icon" aria-hidden>
              🗂
            </span>
            <span className="home-action-text">
              <strong>Warehouse map</strong>
              <span>Shelves · attic · overhead</span>
            </span>
          </button>
        ) : null}
      </div>

      {tab === "stock" && (
        <>
          {/* Home Depot style: list OR detail, not both cramped */}
          {!selectedPart ? (
            <div className="card no-print inv-browse-card">
              <div className="inv-search-bar">
                {canManage ? (
                  <BarcodeScanButton
                    label="Scan to receive"
                    disabled={searchBusy}
                    onCode={(code) => {
                      void (async () => {
                        setError("");
                        setOk("");
                        try {
                          const res = await api<{ parts: PartRow[] }>(
                            `/inventory/parts/lookup?code=${encodeURIComponent(code)}`
                          );
                          const hit = (res.parts || [])[0];
                          if (!hit) {
                            setError(`No part found for “${code}”. Type the code or add it to catalog.`);
                            setQ(code);
                            return;
                          }
                          setQ(hit.code || code);
                          await openPart(hit);
                          setAdjustDelta("1");
                          setOk(
                            `Scanned ${hit.code || hit.name} — set qty below and tap + Receive.`
                          );
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Lookup failed");
                          setQ(code);
                        }
                      })();
                    }}
                  />
                ) : null}
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Start typing part name or #…"
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                  aria-label="Search parts — results appear as you type"
                  aria-describedby="inv-search-hint"
                />
                {searchBusy ? (
                  <span className="inv-search-live muted" aria-live="polite">
                    Finding…
                  </span>
                ) : null}
                {q.trim() ? (
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => setQ("")}
                    aria-label="Clear search"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              <p id="inv-search-hint" className="muted inv-search-hint">
                Just type — matches appear automatically. Words can be in any order (e.g.{" "}
                <button
                  type="button"
                  className="inv-search-example"
                  onClick={() => setQ("pvc 90")}
                >
                  pvc 90
                </button>
                ).
              </p>

              <ul className="inv-browse-list">
                {parts.map((p) => {
                  const qty = Number(p.total_qty || 0);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={`inv-browse-row${isLow(p) ? " is-low" : ""}`}
                        onClick={() => void openPart(p)}
                      >
                        <PartThumb src={p.image_url} name={p.name} size={42} />
                        <div className="inv-browse-main">
                          <div className="inv-browse-name">{p.name}</div>
                          <div className="inv-browse-meta-line">
                            <span className="inv-browse-code">{p.code}</span>
                            <span className="inv-meta-dot">·</span>
                            <span>{p.primary_vendor || "No vendor"}</span>
                            <span className="inv-meta-dot">·</span>
                            <span className="inv-browse-cost">
                              {p.cost != null ? `$${Number(p.cost).toFixed(2)}` : "—"}
                            </span>
                            {isLow(p) ? <span className="inv-low-tag">Low</span> : null}
                          </div>
                          {p.home_location_name ? (
                            <div className="inv-browse-home muted">
                              Home: {p.home_location_name}
                              {p.home_zone ? ` · ${zoneLabel(p.home_zone, p.home_type || undefined)}` : ""}
                            </div>
                          ) : null}
                        </div>
                        <div className="inv-browse-qty">
                          <span className="inv-browse-qty-num">{qty}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {!parts.length && (
                <div className="empty">
                  {listLoading || searchBusy
                    ? "Loading parts…"
                    : summary.parts === 0
                      ? "No parts yet — use Import / export to load your ServiceTitan pricebook."
                      : q.trim()
                        ? `No matches for “${q.trim()}”. Try fewer words (e.g. just “pvc”) or a vendor name.`
                        : "No matches. Try another name or vendor."}
                </div>
              )}
              {q.trim() ? (
                <p className="muted inv-search-count" aria-live="polite">
                  {searchBusy
                    ? "Updating matches…"
                    : parts.length
                      ? `${parts.length}${parts.length >= 100 ? "+" : ""} match${parts.length === 1 ? "" : "es"}`
                      : "No matches yet — keep typing or try fewer words"}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="card no-print inv-detail-card" id="inv-part-detail">
              <button
                type="button"
                className="btn secondary inv-back-btn"
                onClick={closePartDetail}
              >
                ← Back to list
              </button>

              <div className="inv-detail-hero">
                <div className="inv-detail-photo-wrap">
                  <PartThumb src={selectedPart.image_url} name={selectedPart.name} size={64} />
                  {canManage && (
                    <div className="inv-photo-btns">
                      <label className="inv-photo-upload-btn">
                        {photoBusy ? "…" : "Photo"}
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          hidden
                          disabled={photoBusy}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = "";
                            if (f) void onUploadPartPhoto(f);
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="inv-photo-upload-btn"
                        disabled={photoBusy}
                        title="Download image from ServiceTitan"
                        onClick={() => void onSyncOnePartImage()}
                      >
                        {photoBusy ? "…" : "ST"}
                      </button>
                    </div>
                  )}
                </div>
                <div className="inv-detail-hero-text">
                  <h2 className="inv-detail-title">{selectedPart.name}</h2>
                </div>
              </div>
              <div className="inv-detail-meta">
                <span className="inv-meta-chip">
                  <span className="muted">Vendor</span>{" "}
                  <strong>{selectedPart.primary_vendor || "—"}</strong>
                </span>
                <span className="inv-meta-chip">
                  <span className="muted">Cost</span>{" "}
                  <strong>
                    {selectedPart.cost != null
                      ? `$${Number(selectedPart.cost).toFixed(2)}`
                      : "—"}
                  </strong>
                </span>
                <span className="inv-meta-chip inv-meta-total">
                  <span className="muted">Total</span>{" "}
                  <strong>{Number(selectedPart.total_qty || 0)}</strong>
                </span>
              </div>

              <h3 className="inv-section-title">Where to find it</h3>
              {canManage && (
                <div className="inv-home-picker no-print">
                  <label>
                    Home bin (primary shelf)
                    <select
                      value={
                        selectedPart.home_location_id != null
                          ? String(selectedPart.home_location_id)
                          : ""
                      }
                      disabled={homeBusy}
                      onChange={(e) => void saveHomeLocation(e.target.value)}
                    >
                      <option value="">Not set</option>
                      {warehouseSections.map((l) => (
                        <option key={l.id} value={l.id}>
                          {locationDisplayName(l)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="inv-section-hint">
                    Home is where techs look first. Put overstock counts on attic / overheads
                    / other sections — they show as Overstock below.
                  </p>
                </div>
              )}
              {(() => {
                const locLabel = (b: PartBalance) =>
                  locationDisplayName({
                    type: b.type,
                    name: b.location_name,
                    unit_number: b.unit_number,
                    zone: b.zone,
                  });
                const isHome = (b: PartBalance) =>
                  Boolean(b.is_home) ||
                  (selectedPart.home_location_id != null &&
                    b.location_id === selectedPart.home_location_id);
                const isOverstock = (b: PartBalance) =>
                  Boolean(b.is_overstock) ||
                  (b.type !== "vehicle" &&
                    Number(b.qty) > 0 &&
                    !isHome(b) &&
                    selectedPart.home_location_id != null);
                const withStock = balances.filter((b) => Number(b.qty) > 0);
                const empty = balances.filter((b) => !(Number(b.qty) > 0));
                const hasHome = selectedPart.home_location_id != null;
                const homeRows = withStock.filter((b) => isHome(b));
                const warehouseOther = withStock.filter(
                  (b) => b.type !== "vehicle" && !isHome(b)
                );
                const truckRows = withStock.filter((b) => b.type === "vehicle");
                const renderLoc = (b: PartBalance, qty: number, tag?: string) => (
                  <li
                    key={b.location_id}
                    className={`inv-location-row${qty > 0 ? " has-stock" : ""}${
                      b.min_qty != null && qty < Number(b.min_qty) ? " is-low" : ""
                    }${isHome(b) ? " is-home" : ""}${
                      hasHome && isOverstock(b) ? " is-overstock" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="inv-location-pick"
                      onClick={() => {
                        setSetLocId(String(b.location_id));
                        setSetQty(String(qty));
                        if (b.type === "vehicle") setMoveToLocId(String(b.location_id));
                      }}
                    >
                      <span className="inv-location-name">
                        {tag ? <span className="inv-loc-tag">{tag}</span> : null}
                        {locLabel(b)}
                        {b.min_qty != null ? (
                          <span className="muted inv-loc-levels">
                            {" "}
                            · low {b.min_qty}
                            {b.max_qty != null ? ` / high ${b.max_qty}` : ""}
                          </span>
                        ) : null}
                      </span>
                      <span className="inv-location-qty">{qty}</span>
                    </button>
                  </li>
                );
                if (!balances.length) {
                  return <p className="muted inv-section-hint">No locations set up yet.</p>;
                }
                return (
                  <>
                    {hasHome ? (
                      <>
                        {homeRows.length > 0 ? (
                          <>
                            <p className="inv-loc-group-title">Home</p>
                            <ul className="inv-location-list">
                              {homeRows.map((b) =>
                                renderLoc(b, Number(b.qty) || 0, "Home")
                              )}
                            </ul>
                          </>
                        ) : (
                          <p className="muted inv-empty-stock">
                            Home bin set but count is 0 — receive stock there or move from
                            overstock.
                          </p>
                        )}
                        {warehouseOther.length > 0 ? (
                          <>
                            <p className="inv-loc-group-title">Overstock</p>
                            <ul className="inv-location-list">
                              {warehouseOther.map((b) =>
                                renderLoc(
                                  b,
                                  Number(b.qty) || 0,
                                  zoneLabel(b.zone, b.type) === "Main floor"
                                    ? "Overstock"
                                    : zoneLabel(b.zone, b.type)
                                )
                              )}
                            </ul>
                          </>
                        ) : null}
                      </>
                    ) : warehouseOther.length > 0 || homeRows.length > 0 ? (
                      <>
                        <p className="inv-loc-group-title">Warehouse</p>
                        <ul className="inv-location-list">
                          {[...homeRows, ...warehouseOther].map((b) =>
                            renderLoc(b, Number(b.qty) || 0, zoneLabel(b.zone, b.type))
                          )}
                        </ul>
                      </>
                    ) : null}
                    {truckRows.length > 0 ? (
                      <>
                        <p className="inv-loc-group-title">On trucks</p>
                        <ul className="inv-location-list">
                          {truckRows.map((b) => renderLoc(b, Number(b.qty) || 0))}
                        </ul>
                      </>
                    ) : null}
                    {!withStock.length ? (
                      <p className="muted inv-empty-stock">None in stock at any location.</p>
                    ) : null}
                    {empty.length > 0 && (
                      <details className="inv-zero-loc">
                        <summary>
                          {empty.length} location{empty.length === 1 ? "" : "s"} with 0
                          <span className="inv-zero-loc-hint">tap to show / set count</span>
                        </summary>
                        <ul className="inv-location-list inv-location-list-zero">
                          {empty.map((b) => renderLoc(b, 0))}
                        </ul>
                      </details>
                    )}
                  </>
                );
              })()}

              {canManage && (
                <>
                  <div className="inv-adjust-box no-print inv-move-box">
                    <h3 className="inv-section-title" style={{ marginTop: 0 }}>
                      Move stock
                    </h3>
                    <p className="inv-section-hint">
                      From warehouse → truck, attic → warehouse, etc. One step.
                    </p>
                    <div className="inv-adjust-row">
                      <label style={{ flex: "1 1 8rem" }}>
                        From
                        <select
                          value={moveFromLocId}
                          onChange={(e) => setMoveFromLocId(e.target.value)}
                        >
                          {locationOptions.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label style={{ flex: "1 1 8rem" }}>
                        To
                        <select
                          value={moveToLocId}
                          onChange={(e) => setMoveToLocId(e.target.value)}
                        >
                          <option value="">Select…</option>
                          {locationOptions.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label style={{ flex: "0 1 4.5rem" }}>
                        Qty
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={moveQty}
                          onChange={(e) => setMoveQty(e.target.value)}
                        />
                      </label>
                      <button
                        className="btn"
                        type="button"
                        disabled={moveBusy}
                        onClick={() => void moveStock()}
                      >
                        {moveBusy ? "…" : "Move"}
                      </button>
                    </div>
                  </div>

                  <details className="inv-advanced no-print">
                    <summary className="inv-advanced-summary">
                      Advanced — counts, levels, vendors
                      <span className="muted">rarely needed day-to-day</span>
                    </summary>
                    <div className="inv-advanced-body">
                  <label className="inv-truck-stock-toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedPart.truck_stock)}
                      disabled={truckStockBusy}
                      onChange={(e) => void onToggleTruckStock(e.target.checked)}
                    />
                    <span>
                      <strong>Truck stock part</strong>
                      <span className="inv-truck-stock-hint">
                        {selectedPart.truck_stock
                          ? "On every truck list"
                          : "Add this part to every truck"}
                      </span>
                    </span>
                  </label>

                  <div className="inv-adjust-box">
                    <h3 className="inv-section-title" style={{ marginTop: 0 }}>
                      Adjust count
                    </h3>
                    <label>
                      Location
                      <select
                        value={setLocId}
                        onChange={(e) => {
                          setSetLocId(e.target.value);
                          const existing = balances.find(
                            (b) => String(b.location_id) === e.target.value
                          );
                          setSetQty(existing != null ? String(existing.qty) : "0");
                        }}
                        required
                      >
                        {locationOptions.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="inv-adjust-row">
                      <label style={{ flex: "1 1 6rem" }}>
                        Count at this location
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={setQty}
                          onChange={(e) => setSetQty(e.target.value)}
                        />
                      </label>
                      <button
                        className="btn"
                        type="button"
                        disabled={stockBusy}
                        onClick={() => void applyStock("set")}
                      >
                        {stockBusy ? "…" : "Save count"}
                      </button>
                    </div>

                    <div className="inv-adjust-row">
                      <label style={{ flex: "1 1 6rem" }}>
                        Or add / remove
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={adjustDelta}
                          onChange={(e) => setAdjustDelta(e.target.value)}
                        />
                      </label>
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={stockBusy}
                        onClick={() => void applyStock("in")}
                      >
                        + Receive
                      </button>
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={stockBusy}
                        onClick={() => void applyStock("out")}
                      >
                        − Issue
                      </button>
                    </div>

                    <label>
                      Note (optional)
                      <input
                        type="text"
                        value={stockNotes}
                        onChange={(e) => setStockNotes(e.target.value)}
                        placeholder="e.g. cycle count"
                      />
                    </label>
                    <button
                      className="btn secondary"
                      type="button"
                      style={{ marginTop: "0.35rem" }}
                      disabled={pushStBusy}
                      onClick={() => void pushPartToSt()}
                      title="Create or update this material in ServiceTitan"
                    >
                      {pushStBusy ? "Pushing…" : "Push part to ServiceTitan"}
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      style={{ marginTop: "0.5rem" }}
                      disabled={deleteBusy}
                      onClick={() => void deletePart()}
                      title="Remove from this app and deactivate in ServiceTitan pricebook"
                    >
                      {deleteBusy ? "Deleting…" : "Delete from app + ServiceTitan"}
                    </button>
                  </div>

                  {canLevels ? (
                    <form className="inv-levels-box" onSubmit={onSaveLevels}>
                      <h3 className="inv-section-title" style={{ marginTop: 0 }}>
                        Reorder levels (catalog default)
                      </h3>
                      <p className="inv-section-hint">
                        Default low/high. Per-truck overrides under Stage when needed.
                      </p>
                      <div className="inv-adjust-row">
                        <label style={{ flex: "1 1 6rem" }}>
                          Low
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={minQty}
                            onChange={(e) => setMinQty(e.target.value)}
                            placeholder="e.g. 5"
                          />
                        </label>
                        <label style={{ flex: "1 1 6rem" }}>
                          High
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={maxQty}
                            onChange={(e) => setMaxQty(e.target.value)}
                            placeholder="e.g. 20"
                          />
                        </label>
                      </div>
                      <button className="btn" type="submit" disabled={levelsBusy}>
                        {levelsBusy ? "Saving…" : "Save levels"}
                      </button>
                    </form>
                  ) : null}

                  <div className="inv-vendors-box">
                    <h3 className="inv-section-title" style={{ marginTop: 0 }}>
                      Vendors &amp; cost
                    </h3>
                    <p className="inv-section-hint">
                      Cheapest available = default for orders
                    </p>
                    {vendors.length ? (
                      <ul className="inv-vendor-cards">
                        {vendors.map((v) => {
                          const isDefault =
                            selectedPart.primary_vendor &&
                            v.vendor_name === selectedPart.primary_vendor &&
                            !!v.available;
                          return (
                            <li
                              key={v.id}
                              className={`inv-vendor-card${isDefault ? " is-default" : ""}`}
                            >
                              <div className="inv-vendor-row">
                                <div className="inv-vendor-name-block">
                                  <strong className="inv-vendor-name">{v.vendor_name}</strong>
                                  {isDefault ? (
                                    <span className="inv-default-tag">Default</span>
                                  ) : null}
                                  {v.vendor_part_number ? (
                                    <span className="muted inv-vendor-sku">
                                      #{v.vendor_part_number}
                                    </span>
                                  ) : null}
                                </div>
                                <label className="inv-vendor-cost-inline">
                                  <span className="muted">$</span>
                                  <input
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    defaultValue={v.cost != null ? String(v.cost) : ""}
                                    key={`${v.id}-${v.cost}`}
                                    disabled={vendorBusy}
                                    aria-label={`Cost for ${v.vendor_name}`}
                                    onBlur={(e) => {
                                      const next = e.target.value;
                                      const prev = v.cost != null ? String(v.cost) : "";
                                      if (next !== prev) void saveVendorCost(v, next);
                                    }}
                                  />
                                </label>
                                <label
                                  className="inv-vendor-avail"
                                  title="Available to buy"
                                >
                                  <input
                                    type="checkbox"
                                    checked={!!v.available}
                                    disabled={vendorBusy}
                                    onChange={() => void toggleVendorAvailable(v)}
                                  />
                                  <span>Buy</span>
                                </label>
                                <button
                                  className="inv-vendor-remove"
                                  type="button"
                                  disabled={vendorBusy}
                                  title="Remove vendor"
                                  aria-label={`Remove ${v.vendor_name}`}
                                  onClick={() => void removeVendor(v)}
                                >
                                  ×
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="muted inv-section-hint">No vendors yet</p>
                    )}

                    <form onSubmit={onAddVendor} className="inv-add-vendor inv-add-vendor-compact">
                      <div className="inv-adjust-row">
                        <label style={{ flex: "2 1 8rem" }}>
                          Vendor
                          <input
                            type="text"
                            value={newVendorName}
                            onChange={(e) => setNewVendorName(e.target.value)}
                            placeholder="Johnstone"
                            required
                          />
                        </label>
                        <label style={{ flex: "1 1 4.5rem" }}>
                          Cost
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={newVendorCost}
                            onChange={(e) => setNewVendorCost(e.target.value)}
                            placeholder="0.00"
                          />
                        </label>
                      </div>
                      <div className="inv-adjust-row">
                        <label style={{ flex: "1 1 6rem" }}>
                          Their part #
                          <input
                            type="text"
                            value={newVendorSku}
                            onChange={(e) => setNewVendorSku(e.target.value)}
                            placeholder="optional"
                          />
                        </label>
                      </div>
                      <label className="inv-check-label">
                        <input
                          type="checkbox"
                          checked={newVendorAvail}
                          onChange={(e) => setNewVendorAvail(e.target.checked)}
                        />
                        Available now
                      </label>
                      <button className="btn" type="submit" disabled={vendorBusy}>
                        {vendorBusy ? "Saving…" : "Add vendor"}
                      </button>
                    </form>
                  </div>
                    </div>
                  </details>
                </>
              )}
            </div>
          )}
        </>
      )}

      {tab === "pickup" && (
        <div className="card">
          <PickupPanel locations={locations} canManage={canManage} />
        </div>
      )}

      {tab === "vendor" && (
        <div className="inv-vendor-tab">
          <VendorRunPanel />
        </div>
      )}

      {tab === "stage" && (
        <div className="card order-report-card inv-stage-card">
          <div className="page-header no-print" style={{ marginBottom: "0.75rem" }}>
            <div>
              <h2 style={{ marginTop: 0 }}>Stage / truck count sheets</h2>
              <p style={{ margin: 0 }}>
                Print a clean count sheet per truck: photo, part #, low/hi, system qty, and a blank
                count box for turn-in.
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                className="btn secondary"
                type="button"
                disabled={stageBusy}
                onClick={() => void loadStageReport()}
              >
                {stageBusy ? "…" : "Refresh"}
              </button>
              {stageByUnit.length > 0 && (
                <button
                  className="btn"
                  type="button"
                  onClick={() =>
                    printTruckPullSheet(stageByUnit, {
                      title: `All truck count sheets · ${new Date().toLocaleDateString()}`,
                    })
                  }
                >
                  Print all count sheets
                </button>
              )}
            </div>
          </div>

          <h3 className="inv-section-title no-print">Trucks below low</h3>
          {!stageByUnit.length ? (
            <p className="muted">No truck lines below low right now.</p>
          ) : (
            <div className="inv-stage-units">
              {stageByUnit.map((g) => {
                return (
                  <section key={g.key} className="inv-stage-unit-block card">
                    <div className="inv-stage-unit-head no-print">
                      <div>
                        <h3 className="inv-stage-unit-title">{g.label}</h3>
                        <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                          {g.lines.length} part{g.lines.length === 1 ? "" : "s"} below low
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn secondary btn-sm"
                        onClick={() =>
                          printTruckPullSheet([g], {
                            title: `Count sheet · ${g.label}`,
                          })
                        }
                      >
                        Print count sheet
                      </button>
                    </div>
                    <div className="table-wrap inv-table-wrap">
                      <table className="inv-stage-table">
                        <thead>
                          <tr>
                            <th></th>
                            <th>Part #</th>
                            <th>Name</th>
                            <th>Low / hi</th>
                            <th>System</th>
                            <th>Count</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.lines.map((r) => (
                            <tr key={`${r.part_id}-${r.location_id}`}>
                              <td style={{ width: 44 }}>
                                <PartThumb src={r.image_url} name={r.name} size={36} />
                              </td>
                              <td>
                                <strong style={{ fontFamily: "ui-monospace, monospace" }}>
                                  {r.code}
                                </strong>
                              </td>
                              <td>{r.name}</td>
                              <td>
                                {r.min_qty}
                                {r.max_qty != null ? ` / ${r.max_qty}` : " / —"}
                              </td>
                              <td>{r.qty}</td>
                              <td>
                                <span className="muted">____</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })}
            </div>
          )}

          <h3 className="inv-section-title no-print" style={{ marginTop: "1rem" }}>
            Warehouse / attic orders
          </h3>
          {!stageWh.length ? (
            <p className="muted no-print">Warehouse is at or above lows.</p>
          ) : (
            <div className="table-wrap inv-table-wrap no-print">
              <table className="inv-stage-table">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Part</th>
                    <th>On hand</th>
                    <th>Order</th>
                  </tr>
                </thead>
                <tbody>
                  {stageWh.map((r) => (
                    <tr key={`w-${r.part_id}-${r.location_id}`}>
                      <td>{r.location_name}</td>
                      <td>
                        <strong>{r.name}</strong>
                        <div className="muted" style={{ fontSize: "0.78rem" }}>
                          {r.code}
                        </div>
                      </td>
                      <td>{r.qty}</td>
                      <td>
                        <strong>{r.order_qty}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "order" && (
        <div className="card order-report-card">
          <div className="page-header no-print" style={{ marginBottom: "0.75rem" }}>
            <div>
              <h2 style={{ marginTop: 0 }}>To order</h2>
              <p style={{ margin: 0 }}>
                Parts below their Low level. Print or save as PDF and email / mail to your vendor.
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                className="btn secondary"
                type="button"
                disabled={reorderBusy}
                onClick={() => void loadReorder(vendorFilter)}
              >
                {reorderBusy ? "…" : "Refresh"}
              </button>
              <button className="btn" type="button" onClick={() => window.print()}>
                Print / PDF
              </button>
            </div>
          </div>

          <div className="no-print" style={{ marginBottom: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <input
              type="search"
              value={vendorFilter}
              onChange={(e) => setVendorFilter(e.target.value)}
              placeholder="Filter by vendor…"
              style={{ flex: "1 1 12rem" }}
            />
            <button
              className="btn secondary"
              type="button"
              onClick={() => void loadReorder(vendorFilter)}
            >
              Apply
            </button>
          </div>

          {!reorder.length ? (
            <p className="muted">
              {reorderBusy
                ? "Loading…"
                : "Nothing below Low right now. Set Low/High on parts under Stock & levels."}
            </p>
          ) : (
            <>
              <p className="muted no-print" style={{ fontSize: "0.9rem" }}>
                {reorder.length} line{reorder.length === 1 ? "" : "s"}
                {orderEstTotal > 0
                  ? ` · est. $${orderEstTotal.toFixed(2)} (from catalog cost)`
                  : ""}
              </p>
              {reorderByVendor.map(([vendor, items]) => {
                const sub = items.reduce((s, i) => s + (i.est_cost || 0), 0);
                return (
                  <div key={vendor} className="order-vendor-block">
                    <h3 style={{ marginBottom: "0.35rem" }}>{vendor}</h3>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Code</th>
                            <th>Description</th>
                            <th>On hand</th>
                            <th>Low</th>
                            <th>High</th>
                            <th>Order qty</th>
                            <th>Unit cost</th>
                            <th>Est.</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((r) => (
                            <tr key={r.id}>
                              <td>
                                <code>{r.code}</code>
                              </td>
                              <td>
                                {r.name}
                                {r.unit_of_measure ? (
                                  <span className="muted"> ({r.unit_of_measure})</span>
                                ) : null}
                              </td>
                              <td>{r.total_qty}</td>
                              <td>{r.min_qty ?? "—"}</td>
                              <td>{r.max_qty ?? "—"}</td>
                              <td>
                                <strong>{r.order_qty}</strong>
                              </td>
                              <td>
                                {r.cost != null ? `$${Number(r.cost).toFixed(2)}` : "—"}
                              </td>
                              <td>
                                {r.est_cost != null ? `$${r.est_cost.toFixed(2)}` : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {sub > 0 && (
                      <p className="muted" style={{ fontSize: "0.88rem" }}>
                        Subtotal est. ${sub.toFixed(2)}
                      </p>
                    )}
                  </div>
                );
              })}
              {orderEstTotal > 0 && (
                <p style={{ fontWeight: 600 }}>
                  Grand total (est.): ${orderEstTotal.toFixed(2)}
                </p>
              )}
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                Please supply the quantities above. Contact: {user?.display_name || "warehouse"}
                {user?.email ? ` · ${user.email}` : ""}.
              </p>
            </>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="card no-print">
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Who changed what</h2>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Recent receives, issues, and count sets. Tap a row for full detail.
          </p>
          <LogList empty="No movements yet.">
            {movements.map((m) => (
              <LogItem
                key={m.id}
                summary={
                  <>
                    <strong>{m.part_code}</strong>
                    <span className="log-item-badge">{m.reason}</span>
                    <span className="log-item-meta">
                      qty {m.qty}
                      {m.user_name ? ` · ${m.user_name}` : ""}
                    </span>
                    <span className="log-item-meta">
                      {String(m.created_at || "").replace("T", " ").slice(0, 16)}
                    </span>
                  </>
                }
              >
                <div>
                  <strong>{m.part_name}</strong>
                </div>
                {(m.from_name || m.to_name) && (
                  <div className="muted">
                    {m.from_name || "—"} → {m.to_name || "—"}
                  </div>
                )}
                {m.notes ? <div className="muted">{m.notes}</div> : null}
              </LogItem>
            ))}
          </LogList>
        </div>
      )}

      {tab === "catalog" && (
        <div className="card no-print inv-catalog-card">
          <h2 style={{ marginTop: 0 }}>Import / export</h2>
          <p className="muted inv-catalog-lead">
            Materials sheet only · check rows → Submit · Sync photos from ST after import
          </p>

          {!canManage ? (
            <p className="muted">View only — ask admin to import the pricebook.</p>
          ) : (
            <>
              <div className="inv-import-controls">
                <label className="inv-file-label">
                  <span className="btn secondary">
                    {importFileName ? "Change file" : "1. Choose pricebook .xlsx"}
                  </span>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    hidden
                    disabled={parseBusy || importBusy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) onPickImportFile(f);
                    }}
                  />
                </label>
                {importFileName ? (
                  <span className="muted inv-file-name">
                    Selected: <strong>{importFileName}</strong>
                  </span>
                ) : (
                  <span className="muted">No file selected yet</span>
                )}
              </div>

              <div className="inv-import-actions">
                <button
                  className="btn"
                  type="button"
                  disabled={!importFile || parseBusy || importBusy}
                  onClick={() => void onBuildPreview()}
                >
                  {parseBusy ? "Reading Materials sheet…" : "2. Load for review"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={importBusy || summary.parts === 0}
                  onClick={() => void onExportCatalog()}
                >
                  Export for ServiceTitan (parts + vendors)
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={importBusy || syncImagesBusy || summary.parts === 0}
                  onClick={() => void onSyncImagesFromSt()}
                  title="Pulls missing photos from ServiceTitan and stores them permanently in the app."
                >
                  {syncImagesBusy ? "Syncing all photos…" : "Sync photos from ServiceTitan"}
                </button>
                {previewReady && (
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={importBusy}
                    onClick={clearImportPreview}
                  >
                    Clear list
                  </button>
                )}
              </div>
              <p className="muted inv-catalog-hint">
                Photos save permanently when you sync, upload, or open them — no extra step.
              </p>

              {columnMapping.length > 0 && (
                <details className="inv-mapping-box">
                  <summary className="inv-mapping-summary">
                    How we read your file
                    {importSheetName ? ` (${importSheetName})` : ""}
                    <span className="inv-mapping-summary-hint">Tap to expand</span>
                  </summary>
                  <div className="inv-mapping-body">
                    <p className="inv-mapping-intro">
                      Each line is one field we import from the pricebook.
                    </p>
                    {vendorNamesFound.length > 0 && (
                      <p className="inv-mapping-vendors">
                        <strong>Vendors in file:</strong> {vendorNamesFound.join(" · ")}
                      </p>
                    )}
                    <ul className="inv-map-list">
                      {columnMapping.map((m) => (
                        <li key={m.field} className="inv-map-item">
                          <div className="inv-map-field">{m.field}</div>
                          <div className="inv-map-col">
                            ST column: <strong>{m.stColumn}</strong>
                          </div>
                          <div className="inv-map-sample">Sample: {m.sample || "—"}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              )}

              {previewReady && (
                <div className="inv-preview-block">
                  <div className="inv-preview-summary">
                    <div className="inv-preview-stat">
                      <span className="muted">Total</span>
                      <strong>{previewCounts.total}</strong>
                    </div>
                    <div className="inv-preview-stat">
                      <span className="muted">New</span>
                      <strong className="tone-ok">{previewCounts.neu}</strong>
                    </div>
                    <div className="inv-preview-stat">
                      <span className="muted">Already in</span>
                      <strong>{previewCounts.exists}</strong>
                    </div>
                    <div className="inv-preview-stat">
                      <span className="muted">Checked</span>
                      <strong>{previewCounts.selected}</strong>
                    </div>
                  </div>

                  <div className="inv-preview-btns">
                    <button className="btn secondary" type="button" onClick={selectAllNew}>
                      Select all new
                    </button>
                    <button className="btn secondary" type="button" onClick={clearAllChecks}>
                      Clear checks
                    </button>
                    <label className="inv-file-label">
                      <span className="btn secondary">Match photos…</span>
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        disabled={importBusy}
                        onChange={(e) => {
                          const files = e.target.files;
                          e.target.value = "";
                          if (files?.length) onMatchPhotos(files);
                        }}
                      />
                    </label>
                  </div>

                  <div className="inv-import-actions">
                    <button
                      className="btn"
                      type="button"
                      disabled={importBusy || previewCounts.selected === 0}
                      onClick={() => void onSubmitApproved()}
                    >
                      {importBusy
                        ? "Submitting…"
                        : `Submit ${previewCounts.selected} selected to catalog`}
                    </button>
                  </div>
                  <p className="inv-preview-hint">
                    Green = new (checked by default). Uncheck anything you do not want. Duplicates
                    cannot be added twice.
                  </p>

                  <ul className="inv-import-list">
                    {previewRows.map((r) => (
                      <li
                        key={r.key}
                        className={
                          "inv-import-row" +
                          (r.status === "exists"
                            ? " is-exists"
                            : r.status === "dup_file"
                              ? " is-dup"
                              : "") +
                          (r.selected ? " is-selected" : "")
                        }
                      >
                        <label className="inv-import-check">
                          <input
                            type="checkbox"
                            checked={r.selected}
                            disabled={r.status === "dup_file" || importBusy}
                            onChange={(e) => setPreviewSelected(r.key, e.target.checked)}
                            aria-label={`Include ${r.name}`}
                          />
                        </label>
                        <PartThumb
                          src={r.localPreviewUrl || r.image_url}
                          name={r.name}
                          size={44}
                        />
                        <div className="inv-import-body">
                          <div className="inv-import-name">{r.name}</div>
                          <div className="inv-import-meta">
                            <span>{r.primary_vendor || "No vendor"}</span>
                            <span>
                              {r.cost != null ? `$${Number(r.cost).toFixed(2)}` : "—"}
                            </span>
                            {r.localPreviewUrl ? (
                              <span className="inv-status-photo">Photo ready</span>
                            ) : r.image_url ? (
                              <span className="inv-status-photo">Path in ST</span>
                            ) : null}
                            {r.status === "exists" ? (
                              <span className="inv-status-exists">Already in</span>
                            ) : null}
                            {r.status === "dup_file" ? (
                              <span className="inv-status-dup">Dup</span>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>

                  <div className="inv-import-actions" style={{ marginTop: "1rem" }}>
                    <button
                      className="btn"
                      type="button"
                      disabled={importBusy || previewCounts.selected === 0}
                      onClick={() => void onSubmitApproved()}
                    >
                      {importBusy
                        ? "Submitting…"
                        : `Submit ${previewCounts.selected} selected to catalog`}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === "sections" && canManage && (
        <div className="card no-print inv-sections-card">
          <h2 style={{ marginTop: 0 }}>Warehouse map</h2>
          <p className="muted inv-catalog-lead">
            Break the warehouse into real sections — shelves, overheads, attic racks. Set a
            part’s <strong>home</strong> on the part detail; put extra qty on other sections as{" "}
            <strong>overstock</strong>.
          </p>

          <form className="inv-section-form" onSubmit={(e) => void createSection(e)}>
            <label style={{ flex: "1 1 12rem" }}>
              New section name
              <input
                type="text"
                value={sectionName}
                onChange={(e) => setSectionName(e.target.value)}
                placeholder="e.g. Heat kits Aisle 3"
                maxLength={80}
                required
              />
            </label>
            <label style={{ flex: "0 1 9rem" }}>
              Area
              <select
                value={sectionZone}
                onChange={(e) =>
                  setSectionZone(e.target.value as "main" | "overhead" | "attic" | "other")
                }
              >
                <option value="main">Main floor</option>
                <option value="overhead">Overhead</option>
                <option value="attic">Attic</option>
                <option value="other">Other</option>
              </select>
            </label>
            <button className="btn" type="submit" disabled={sectionBusy || !sectionName.trim()}>
              {sectionBusy ? "…" : "Add section"}
            </button>
          </form>

          <ul className="inv-sections-list">
            {warehouseSections.map((l) => (
              <li key={l.id} className="inv-section-row">
                <div>
                  <strong>{l.name}</strong>
                  <span className="muted"> · {zoneLabel(l.zone, l.type)}</span>
                </div>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={sectionBusy}
                  onClick={() => void removeSection(l)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {!warehouseSections.length && (
            <p className="empty">No warehouse sections yet — add one above.</p>
          )}
        </div>
      )}
    </div>
  );
}
