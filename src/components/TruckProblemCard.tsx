import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, OfflineQueuedError } from "../api";
import { useAuth } from "../auth";
import { DRIVER_ISSUE_OPTIONS } from "../issueCatalog";
import { PhotoCapture } from "./PhotoCapture";
import { VehicleQuickPick, type VehicleMatch } from "./VehicleQuickPick";
import { compressPhoto } from "../lib/compressPhoto";
import { newClientUuid } from "../vendorHandoff";

const PRIMARY = ["warning_light", "flat_tire", "brakes", "wont_start", "ac_heat", "noise", "oil_leak", "overheating", "other"] as const;

export function TruckProblemCard() {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<VehicleMatch[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [different, setDifferent] = useState(false);
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get("category") || "");
  const [more, setMore] = useState(() => {
    const cat = new URLSearchParams(window.location.search).get("category") || "";
    return Boolean(cat) && !(PRIMARY as readonly string[]).includes(cat);
  });
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [down, setDown] = useState(
    () => new URLSearchParams(window.location.search).get("category") === "flat_tire"
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const uuid = useState(() => newClientUuid())[0];

  useEffect(() => {
    api<{ vehicles?: VehicleMatch[] } | VehicleMatch[]>("/vehicles")
      .then((d) => {
        const list = Array.isArray(d) ? d : d.vehicles || [];
        const active = list.filter((v) => v.status !== "retired");
        setVehicles(active);
        const name = (user?.display_name || "").toLowerCase();
        const fromUrl = new URLSearchParams(window.location.search).get("vehicle");
        const home = active.find((v) => (v.assigned_driver || v.driver_name || "").toLowerCase() === name);
        if (fromUrl && active.some((v) => String(v.id) === fromUrl)) setVehicleId(fromUrl);
        else if (home) setVehicleId(String(home.id));
      })
      .catch(() => setVehicles([]));
  }, [user?.display_name]);

  const tiles = more ? DRIVER_ISSUE_OPTIONS : DRIVER_ISSUE_OPTIONS.filter((o) => (PRIMARY as readonly string[]).includes(o.value));
  const picked = DRIVER_ISSUE_OPTIONS.find((o) => o.value === code);

  async function send() {
    if (!vehicleId || !code) return;
    setBusy(true);
    setError("");
    try {
      let photoKey = "";
      if (photo) {
        const shot = await compressPhoto(photo);
        const fd = new FormData();
        fd.set("file", shot);
        fd.set("folder", "issue-photos");
        const up = await api<{ key: string }>("/uploads/receipt", { method: "POST", body: fd, timeoutMs: 30000 });
        photoKey = up.key;
      }
      const res = await api<{ id?: number; message?: string }>("/fleet-shop/report", {
        method: "POST",
        timeoutMs: 30000,
        body: JSON.stringify({
          vehicle_id: Number(vehicleId),
          issue_category: code,
          note: note.slice(0, 200),
          photo_key: photoKey || null,
          truck_down: down || Boolean(picked?.emergency && code === "flat_tire"),
          client_uuid: uuid,
        }),
      });
      setMsg(res.message || (down ? "Marked down. Call the shop if you are stuck on the road." : "Sent to the shop."));
    } catch (err) {
      if (err instanceof OfflineQueuedError) setMsg("Saved offline. It will send when you have signal.");
      else setError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="fs-card">
      <h2>Truck problem</h2>
      <p className="muted">Three taps. The shop sees it on Fleet Shop. No text is sent.</p>
      {msg ? (
        <div className="success">
          <p>{msg}</p>
          {user && ["admin", "office", "warehouse", "supervisor"].includes(user.role) ? (
            <p>
              <Link to={`/warehouse-cameras?at=${encodeURIComponent(new Date().toISOString())}`}>
                Clips around this time
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      <VehicleQuickPick
        vehicles={vehicles}
        value={vehicleId}
        onChange={setVehicleId}
        label="Your truck"
        showDropdown={different}
      />
      <button type="button" className="btn ghost btn-sm" onClick={() => setDifferent((v) => !v)}>
        Different truck
      </button>
      <div className="fs-tiles">
        {tiles.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`fs-tile${code === opt.value ? " is-on" : ""}`}
            onClick={() => {
              setCode(opt.value);
              if (opt.value === "flat_tire") setDown(true);
            }}
          >
            {opt.value === "other" && !more ? "More..." : opt.label}
          </button>
        ))}
      </div>
      {!more ? (
        <button type="button" className="btn ghost btn-sm" onClick={() => setMore(true)}>
          More...
        </button>
      ) : null}
      <label>
        Note (optional)
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </label>
      <PhotoCapture
        label="Photo (optional)"
        previewUrl={preview}
        onPick={(f) => {
          setPhoto(f);
          if (preview) URL.revokeObjectURL(preview);
          setPreview(f ? URL.createObjectURL(f) : null);
        }}
        onClear={() => {
          setPhoto(null);
          if (preview) URL.revokeObjectURL(preview);
          setPreview(null);
        }}
      />
      <label>
        <input type="checkbox" checked={down} onChange={(e) => setDown(e.target.checked)} /> Truck can't be driven
      </label>
      <button type="button" className="btn" disabled={busy || !vehicleId || !code} onClick={() => void send()}>
        {busy ? "Sending..." : "Send"}
      </button>
    </section>
  );
}
