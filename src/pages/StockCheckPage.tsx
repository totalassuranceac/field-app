import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";

type Hit = {
  id: number;
  code: string | null;
  name: string | null;
  qty_on_hand: number | null;
  qty_tracked: boolean;
  locations: Array<{ name: string; qty: number }>;
};

type Vendor = { brand: string; label: string; finderUrl: string | null };

type StubLine = {
  lineKey: string;
  failedComponent: string;
  catNumber: string | null;
  oem: string;
  description: string;
  pickupQty: number | null;
  shippingStatus: string;
  productUrl: string | null;
  vendor: string;
  availability: string;
  source: string;
};

const FAILED_OPTS: { id: string; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "txv", label: "TXV" },
  { id: "motor", label: "Motor" },
  { id: "compressor", label: "Compressor" },
  { id: "coil", label: "Coil" },
  { id: "other", label: "Other" },
];

type OpenRequest = {
  id: number;
  user_id: number;
  serial: string;
  brand: string;
  po_reference: string;
  needs_install?: number | null;
  no_cool?: number | null;
  picked_up_at?: string | null;
  schedule_status?: string | null;
  requested_by_name?: string | null;
};

export function StockCheckPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const [repairAllowed, setRepairAllowed] = useState(false);
  const [shopAllowed, setShopAllowed] = useState(false);
  const [shopPreview, setShopPreview] = useState(true);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [tab, setTab] = useState<"repair" | "shop">(tabParam === "shop" ? "shop" : "repair");

  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [parts, setParts] = useState<Hit[] | null>(null);
  const [shopError, setShopError] = useState("");
  const [shopBusy, setShopBusy] = useState(false);

  const [serial, setSerial] = useState("");
  const [needText, setNeedText] = useState("");
  const [brand, setBrand] = useState<string>("");
  const [failed, setFailed] = useState<string[]>([]);
  const [failedOther, setFailedOther] = useState("");
  const [jobAddress, setJobAddress] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [stubBanner, setStubBanner] = useState("");
  const [finderUrl, setFinderUrl] = useState<string | null>(null);
  const [lines, setLines] = useState<StubLine[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderMsg, setOrderMsg] = useState("");
  const [orderError, setOrderError] = useState("");
  const [needsInstall, setNeedsInstall] = useState(false);
  const [noCool, setNoCool] = useState(false);
  const [openReqs, setOpenReqs] = useState<OpenRequest[]>([]);
  const [reqBusy, setReqBusy] = useState<number | null>(null);
  const [lookupDone, setLookupDone] = useState(false);
  const [badField, setBadField] = useState<"" | "serial" | "brand" | "need" | "address">("");
  const serialRef = useRef<HTMLInputElement>(null);
  const needRef = useRef<HTMLTextAreaElement>(null);
  const brandRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const orderRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<{ allowed?: boolean; vendors?: Vendor[] }>("/part-finder/access")
      .then((d) => {
        setRepairAllowed(Boolean(d.allowed));
        setVendors(d.vendors || []);
      })
      .catch(() => setRepairAllowed(false));
    void api<{ allowed?: boolean; preview?: boolean }>("/inventory/stock-check/access")
      .then((d) => {
        setShopAllowed(Boolean(d.allowed));
        setShopPreview(Boolean(d.preview));
      })
      .catch(() => {
        setShopAllowed(false);
        setShopPreview(false);
      });
  }, []);

  useEffect(() => {
    if (failed.includes("coil") || /\bcoils?\b/i.test(needText)) setNeedsInstall(true);
  }, [failed, needText]);

  function loadRequests() {
    if (!repairAllowed) return;
    void api<{ requests?: OpenRequest[] }>("/part-finder/requests")
      .then((d) => setOpenReqs(d.requests || []))
      .catch(() => setOpenReqs([]));
  }

  async function markRequest(id: number, action: "picked-up" | "scheduled") {
    setReqBusy(id);
    setOrderError("");
    try {
      await api(`/part-finder/requests/${id}/${action}`, { method: "POST", body: "{}" });
      loadRequests();
    } catch (e) {
      setOrderError(e instanceof Error ? e.message : "Could not update");
    } finally {
      setReqBusy(null);
    }
  }

  useEffect(() => {
    if (tab === "repair" && repairAllowed) loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, repairAllowed]);

  useEffect(() => {
    if (tabParam === "shop" || tabParam === "repair") setTab(tabParam);
    else if (repairAllowed) setTab("repair");
    else if (shopAllowed) setTab("shop");
  }, [tabParam, repairAllowed, shopAllowed]);

  function switchTab(next: "repair" | "shop") {
    setTab(next);
    const p = new URLSearchParams(params);
    p.set("tab", next);
    setParams(p, { replace: true });
  }

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (tab !== "shop") return;
    if (debounced.length < 2) {
      setParts(null);
      setShopError("");
      return;
    }
    let cancelled = false;
    setShopBusy(true);
    void api<{ parts: Hit[] }>(`/inventory/stock-check?q=${encodeURIComponent(debounced)}`)
      .then((d) => {
        if (!cancelled) {
          setParts(d.parts || []);
          setShopError("");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setParts([]);
          setShopError(e instanceof Error ? e.message : "Could not search");
        }
      })
      .finally(() => {
        if (!cancelled) setShopBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, tab]);

  function toggleFailed(id: string) {
    setFailed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function scrollToResult() {
    window.setTimeout(() => {
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 30);
  }

  function lookupMessage(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.status === 404 || /<!DOCTYPE|<html/i.test(e.message)) {
        return "Server route missing - tell Atlas";
      }
      return e.message || "Lookup failed";
    }
    if (e instanceof Error) return e.message || "Lookup failed";
    const msg = String((e as { message?: string } | null)?.message ?? e ?? "Lookup failed");
    if (/<!DOCTYPE|<html/i.test(msg)) return "Server route missing - tell Atlas";
    return msg || "Lookup failed";
  }

  async function runLookup() {
    setLookupError("");
    setOrderMsg("");
    setOrderError("");
    setLines([]);
    setStubBanner("");
    setLookupDone(false);
    setBadField("");
    const said = [needText.trim(), failed.includes("other") ? failedOther.trim() : ""].filter(Boolean).join(" - ");
    if (!serial.trim()) {
      setLookupError("Serial is required");
      setBadField("serial");
      serialRef.current?.focus();
      scrollToResult();
      return;
    }
    if (!brand) {
      setLookupError("Pick brand: Lennox, Daikin, Carrier, or Other");
      setBadField("brand");
      brandRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      scrollToResult();
      return;
    }
    if (brand !== "other" && !failed.length && said.length < 3) {
      setLookupError("Say what you need or tap what failed");
      setBadField("need");
      needRef.current?.focus();
      scrollToResult();
      return;
    }
    setLookupBusy(true);
    scrollToResult();
    let focusOrder = false;
    try {
      const d = await api<{
        stubBanner?: string;
        finderUrl?: string | null;
        lines?: StubLine[];
        lookupStatus?: string;
      }>("/part-finder/lookup", {
        method: "POST",
        body: JSON.stringify({
          serial: serial.trim(),
          brand,
          failed_components: failed,
          need_text: said,
          failed_other_text: failed.includes("other") ? failedOther : said || null,
          job_address: jobAddress.trim() || null,
        }),
      });
      const got = d.lines || [];
      console.info("[part-finder] lookup", d.lookupStatus || "ok", got.length);
      setStubBanner(d.stubBanner || "Demo stock, not live vendor");
      setFinderUrl(d.finderUrl || null);
      setLines(got);
      const sel: Record<string, boolean> = {};
      for (const ln of got) sel[ln.lineKey] = true;
      setSelected(sel);
      setLookupDone(true);
      if (got.length > 0) focusOrder = true;
    } catch (e) {
      console.info("[part-finder] lookup", "error", 0);
      setLookupError(lookupMessage(e));
      setLookupDone(true);
    } finally {
      setLookupBusy(false);
      if (focusOrder) {
        window.setTimeout(() => orderRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 60);
      } else {
        scrollToResult();
      }
    }
  }

  async function sendToOffice() {
    setOrderError("");
    setOrderMsg("");
    if (!jobAddress.trim() || jobAddress.trim().length < 5) {
      setOrderError("Job site address is required - it becomes the PO reference");
      setBadField("");
      scrollToResult();
      return;
    }
    setOrderBusy(true);
    try {
      const said = [needText.trim(), failed.includes("other") ? failedOther.trim() : ""].filter(Boolean).join(" - ");
      const d = await api<{ message?: string; po_reference?: string }>("/part-finder/order-request", {
        method: "POST",
        body: JSON.stringify({
          serial: serial.trim(),
          brand,
          failed_components: failed.length ? failed : ["other"],
          need_text: said,
          failed_other_text: said || null,
          needs_install: needsInstall || failed.includes("coil"),
          no_cool: noCool,
          fulfillment_preference: noCool ? "pickup" : "auto",
          job_address: jobAddress.trim(),
          lines: [],
        }),
      });
      setOrderMsg(d.message || `Order queued - address PO: ${d.po_reference || jobAddress.trim()}`);
      loadRequests();
    } catch (e) {
      setOrderError(lookupMessage(e));
    } finally {
      setOrderBusy(false);
      scrollToResult();
    }
  }

  const selectedLines = useMemo(
    () => lines.filter((ln) => selected[ln.lineKey]),
    [lines, selected]
  );

  async function orderSelected() {
    setOrderError("");
    setOrderMsg("");
    if (!selectedLines.length) {
      setOrderError("Select at least one part");
      orderRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (!jobAddress.trim() || jobAddress.trim().length < 5) {
      setOrderError("Job site address is required - it becomes the PO reference");
      setBadField("address");
      addressRef.current?.focus();
      addressRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setOrderBusy(true);
    try {
      const d = await api<{ message?: string; po_reference?: string }>("/part-finder/order-request", {
        method: "POST",
        body: JSON.stringify({
          serial: serial.trim(),
          brand,
          failed_components: failed.length ? failed : ["other"],
          need_text: needText.trim() || (failed.includes("other") ? failedOther.trim() : ""),
          failed_other_text: failed.includes("other") ? failedOther.trim() : needText.trim() || null,
          needs_install: needsInstall || failed.includes("coil"),
          no_cool: noCool,
          fulfillment_preference: noCool ? "pickup" : "auto",
          job_address: jobAddress.trim(),
          lines: selectedLines.map((ln) => ({
            ...ln,
            qty: 1,
            fulfillment:
              ln.pickupQty != null && Number(ln.pickupQty) > 0
                ? "pickup"
                : ln.availability === "ship_only"
                  ? "ship"
                  : "pending_review",
          })),
        }),
      });
      setOrderMsg(d.message || `Order queued - address PO: ${d.po_reference || jobAddress.trim()}`);
      loadRequests();
    } catch (e) {
      setOrderError(e instanceof Error ? e.message : "Could not create request");
    } finally {
      setOrderBusy(false);
      orderRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  const brandMeta = vendors.find((v) => v.brand === brand);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Part in stock</h1>
          <p className="muted">Repair serial search or shop warehouse qty.</p>
        </div>
      </header>

      <div className="toolbar" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        {repairAllowed ? (
          <button
            type="button"
            className={tab === "repair" ? "btn btn-sm" : "btn secondary btn-sm"}
            onClick={() => switchTab("repair")}
          >
            Repair part (serial)
          </button>
        ) : null}
        {shopAllowed ? (
          <button
            type="button"
            className={tab === "shop" ? "btn btn-sm" : "btn secondary btn-sm"}
            onClick={() => switchTab("shop")}
          >
            Shop inventory
          </button>
        ) : null}
      </div>

      {tab === "repair" && repairAllowed ? (
        <section style={{ marginTop: "0.75rem" }}>
          <p className="muted">
            Serial first. Say what failed. Brand locks the finder. Order is a request only - no
            vendor checkout, no made-up Cat # or stock.
          </p>

          <label>
            Serial (required)
            <input
              ref={serialRef}
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              placeholder="Unit serial from the plate"
              autoFocus
              autoComplete="off"
              inputMode="text"
              style={
                badField === "serial"
                  ? { fontSize: "1.05rem", borderColor: "#b91c1c", outline: "2px solid #b91c1c" }
                  : { fontSize: "1.05rem" }
              }
            />
          </label>

          <label style={{ marginTop: "0.75rem" }}>
            What do you need
            <textarea
              ref={needRef}
              value={needText}
              onChange={(e) => setNeedText(e.target.value)}
              rows={2}
              placeholder="Plain words, e.g. control board or TXV leaking"
              style={
                badField === "need"
                  ? { borderColor: "#b91c1c", outline: "2px solid #b91c1c" }
                  : undefined
              }
            />
          </label>

          <div style={{ marginTop: "0.75rem" }}>
            <div className="muted" style={{ marginBottom: "0.35rem" }}>
              What failed (tap any - one request)
            </div>
            <div className="toolbar" style={{ flexWrap: "wrap", gap: "0.4rem" }}>
              {FAILED_OPTS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={failed.includes(o.id) ? "btn btn-sm" : "btn secondary btn-sm"}
                  onClick={() => toggleFailed(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {failed.includes("other") ? (
              <label style={{ marginTop: "0.35rem" }}>
                Other detail
                <input
                  value={failedOther}
                  onChange={(e) => setFailedOther(e.target.value)}
                  placeholder="Describe the other part"
                />
              </label>
            ) : null}
          </div>

          <div
            ref={brandRef}
            style={{
              marginTop: "0.65rem",
              borderRadius: 8,
              outline: badField === "brand" ? "2px solid #b91c1c" : undefined,
              padding: badField === "brand" ? "0.35rem" : undefined,
            }}
          >
            <div className="muted" style={{ marginBottom: "0.35rem" }}>
              Brand (locks vendor finder)
            </div>
            <div className="toolbar" style={{ flexWrap: "wrap", gap: "0.35rem" }}>
              {(["lennox", "daikin", "carrier", "other"] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  className={brand === b ? "btn btn-sm" : "btn secondary btn-sm"}
                  onClick={() => setBrand(b)}
                >
                  {b === "lennox" ? "Lennox" : b === "daikin" ? "Daikin" : b === "carrier" ? "Carrier" : "Other"}
                </button>
              ))}
            </div>
            {brandMeta?.finderUrl ? (
              <p className="muted" style={{ marginTop: "0.35rem" }}>
                Finder (phase-2 live): {brandMeta.finderUrl}
              </p>
            ) : brand === "other" ? (
              <p className="muted" style={{ marginTop: "0.35rem" }}>
                Other - no auto finder. Never guess Cat # across houses.
              </p>
            ) : null}
          </div>

          <label style={{ marginTop: "0.75rem" }}>
            Job site address = PO reference
            <input
              ref={addressRef}
              value={jobAddress}
              onChange={(e) => setJobAddress(e.target.value)}
              placeholder="Street address for PO label"
              autoComplete="street-address"
              style={
                badField === "address"
                  ? { borderColor: "#b91c1c", outline: "2px solid #b91c1c" }
                  : undefined
              }
            />
          </label>
          <p className="muted">Do not invent a PO number - the address string is the PO.</p>

          <label className="check-row" style={{ marginTop: "0.65rem" }}>
            <input
              type="checkbox"
              checked={needsInstall}
              onChange={(e) => setNeedsInstall(e.target.checked)}
            />
            <span>Needs install / schedule (coil turns this on)</span>
          </label>
          <label className="check-row" style={{ marginTop: "0.35rem" }}>
            <input type="checkbox" checked={noCool} onChange={(e) => setNoCool(e.target.checked)} />
            <span>No-cool / emergency - rush, local pickup, get them running</span>
          </label>

          {lookupError ? <div className="error">{lookupError}</div> : null}
          <div className="toolbar" style={{ marginTop: "0.75rem" }}>
            <button type="button" className="btn" disabled={lookupBusy} aria-busy={lookupBusy} onClick={() => void runLookup()}>
              {lookupBusy ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Looking up...
                </>
              ) : (
                "Find parts"
              )}
            </button>
          </div>
          <div ref={resultRef}>
          {lookupBusy ? (
            <div className="card" role="status" style={{ marginTop: "0.75rem" }}>
              <span className="btn-spinner" aria-hidden="true" />
              Looking up parts for {serial.trim()}...
            </div>
          ) : null}
          {lookupError ? <div className="error">{lookupError}</div> : null}
          {lookupDone && lines.length > 0 ? (
            <h2 style={{ fontSize: "1.05rem", marginTop: "0.75rem" }}>
              {lines.length} {lines.length === 1 ? "part" : "parts"} found - Demo stock, not live vendor
            </h2>
          ) : null}
          {stubBanner && lines.length === 0 ? <p className="muted">{stubBanner}</p> : null}
          {finderUrl ? (
            <p className="muted">
              Finder: {finderUrl}{" "}
              <a href={finderUrl} target="_blank" rel="noreferrer">
                open
              </a>
            </p>
          ) : null}
          {lookupDone && lines.length === 0 && !lookupBusy ? (
            <div className="card" style={{ marginTop: "0.75rem" }}>
              <strong>No parts yet - office will research. Your request can still be sent.</strong>
              <div className="toolbar" style={{ marginTop: "0.5rem" }}>
                <button
                  type="button"
                  className="btn"
                  disabled={orderBusy}
                  onClick={() => void sendToOffice()}
                >
                  {orderBusy ? "Sending..." : "Send to office"}
                </button>
              </div>
            </div>
          ) : null}

          {lines.length > 0 ? (
            <ul className="card" style={{ listStyle: "none", padding: "0.5rem 0.75rem" }}>
              {lines.map((ln) => {
                const pickupKnown = ln.pickupQty != null && Number.isFinite(Number(ln.pickupQty));
                const localPickup = pickupKnown && Number(ln.pickupQty) > 0;
                const liveAvailable = ln.source !== "stub" && ln.availability === "available";
                return (
                  <li
                    key={ln.lineKey}
                    style={{ padding: "0.55rem 0", borderBottom: "1px solid var(--line)" }}
                  >
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={Boolean(selected[ln.lineKey])}
                        onChange={(e) =>
                          setSelected((s) => ({ ...s, [ln.lineKey]: e.target.checked }))
                        }
                      />
                      <div style={{ flex: 1 }}>
                        <div>
                          <strong>{ln.description || "Part"}</strong>
                          {ln.oem ? ` - ${ln.oem}` : ""}
                        </div>
                        <div>
                          {ln.catNumber ? ln.catNumber : "Cat # pending - not guessed"}
                        </div>
                        <div style={{ fontSize: "1.05rem", fontWeight: 800 }}>
                          Pickup: {pickupKnown ? ln.pickupQty : "lookup pending"}
                          {" - "}
                          Shipping:{" "}
                          {ln.shippingStatus === "lookup_pending"
                            ? "lookup pending"
                            : ln.shippingStatus || "lookup pending"}
                        </div>
                        <div className="muted">
                          {ln.vendor}
                          {ln.source === "stub" ? " - not live vendor" : ""}
                        </div>
                        {liveAvailable && localPickup ? (
                          <span className="muted">Available - order it (prefer local pickup)</span>
                        ) : liveAvailable ? (
                          <span className="muted">Available - request ship</span>
                        ) : (
                          <span className="muted">Lookup pending - stock not invented</span>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {lines.length > 0 ? (
            <div
              ref={orderRef}
              className="toolbar"
              style={{
                marginTop: "0.5rem",
                position: "sticky",
                bottom: 0,
                background: "var(--bg, inherit)",
                paddingBottom: "0.5rem",
                zIndex: 2,
              }}
            >
              <button
                type="button"
                className="btn"
                disabled={orderBusy || !selectedLines.length}
                onClick={() => void orderSelected()}
              >
                {orderBusy ? "Submitting..." : "Order now (request)"}
              </button>
            </div>
          ) : null}
          {orderError ? <div className="error">{orderError}</div> : null}
          {orderMsg ? (
            <div className="card" style={{ marginTop: "0.5rem" }}>
              <strong>{orderMsg}</strong>
              <p className="muted">
                Warehouse / Speedy + Chris notified in-app. No vendor checkout. No ST PO minted.
              </p>
              <Link to="/part-in-stock?tab=repair">Stay on Repair</Link>
            </div>
          ) : null}
          </div>

          {openReqs.length > 0 ? (
            <section style={{ marginTop: "1rem" }}>
              <h2 style={{ fontSize: "1.05rem" }}>Repair part orders</h2>
              <ul className="card" style={{ listStyle: "none", padding: "0.5rem 0.75rem" }}>
                {openReqs.map((r) => {
                  const install = Number(r.needs_install || 0) === 1;
                  const picked = Boolean(r.picked_up_at);
                  const scheduled =
                    r.schedule_status === "booked" || r.schedule_status === "return_scheduled";
                  const mine = user?.id === r.user_id;
                  const role = user?.role || "";
                  const staff =
                    role === "admin" ||
                    role === "warehouse" ||
                    role === "office" ||
                    role === "supervisor" ||
                    mine;
                  const miller =
                    role === "admin" ||
                    `${user?.display_name || ""} ${user?.username || ""}`.toLowerCase().includes("miller");
                  return (
                    <li key={r.id} style={{ padding: "0.55rem 0", borderBottom: "1px solid var(--line)" }}>
                      <div>
                        <strong>{r.po_reference}</strong>
                        {Number(r.no_cool || 0) === 1 ? " - RUSH no-cool" : ""}
                      </div>
                      <div className="muted">
                        {r.brand} - serial {r.serial}
                        {r.requested_by_name ? ` - ${r.requested_by_name}` : ""}
                        {install ? " - needs install" : " - tech only"}
                        {picked ? " - picked up" : " - not picked up"}
                        {scheduled ? " - scheduled" : ""}
                      </div>
                      <div className="toolbar" style={{ marginTop: "0.35rem" }}>
                        {!picked && staff ? (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={reqBusy === r.id}
                            onClick={() => void markRequest(r.id, "picked-up")}
                          >
                            {reqBusy === r.id ? "Saving..." : "Picked up"}
                          </button>
                        ) : null}
                        {picked && !scheduled && install && miller ? (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={reqBusy === r.id}
                            onClick={() => void markRequest(r.id, "scheduled")}
                          >
                            Mark install scheduled
                          </button>
                        ) : null}
                        {picked && !scheduled && !install && staff ? (
                          <button
                            type="button"
                            className="btn secondary btn-sm"
                            disabled={reqBusy === r.id}
                            onClick={() => void markRequest(r.id, "scheduled")}
                          >
                            Return to job scheduled
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </section>
      ) : null}

      {tab === "shop" && shopAllowed ? (
        <section style={{ marginTop: "0.75rem" }}>
          <p className="muted">Type a part number or name.</p>
          {shopPreview ? (
            <p className="muted">Preview - tech door off until you enable Stock check for techs.</p>
          ) : null}
          <label>
            Search
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Part number or name"
              autoComplete="off"
            />
          </label>
          {shopError ? <div className="error">{shopError}</div> : null}
          {debounced.length < 2 ? (
            <p className="muted">Type a part number or name</p>
          ) : shopBusy && !parts ? (
            <p className="muted">Searching...</p>
          ) : parts && !parts.length ? (
            <p className="muted">No part in catalog</p>
          ) : (
            <ul className="card" style={{ listStyle: "none", padding: "0.5rem 0.75rem" }}>
              {(parts || []).map((p) => (
                <li key={p.id} style={{ padding: "0.55rem 0", borderBottom: "1px solid var(--line)" }}>
                  <div>
                    <strong>{p.code || "No code"}</strong>
                    {p.name ? ` - ${p.name}` : ""}
                  </div>
                  <div style={{ fontSize: "1.15rem", fontWeight: 800 }}>
                    {!p.qty_tracked ? "Qty not tracked" : `${p.qty_on_hand ?? 0} on hand`}
                  </div>
                  {p.locations.length > 0 ? (
                    <div className="muted">{p.locations.map((l) => `${l.name}: ${l.qty}`).join(" - ")}</div>
                  ) : null}
                  {p.qty_tracked && (p.qty_on_hand ?? 0) === 0 ? (
                    <div className="muted">
                      <Link to="/part-pickup">Will-call</Link>
                      {" - "}
                      <Link to="/tomorrow-materials">Tomorrow materials</Link>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {!repairAllowed && !shopAllowed ? (
        <p className="muted">Part tools are not enabled for your role.</p>
      ) : null}
    </div>
  );
}
