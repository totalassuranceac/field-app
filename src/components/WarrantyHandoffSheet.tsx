import { useEffect, useRef, useState } from "react";
import { api, ApiError, OfflineQueuedError } from "../api";
import { useAuth } from "../auth";
import { PhotoCapture } from "./PhotoCapture";
import { SignaturePad, type SignaturePadHandle } from "./SignaturePad";
import { compressPhoto } from "../lib/compressPhoto";
import {
  buildHandoffForm,
  fmtCt,
  newClientUuid,
  openReceipt,
  startGps,
  type GpsResult,
} from "../vendorHandoff";

export type HandoffAction = "delivered" | "approved_returned" | "solar_invoice_deleted" | "record_only";

export type HandoffCard = {
  id: number;
  log_number?: string | null;
  part_name?: string | null;
  part_code?: string | null;
  rma_number?: string | null;
  vendor_name?: string | null;
  service_address?: string | null;
  customer_name?: string | null;
  status?: string | null;
};

type Person = { id: number; display_name: string };

const ACTION_WORD: Record<HandoffAction, string> = {
  delivered: "Saving will mark Delivered",
  approved_returned: "Saving will mark Approved (returned)",
  solar_invoice_deleted: "Saving will close the Solar return",
  record_only: "Saving stores the proof only",
};

const SAVE_WORD: Record<HandoffAction, string> = {
  delivered: "Save and mark Delivered",
  approved_returned: "Save and mark Approved (returned)",
  solar_invoice_deleted: "Save and close Solar return",
  record_only: "Save proof",
};

function street(addr: string | null | undefined): string {
  const raw = String(addr || "").trim();
  if (!raw) return "";
  return (raw.split(/[\n,]/)[0] || raw).trim();
}

export function WarrantyHandoffSheet({
  card,
  action,
  handoffType,
  sourceType = "warranty",
  supersedes,
  runAction,
  onAdminSkip,
  onDone,
  onCancel,
}: {
  card: HandoffCard;
  action: HandoffAction;
  handoffType: string;
  sourceType?: "warranty" | "parts_arrival";
  supersedes?: { id: number };
  runAction?: () => Promise<void>;
  onAdminSkip?: (reason: string) => Promise<void>;
  onDone: (result: { saved: boolean; queued: boolean; handoff?: { id: number } }) => void;
  onCancel: () => void;
}) {
  const { user } = useAuth();
  const pad = useRef<SignaturePadHandle>(null);
  const uuid = useRef(newClientUuid());
  const gps = useRef(startGps());
  const [vendor, setVendor] = useState(card.vendor_name || "");
  const [branch, setBranch] = useState("");
  const [rep, setRep] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [ink, setInk] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [handedBy, setHandedBy] = useState<number | "">(user?.id || "");
  const [gpsLine, setGpsLine] = useState("Location: getting...");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ id?: number; queued: boolean; summary: string } | null>(null);
  const canPickPerson = user?.role === "admin" || user?.role === "office" || user?.role === "warehouse";
  const dirty = ink || !!photo || rep.trim().length > 0;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const state = { handoff: card.id };
    history.pushState(state, "");
    function onPop() {
      onCancel();
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") askClose();
    }
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
    };
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!canPickPerson) return;
    api<{ users: Person[] }>("/messages/users")
      .then((d) => {
        const rest = d.users || [];
        const me = user ? [{ id: user.id, display_name: user.display_name }] : [];
        setPeople([...me, ...rest.filter((p) => p.id !== user?.id)]);
      })
      .catch(() => setPeople(user ? [{ id: user.id, display_name: user.display_name }] : []));
  }, [canPickPerson, user]);

  useEffect(() => {
    const t = window.setInterval(() => {
      void gps.current.result().then((g) => setGpsLine(gpsText(g)));
    }, 1200);
    void gps.current.result().then((g) => setGpsLine(gpsText(g)));
    return () => window.clearInterval(t);
  }, []);

  function gpsText(g: GpsResult): string {
    if (g.status === "ok" && g.accuracy_m != null) return `Location: +/- ${Math.round(g.accuracy_m)} m`;
    if (g.status === "ok") return "Location: shared";
    if (g.status === "skipped") return "Location: getting...";
    return "Location: not shared - that's OK";
  }

  function askClose() {
    if (saved) {
      onDone({ saved: true, queued: saved.queued, handoff: saved.id ? { id: saved.id } : undefined });
      return;
    }
    if (dirty && !window.confirm("Discard this hand-off?")) return;
    onCancel();
  }

  const valid =
    vendor.trim().length >= 1 &&
    vendor.trim().length <= 80 &&
    rep.trim().length >= 2 &&
    /[A-Za-z]/.test(rep) &&
    ink &&
    !!photo &&
    (!supersedes || reason.trim().length >= 3);

  async function save() {
    if (!valid || !photo || !pad.current) return;
    setBusy(true);
    setError("");
    try {
      const blob = await pad.current.toPngBlob();
      if (!blob) {
        setError("Vendor rep signature is required");
        return;
      }
      const shot = await compressPhoto(photo);
      const where = await gps.current.result();
      const fd = buildHandoffForm(
        {
          client_uuid: uuid.current,
          source_type: sourceType,
          source_id: card.id,
          handoff_type: handoffType,
          rep_name: rep.trim(),
          vendor_name: vendor.trim(),
          vendor_branch: branch.trim(),
          notes: notes.trim(),
          gps_status: where.status === "skipped" ? "skipped" : where.status,
          gps_lat: where.status === "ok" ? where.lat : "",
          gps_lng: where.status === "ok" ? where.lng : "",
          gps_accuracy_m: where.status === "ok" ? where.accuracy_m : "",
          client_captured_at: new Date().toISOString(),
          supersedes_id: supersedes?.id,
          correction_reason: supersedes ? reason.trim() : "",
          handed_by_user_id: handedBy || user?.id || "",
        },
        blob,
        shot
      );
      let queued = false;
      let id: number | undefined;
      try {
        const res = await api<{ handoff?: { id: number }; duplicate?: boolean }>("/handoffs", {
          method: "POST",
          body: fd,
          timeoutMs: 30000,
        });
        id = res.handoff?.id;
      } catch (err) {
        if (err instanceof OfflineQueuedError) queued = true;
        else throw err;
      }
      if (!queued && runAction) await runAction();
      if (queued && runAction) {
        try {
          await runAction();
        } catch (err) {
          if (!(err instanceof OfflineQueuedError)) throw err;
        }
      }
      setSaved({
        id,
        queued,
        summary: `${rep.trim()} · ${fmtCt(new Date().toISOString())} · ${gpsText(where)}`,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    const why = window.prompt("Skip signature (admin). Reason (at least 10 characters):");
    if (why == null) return;
    if (why.trim().length < 10) {
      setError("Admin skip needs at least 10 characters.");
      return;
    }
    if (!onAdminSkip) return;
    setBusy(true);
    try {
      await onAdminSkip(why.trim());
      onDone({ saved: false, queued: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not skip");
    } finally {
      setBusy(false);
    }
  }

  const titleBits = [
    card.log_number,
    card.part_name ? `${card.part_name}${card.part_code ? ` (${card.part_code})` : ""}` : "",
    card.rma_number ? `Claim / RMA #: ${card.rma_number}` : sourceType === "warranty" ? "Claim / RMA #: none on card" : "",
    street(card.service_address),
    card.vendor_name,
  ].filter(Boolean);

  return (
    <div className="vho-sheet" role="dialog" aria-modal="true" aria-label="Vendor hand-off">
      <div className="vho-topbar">
        <button type="button" className="btn ghost btn-sm" onClick={askClose}>
          X
        </button>
        <strong>Vendor hand-off</strong>
        <span className="vho-meta">{ACTION_WORD[action]}</span>
        {user?.role === "admin" && onAdminSkip && !saved ? (
          <button type="button" className="btn ghost btn-sm" onClick={() => void skip()}>
            Skip signature (admin)
          </button>
        ) : null}
      </div>
      <div className="vho-body">
        {supersedes ? <div className="vho-notice">This adds a new record. The original stays.</div> : null}
        <div className="vho-strip">
          {titleBits.map((bit) => (
            <div key={bit}>{bit}</div>
          ))}
        </div>
        {saved ? (
          <div>
            <h2>{saved.queued ? "Saved offline" : `Saved - proof #${saved.id || ""}`}</h2>
            {saved.queued ? (
              <p>
                Saved offline - will send when you have signal. Print the receipt from the card's Proof of hand-off
                block once it has sent.
              </p>
            ) : (
              <p>{saved.summary}</p>
            )}
          </div>
        ) : (
          <>
            <label>
              Vendor
              <input value={vendor} onChange={(e) => setVendor(e.target.value)} />
            </label>
            <label>
              Branch / counter
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="e.g. ACES - Ayers St"
              />
            </label>
            <label>
              Vendor employee: type your printed name
              <input
                value={rep}
                onChange={(e) => setRep(e.target.value)}
                autoComplete="off"
                autoCapitalize="words"
                style={{ fontSize: "1.15rem" }}
              />
            </label>
            {supersedes ? (
              <label>
                Correction reason
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            ) : null}
            <SignaturePad ref={pad} onChange={setInk} disabled={busy} />
            <PhotoCapture
              required
              label="Photo of the part at the counter"
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
              disabled={busy}
            />
            <label>
              Handed off by
              {canPickPerson ? (
                <select value={handedBy} onChange={(e) => setHandedBy(Number(e.target.value))}>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
              ) : (
                <input readOnly value={user?.display_name || ""} />
              )}
            </label>
            <label>
              Notes
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <p className="vho-meta">{gpsLine}</p>
            {error ? <div className="error">{error}</div> : null}
          </>
        )}
      </div>
      <div className="vho-bottombar">
        {saved ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={saved.queued || !saved.id}
              onClick={() => saved.id && openReceipt(saved.id)}
            >
              Print receipt
            </button>
            <button type="button" className="btn secondary" onClick={askClose}>
              Done
            </button>
          </>
        ) : (
          <button type="button" className="btn" disabled={!valid || busy} onClick={() => void save()}>
            {busy ? "Saving..." : SAVE_WORD[action]}
          </button>
        )}
      </div>
    </div>
  );
}
