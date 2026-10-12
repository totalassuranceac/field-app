import { FormEvent, useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api, ApiError } from "../api";
import { WarrantyHandoffSheet } from "./WarrantyHandoffSheet";

type OpenRequest = {
  id: number;
  part_description: string;
  part_number: string | null;
  job_ref: string | null;
  po_number: string | null;
  qty?: number | null;
  vendor_preference: string | null;
  ordered_from: string | null;
  created_at: string;
  requested_by_name?: string | null;
  user_id: number;
};

type Arrival = {
  id: number;
  part_description: string;
  vendor_name: string | null;
  po_number: string | null;
  request_id: number | null;
  known_user_id: number | null;
  known_user_name?: string | null;
  logged_by_name?: string | null;
  status: string;
  qty?: number | null;
  place_label?: string | null;
  photo_key?: string | null;
  not_needed_at: string | null;
  linked_job?: string | null;
  linked_requester_name?: string | null;
  created_at: string;
};

type NameHit = { id: number; display_name: string };

type SitLoc = {
  id: number;
  type: string;
  name: string;
  zone?: string | null;
  sort_order?: number | null;
  unit_number?: string | null;
};

type PlaceKind = "" | "section" | "truck" | "floor";

function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function whenCt(iso: string | null | undefined): string {
  if (!iso) return "time not recorded";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function arrivalLabel(status: string): string {
  if (status === "unmatched") return "Unmatched arrival";
  if (status === "docked") return "Docked";
  if (status === "received") return "Received";
  if (status === "returned") return "Returned";
  return status;
}

function qtyShown(n: unknown): string {
  if (n == null || n === "") return "qty not recorded";
  const x = Number(n);
  if (!Number.isFinite(x)) return "qty not recorded";
  return `qty ${String(Math.round(x * 1000) / 1000)}`;
}

function areaLabel(zone?: string | null, type?: string | null): string {
  const z = (zone || "").toLowerCase();
  if (z === "overhead") return "Overhead";
  if (z === "attic" || type === "attic") return "Attic";
  if (z === "main") return "Main floor";
  if (z === "other") return "Other";
  return "";
}

function sectionLabel(l: SitLoc): string {
  const area = areaLabel(l.zone, l.type);
  if (!area || l.name.toLowerCase() === area.toLowerCase()) return l.name;
  return `${l.name} - ${area}`;
}

function truckOptionLabel(l: SitLoc): string {
  const unit = String(l.unit_number || "").trim();
  if (unit) return /^unit\s+/i.test(unit) ? unit : `Unit ${unit}`;
  const name = String(l.name || "").trim();
  return name || "Truck";
}

function zoneRank(zone?: string | null): number {
  const z = (zone || "").toLowerCase();
  if (z === "main") return 0;
  if (z === "overhead") return 1;
  if (z === "attic") return 2;
  return 3;
}

function requestLine(h: OpenRequest): string {
  return `${h.requested_by_name || "Requester"} - ${h.job_ref || "No job"} - requested ${whenLabel(h.created_at)}${
    h.part_description ? ` - ${h.part_description}` : ""
  }`;
}

async function compressPhoto(file: File, maxBytes = 850_000): Promise<File> {
  if (file.size <= maxBytes && /jpe?g/i.test(file.type || file.name)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const maxW = 1600;
    const scale = bmp.width > maxW ? maxW / bmp.width : 1;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    let quality = 0.82;
    let blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", quality));
    while (blob && blob.size > maxBytes && quality > 0.45) {
      quality -= 0.1;
      blob = await new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", quality));
    }
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function PartsReceivingPanel({
  role,
  userId,
  onChanged,
}: {
  role: string;
  userId: number;
  onChanged: () => void;
}) {
  const location = useLocation();
  const canReceive = role === "admin" || role === "office" || role === "warehouse";
  const [part, setPart] = useState("");
  const [actualQty, setActualQty] = useState("");
  const [vendor, setVendor] = useState("");
  const [po, setPo] = useState("");
  const [placeValue, setPlaceValue] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoInputKey, setPhotoInputKey] = useState(0);
  const [places, setPlaces] = useState<SitLoc[]>([]);
  const [addingSection, setAddingSection] = useState(false);
  const [sectionName, setSectionName] = useState("");
  const [sectionZone, setSectionZone] = useState<"main" | "overhead" | "attic" | "other">("main");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<OpenRequest[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [whoQ, setWhoQ] = useState("");
  const [whoHits, setWhoHits] = useState<NameHit[]>([]);
  const [knownUserId, setKnownUserId] = useState<number | null>(null);
  const [knownName, setKnownName] = useState("");
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [linkingId, setLinkingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  const loadArrivals = useCallback(async () => {
    const data = await api<{ arrivals?: Arrival[] }>("/parts-orders/arrivals");
    setArrivals(data.arrivals || []);
  }, []);

  const searchOpen = useCallback(async (query: string) => {
    const data = await api<{ requests?: OpenRequest[] }>(
      `/parts-orders/open-search?q=${encodeURIComponent(query)}`
    );
    setHits(data.requests || []);
  }, []);

  const loadPlaces = useCallback(async () => {
    const data = await api<{ locations?: SitLoc[] }>("/inventory/locations");
    setPlaces(data.locations || []);
  }, []);

  useEffect(() => {
    if (location.hash !== "#receiving") return;
    document.getElementById("receiving")?.scrollIntoView({ block: "start" });
  }, [location.hash]);

  useEffect(() => {
    if (!canReceive) {
      void loadArrivals().catch(() => {
        /* requester may have none */
      });
      return;
    }
    void loadArrivals().catch((e) => setError(e instanceof Error ? e.message : "Could not load arrivals"));
    void searchOpen("").catch(() => {
      /* search is optional until they type */
    });
    void loadPlaces().catch((e) => setError(e instanceof Error ? e.message : "Could not load places"));
  }, [canReceive, loadArrivals, loadPlaces, searchOpen]);

  const sections = places
    .filter((l) => l.type === "warehouse" || l.type === "attic")
    .sort((a, b) => {
      const so = Number(a.sort_order || 0) - Number(b.sort_order || 0);
      if (so) return so;
      const zr = zoneRank(a.zone) - zoneRank(b.zone);
      if (zr) return zr;
      return a.name.localeCompare(b.name);
    });
  const trucks = places
    .filter((l) => l.type === "vehicle")
    .sort((a, b) => {
      const au = parseInt(String(a.unit_number || "").replace(/\D/g, ""), 10);
      const bu = parseInt(String(b.unit_number || "").replace(/\D/g, ""), 10);
      const an = Number.isFinite(au) ? au : 100000;
      const bn = Number.isFinite(bu) ? bu : 100000;
      if (an !== bn) return an - bn;
      return truckOptionLabel(a).localeCompare(truckOptionLabel(b));
    });

  function parsedPlace(): { kind: PlaceKind; id: number | null } {
    if (placeValue === "floor") return { kind: "floor", id: null };
    const m = /^(section|truck):(\d+)$/.exec(placeValue);
    if (!m) return { kind: "", id: null };
    return { kind: m[1] as "section" | "truck", id: Number(m[2]) };
  }

  function pickRequest(h: OpenRequest) {
    setSelectedId(h.id);
    const n = Number(h.qty);
    if (Number.isFinite(n) && n > 0) setActualQty(String(Math.round(n * 1000) / 1000));
  }

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await searchOpen(q.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    }
  }

  async function findWho(e?: { preventDefault: () => void }) {
    e?.preventDefault();
    if (whoQ.trim().length < 2) {
      setWhoHits([]);
      return;
    }
    try {
      const data = await api<{ users?: NameHit[] }>(
        `/parts-orders/requesters?q=${encodeURIComponent(whoQ.trim())}`
      );
      setWhoHits(data.users || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not look up a name");
    }
  }

  async function addSection() {
    const name = sectionName.trim();
    if (!name) {
      setError("Enter a section name.");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const res = await api<{ location: { id: number } }>("/inventory/locations", {
        method: "POST",
        body: JSON.stringify({
          name,
          zone: sectionZone,
          type: sectionZone === "attic" ? "attic" : "warehouse",
        }),
      });
      const id = Number(res.location?.id || 0);
      if (id) setPlaceValue(`section:${id}`);
      setSectionName("");
      setAddingSection(false);
      setOk(`${name} added.`);
      await loadPlaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that section.");
    } finally {
      setBusy(false);
    }
  }

  function clearDockForm() {
    setPart("");
    setActualQty("");
    setVendor("");
    setPo("");
    setPlaceValue("");
    setPhoto(null);
    setPhotoInputKey((n) => n + 1);
    setSelectedId(null);
    setKnownUserId(null);
    setKnownName("");
    setWhoQ("");
    setWhoHits([]);
  }

  async function uploadPhoto(): Promise<string | null> {
    if (!photo) return null;
    const compressed = await compressPhoto(photo);
    const fd = new FormData();
    fd.append("file", compressed);
    fd.append("folder", "parts-arrivals");
    const up = await api<{ key: string }>("/uploads/receipt", { method: "POST", body: fd });
    return up.key || null;
  }

  function dockFacts(): { qty: number; kind: PlaceKind; id: number | null } | null {
    const qtyN = Number(actualQty);
    if (!actualQty.trim() || !Number.isFinite(qtyN) || qtyN <= 0) {
      setError("Enter the actual qty.");
      return null;
    }
    const place = parsedPlace();
    if (!place.kind || (place.kind !== "floor" && !place.id)) {
      setError("Pick where it sits.");
      return null;
    }
    if (part.trim().length < 2) {
      setError("Enter the part that arrived.");
      return null;
    }
    return { qty: qtyN, kind: place.kind, id: place.id };
  }

  async function markDocked() {
    if (!selectedId) {
      setError("Pick the open part request this box belongs to.");
      return;
    }
    const facts = dockFacts();
    if (!facts) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      const photoKey = await uploadPhoto();
      const docked = await api<{ stock_note?: string }>("/parts-orders/arrivals", {
        method: "POST",
        body: JSON.stringify({
          part_description: part.trim(),
          vendor_name: vendor.trim() || null,
          po_number: po.trim() || null,
          request_id: selectedId,
          qty: facts.qty,
          place_kind: facts.kind,
          place_location_id: facts.id,
          photo_key: photoKey,
        }),
      });
      setOk(
        docked.stock_note
          ? `Docked and linked to that request. ${docked.stock_note}`
          : "Docked and linked to that request."
      );
      clearDockForm();
      await loadArrivals();
      await searchOpen(q.trim());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not dock the box");
    } finally {
      setBusy(false);
    }
  }

  async function markUnmatched() {
    const facts = dockFacts();
    if (!facts) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      const photoKey = await uploadPhoto();
      await api("/parts-orders/arrivals", {
        method: "POST",
        body: JSON.stringify({
          part_description: part.trim(),
          vendor_name: vendor.trim() || null,
          po_number: po.trim() || null,
          unmatched: true,
          known_user_id: knownUserId,
          qty: facts.qty,
          place_kind: facts.kind,
          place_location_id: facts.id,
          photo_key: photoKey,
        }),
      });
      setOk("Saved as an unmatched arrival.");
      clearDockForm();
      await loadArrivals();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the arrival");
    } finally {
      setBusy(false);
    }
  }

  async function linkArrival(arrivalId: number, requestId: number) {
    if (!requestId) {
      setError("Pick the open request to link.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const linked = await api<{ stock_note?: string }>(`/parts-orders/arrivals/${arrivalId}/link`, {
        method: "POST",
        body: JSON.stringify({ request_id: requestId }),
      });
      setOk(
        linked.stock_note
          ? `Linked. That request is marked received. ${linked.stock_note}`
          : "Linked. That request is marked received."
      );
      setLinkingId(null);
      setSelectedId(null);
      await loadArrivals();
      await searchOpen(q.trim());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link");
    } finally {
      setBusy(false);
    }
  }

  const [arrivalProofOn, setArrivalProofOn] = useState(false);
  const [arrivalSheet, setArrivalSheet] = useState<{ row: Arrival; kind: "return" | "not" } | null>(null);
  useEffect(() => {
    api<{ ready: boolean; proof_required_arrival_return: boolean }>("/handoffs/config")
      .then((d) => setArrivalProofOn(Boolean(d.ready && d.proof_required_arrival_return)))
      .catch(() => setArrivalProofOn(false));
  }, []);

  async function notNeededReturn(id: number) {
    setBusy(true);
    setError("");
    try {
      await api(`/parts-orders/arrivals/${id}/not-needed-return`, { method: "POST", body: "{}" });
      setOk("Marked not needed and returned.");
      await loadArrivals();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.data as { code?: string } | undefined)?.code === "handoff_required") {
        const row = arrivals.find((x) => x.id === id);
        if (row) setArrivalSheet({ row, kind: "not" });
      } else setError(err instanceof Error ? err.message : "Could not mark the return");
    } finally {
      setBusy(false);
    }
  }

  async function markReturn(id: number) {
    setBusy(true);
    setError("");
    try {
      const returned = await api<{ stock_note?: string }>(`/parts-orders/arrivals/${id}/return`, {
        method: "POST",
        body: "{}",
      });
      setOk(returned.stock_note ? `Marked return. ${returned.stock_note}` : "Marked return.");
      await loadArrivals();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.data as { code?: string } | undefined)?.code === "handoff_required") {
        const row = arrivals.find((x) => x.id === id);
        if (row) setArrivalSheet({ row, kind: "return" });
      } else setError(err instanceof Error ? err.message : "Could not mark return");
    } finally {
      setBusy(false);
    }
  }

  const visible = arrivals.filter(
    (a) => a.status === "unmatched" || a.status === "docked" || a.status === "received" || a.status === "returned"
  );
  if (!canReceive && visible.length === 0) return null;

  return (
    <section id="receiving" className="card" style={{ marginBottom: "0.9rem", scrollMarginTop: "5rem" }}>
      {arrivalSheet ? (
        <WarrantyHandoffSheet
          card={{
            id: arrivalSheet.row.id,
            part_name: arrivalSheet.row.part_description,
            vendor_name: arrivalSheet.row.vendor_name,
          }}
          action="record_only"
          handoffType="counter_dropoff"
          sourceType="parts_arrival"
          runAction={async () => {
            const path = arrivalSheet.kind === "not" ? "not-needed-return" : "return";
            await api(`/parts-orders/arrivals/${arrivalSheet.row.id}/${path}`, { method: "POST", body: "{}" });
          }}
          onDone={() => {
            setArrivalSheet(null);
            void loadArrivals();
          }}
          onCancel={() => setArrivalSheet(null)}
        />
      ) : null}
      <h2 style={{ marginTop: 0 }}>Receiving</h2>
      {canReceive ? (
        <p className="muted" style={{ marginTop: 0 }}>
          Dock the box, enter the qty, and pick where it sits. Then pick the open part request, or save it unmatched.
          Search by part, job number, vendor, or PO.
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          A part arrived with no open request under your name. If it is not needed, one tap returns it.
        </p>
      )}
      {error ? <div className="error">{error}</div> : null}
      {ok ? <div className="success">{ok}</div> : null}

      {canReceive ? (
        <form className="form" onSubmit={onSearch}>
          <label>
            Part that arrived *
            <input value={part} onChange={(e) => setPart(e.target.value)} required placeholder="Part name or number" />
          </label>
          <label>
            Actual qty *
            <input
              inputMode="decimal"
              value={actualQty}
              onChange={(e) => setActualQty(e.target.value)}
              placeholder="How many arrived"
            />
          </label>
          <label>
            Vendor
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Supplier" />
          </label>
          <label>
            PO
            <input value={po} onChange={(e) => setPo(e.target.value)} placeholder="PO if it is on the box" />
          </label>
          <label>
            Where it sits *
            <select value={placeValue} onChange={(e) => setPlaceValue(e.target.value)}>
              <option value="">Choose</option>
              {sections.length ? (
                <optgroup label="Section">
                  {sections.map((s) => (
                    <option key={s.id} value={`section:${s.id}`}>
                      {sectionLabel(s)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {trucks.length ? (
                <optgroup label="Truck">
                  {trucks.map((t) => (
                    <option key={t.id} value={`truck:${t.id}`}>
                      {truckOptionLabel(t)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <option value="floor">Floor</option>
            </select>
          </label>
          <div className="toolbar">
            <button
              className="btn secondary btn-sm"
              type="button"
              disabled={busy}
              onClick={() => setAddingSection((open) => !open)}
            >
              + New section
            </button>
          </div>
          {addingSection ? (
            <div className="toolbar">
              <input
                value={sectionName}
                placeholder="Section name"
                maxLength={80}
                disabled={busy}
                onChange={(e) => setSectionName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addSection();
                  }
                }}
              />
              <select
                value={sectionZone}
                disabled={busy}
                onChange={(e) => setSectionZone(e.target.value as "main" | "overhead" | "attic" | "other")}
              >
                <option value="main">Main floor</option>
                <option value="overhead">Overhead</option>
                <option value="attic">Attic</option>
                <option value="other">Other</option>
              </select>
              <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void addSection()}>
                Add section
              </button>
            </div>
          ) : null}
          <label>
            Photo <span className="muted">(optional, box or packing slip)</span>
            <input
              key={photoInputKey}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => setPhoto(e.target.files?.[0] || null)}
            />
          </label>
          {photo ? <p className="muted">Photo ready.</p> : null}
          <label>
            Find the open request
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Part, job number, vendor, or PO"
            />
          </label>
          <div className="toolbar">
            <button className="btn secondary btn-sm" type="submit">
              Search
            </button>
          </div>
          {linkingId ? <p className="muted">Tap a request to link it.</p> : null}
          {hits.length ? (
            <ul style={{ listStyle: "none", padding: 0, margin: "0.4rem 0" }}>
              {hits.map((h) => {
                const picked = selectedId === h.id && !linkingId;
                return (
                  <li key={h.id} style={{ marginBottom: "0.35rem" }}>
                    <button
                      type="button"
                      className={picked ? "btn btn-sm" : "btn secondary btn-sm"}
                      disabled={busy}
                      onClick={() => {
                        if (linkingId) {
                          void linkArrival(linkingId, h.id);
                          return;
                        }
                        pickRequest(h);
                      }}
                    >
                      {requestLine(h)}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">No open requests match that search.</p>
          )}
          <div className="form">
            <label>
              Who asked? <span className="muted">(only if you know, for an unmatched box)</span>
              <input
                value={whoQ}
                onChange={(e) => setWhoQ(e.target.value)}
                placeholder="Name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void findWho();
                  }
                }}
              />
            </label>
            <button className="btn secondary btn-sm" type="button" onClick={(e) => void findWho(e)}>
              Find name
            </button>
            {knownName ? <p className="muted">Will notify {knownName}.</p> : null}
            {whoHits.length ? (
              <div className="toolbar">
                {whoHits.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className={knownUserId === u.id ? "btn btn-sm" : "btn secondary btn-sm"}
                    onClick={() => {
                      setKnownUserId(u.id);
                      setKnownName(u.display_name);
                    }}
                  >
                    {u.display_name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="toolbar">
            <button className="btn" type="button" disabled={busy || !selectedId} onClick={() => void markDocked()}>
              {busy ? "Saving..." : "Dock"}
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => void markUnmatched()}>
              No matching request
            </button>
          </div>
        </form>
      ) : null}

      {visible.map((a) => {
        const linked = a.request_id != null && a.request_id > 0;
        const confirmed = Boolean(a.not_needed_at);
        const canReturn = linked || confirmed;
        const showNotNeededReturn =
          a.status === "unmatched" && !linked && (canReceive || a.known_user_id === userId);
        const showPlainReturn = canReceive && a.status !== "returned" && canReturn && !showNotNeededReturn;
        return (
          <article key={a.id} className="card" style={{ marginTop: "0.7rem" }}>
            <strong>{a.part_description}</strong>
            <span className="muted"> - {arrivalLabel(a.status)}</span>
            <p className="muted" style={{ marginBottom: 0 }}>
              {a.vendor_name ? `${a.vendor_name}` : "No vendor"}
              {a.po_number ? ` - PO ${a.po_number}` : ""}
              {a.known_user_name ? ` - ${a.known_user_name}` : ""}
              {linked
                ? ` - linked to ${a.linked_requester_name || "request"} ${a.linked_job || ""}`.trim()
                : ""}
            </p>
            <p className="muted" style={{ marginBottom: 0 }}>
              Signed in by {a.logged_by_name || "staff"} - {whenCt(a.created_at)} - {qtyShown(a.qty)} -{" "}
              {a.place_label || "place not recorded"}
            </p>
            {a.photo_key ? (
              <img
                src={`/api/uploads/${a.photo_key}`}
                alt="Box or packing slip"
                style={{ maxWidth: 220, display: "block", marginTop: 6 }}
              />
            ) : null}
            {a.status === "unmatched" && !linked ? (
              <p>Link this to an open request, or mark it not needed and return it.</p>
            ) : null}
            {canReceive && a.status === "unmatched" && !linked ? (
              <div className="toolbar">
                <button
                  type="button"
                  className="btn secondary btn-sm"
                  disabled={busy}
                  onClick={() => {
                    if (selectedId) {
                      void linkArrival(a.id, selectedId);
                      return;
                    }
                    setLinkingId(linkingId === a.id ? null : a.id);
                  }}
                >
                  Link to a request
                </button>
              </div>
            ) : null}
            {linkingId === a.id ? (
              hits.length ? (
                <ul style={{ listStyle: "none", padding: 0, margin: "0.4rem 0" }}>
                  {hits.map((h) => (
                    <li key={h.id} style={{ marginBottom: "0.35rem" }}>
                      <button
                        type="button"
                        className="btn secondary btn-sm"
                        disabled={busy}
                        onClick={() => void linkArrival(a.id, h.id)}
                      >
                        {requestLine(h)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Search for the open request above, then tap it.</p>
              )
            ) : null}
            {showPlainReturn ? (
              <div className="toolbar">
                <button type="button" className="btn secondary btn-sm" disabled={busy} onClick={() => (arrivalProofOn ? setArrivalSheet({ row: a, kind: "return" }) : void markReturn(a.id))}>
                  Return
                </button>
              </div>
            ) : null}
            {showNotNeededReturn ? (
              <div className="toolbar">
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => (arrivalProofOn ? setArrivalSheet({ row: a, kind: "not" }) : void notNeededReturn(a.id))}>
                  Not needed - return
                </button>
              </div>
            ) : null}
            {confirmed ? <p className="muted">Not needed confirmed {whenLabel(a.not_needed_at)}.</p> : null}
          </article>
        );
      })}
    </section>
  );
}
