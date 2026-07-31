import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { PartsReceiptUploadPanel } from "./PartsReceiptUploadPanel";

type OrderStatus = "needed" | "ordered" | "arriving" | "received" | "cancelled";

interface PartsOrderRow {
  id: number;
  part_description: string;
  part_number: string | null;
  status: OrderStatus | string;
  vendor_preference?: string;
  ordered_from?: string | null;
  issue_id?: number | null;
  vehicle_id?: number | null;
}

function statusLabel(s: string): string {
  if (s === "needed") return "Needed";
  if (s === "ordered") return "Ordered";
  if (s === "arriving") return "Arriving";
  if (s === "received") return "Received";
  if (s === "cancelled") return "Cancelled";
  return s;
}

type Props = {
  vehicleId: number;
  unitNumber: string;
  issueId: number;
  issueTitle?: string;
  /** Show receipt upload (in progress + complete) */
  showReceipts: boolean;
  /** Expose receipt count to parent for soft-complete prompt */
  onReceiptCount?: (n: number) => void;
};

/**
 * On a shop job: open parts-orders for this unit + receipt upload.
 */
export function ShopJobPartsPanel({
  vehicleId,
  unitNumber,
  issueId,
  issueTitle,
  showReceipts,
  onReceiptCount,
}: Props) {
  const [orders, setOrders] = useState<PartsOrderRow[]>([]);
  const [actingId, setActingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [receiptCount, setReceiptCount] = useState(0);

  const loadOrders = useCallback(async () => {
    try {
      const d = await api<{ requests: PartsOrderRow[] }>(
        `/parts-orders?view=vehicle&vehicle_id=${vehicleId}`
      );
      const list = d.requests || [];
      // Prefer rows linked to this ticket; always show open unit orders
      const open = list.filter((r) =>
        ["needed", "ordered", "arriving"].includes(r.status)
      );
      const closedForIssue = list.filter(
        (r) =>
          r.issue_id === issueId &&
          (r.status === "received" || r.status === "cancelled")
      );
      const merged = [...open];
      for (const r of closedForIssue) {
        if (!merged.some((x) => x.id === r.id)) merged.push(r);
      }
      setOrders(merged.slice(0, 25));
    } catch {
      setOrders([]);
    }
  }, [vehicleId, issueId]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    onReceiptCount?.(receiptCount);
  }, [receiptCount, onReceiptCount]);

  async function setOrderStatus(id: number, status: OrderStatus) {
    setActingId(id);
    setError("");
    try {
      await api(`/parts-orders/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      setOk(
        status === "received"
          ? "Marked received."
          : status === "ordered"
            ? "Marked ordered."
            : status === "cancelled"
              ? "Order cancelled."
              : "Updated."
      );
      await loadOrders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update order");
    } finally {
      setActingId(null);
    }
  }

  const openOrders = orders.filter((r) =>
    ["needed", "ordered", "arriving"].includes(r.status)
  );
  const orderLink = `/parts-orders?vehicle=${vehicleId}&unit=${encodeURIComponent(
    unitNumber
  )}&issue=${issueId}&desc=${encodeURIComponent((issueTitle || "").slice(0, 80))}`;

  return (
    <div className="shop-job-parts">
      <div className="shop-job-parts-head">
        <strong>Parts for unit {unitNumber}</strong>
        <Link className="btn secondary btn-sm" to={orderLink}>
          Order parts
        </Link>
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      <div className="shop-job-parts-orders">
        <div className="shop-job-parts-subhead">
          Open orders
          {openOrders.length ? ` (${openOrders.length})` : ""}
        </div>
        {!openOrders.length ? (
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            No open parts orders for this unit.
          </p>
        ) : (
          <ul className="shop-job-order-list">
            {openOrders.map((r) => (
              <li key={r.id}>
                <div className="shop-job-order-main">
                  <strong>{r.part_description}</strong>
                  <span className="shop-job-order-status">{statusLabel(r.status)}</span>
                  {r.part_number ? (
                    <span className="muted" style={{ fontSize: "0.8rem" }}>
                      #{r.part_number}
                    </span>
                  ) : null}
                </div>
                <div className="toolbar shop-job-order-actions">
                  {r.status === "needed" && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={actingId === r.id}
                      onClick={() => void setOrderStatus(r.id, "ordered")}
                    >
                      Ordered
                    </button>
                  )}
                  {(r.status === "needed" || r.status === "ordered") && (
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={actingId === r.id}
                      onClick={() => void setOrderStatus(r.id, "arriving")}
                    >
                      Arriving
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn secondary btn-sm"
                    disabled={actingId === r.id}
                    onClick={() => void setOrderStatus(r.id, "received")}
                  >
                    Received
                  </button>
                  <button
                    type="button"
                    className="btn secondary btn-sm"
                    disabled={actingId === r.id}
                    onClick={() => {
                      if (window.confirm("Cancel this parts order?")) {
                        void setOrderStatus(r.id, "cancelled");
                      }
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showReceipts && (
        <PartsReceiptUploadPanel
          vehicleId={vehicleId}
          unitNumber={unitNumber}
          issueId={issueId}
          onSaved={() => {
            setOk("Receipt saved.");
          }}
          onCountChange={(n) => {
            setReceiptCount(n);
            onReceiptCount?.(n);
          }}
        />
      )}
    </div>
  );
}
