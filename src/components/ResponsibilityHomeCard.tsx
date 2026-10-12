import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

type HomeStatus = {
  self?: boolean;
  vehicle?: { required?: boolean; status?: string };
  cards?: { status?: string; card_last4?: string | null }[];
  roster?: {
    vehicle_missing?: { user_id: number }[];
    cards_waiting?: { id: number }[];
  } | null;
};

/** Home prompt until the vehicle form and any issued card are signed. */
export function ResponsibilityHomeCard() {
  const { user } = useAuth();
  const [status, setStatus] = useState<HomeStatus | null>(null);

  useEffect(() => {
    if (!user || user.role === "viewer") return;
    let cancelled = false;
    api<HomeStatus>("/responsibility/status")
      .then((row) => {
        if (!cancelled) setStatus(row);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user || user.role === "viewer" || !status) return null;

  const vehicleDue = Boolean(status.vehicle?.required && status.vehicle.status !== "signed");
  const waitingCards = (status.cards || []).filter((row) => row.status === "needed");
  const vehicleMissing = status.roster?.vehicle_missing?.length || 0;
  const cardsWaiting = status.roster?.cards_waiting?.length || 0;
  const officeDue = vehicleMissing + cardsWaiting > 0;
  const hasSigned =
    status.vehicle?.status === "signed" ||
    (status.cards || []).some((row) => row.status === "signed");
  const drives = user.role === "driver" || user.role === "mechanic";

  if (!vehicleDue && waitingCards.length === 0 && !officeDue) {
    if (!hasSigned && !drives) return null;
    return (
      <p className="muted" style={{ margin: "0 0 0.85rem" }}>
        <Link to="/responsibility">Card and vehicle forms</Link>
      </p>
    );
  }

  return (
    <section className="card safety-new-hire-home" aria-label="Card and vehicle forms">
      {vehicleDue ? (
        <Link to="/responsibility?kind=vehicle">
          <strong>Sign the company vehicle form</strong>
          <span className="muted"> Your signature is the record that you will treat company trucks the way we require.</span>
        </Link>
      ) : null}
      {waitingCards.map((row, index) => (
        <Link key={`${row.card_last4 || "card"}-${index}`} to="/responsibility?kind=card">
          <strong>
            Sign for company card{row.card_last4 ? ` ending ${row.card_last4}` : ""}
          </strong>
          <span className="muted"> Your signature marks you responsible for that card.</span>
        </Link>
      ))}
      {officeDue ? (
        <Link to="/responsibility">
          <strong>Signatures still open</strong>
          <span className="muted">
            {" "}
            {vehicleMissing} vehicle {vehicleMissing === 1 ? "form" : "forms"}, {cardsWaiting}{" "}
            {cardsWaiting === 1 ? "card" : "cards"}.
          </span>
        </Link>
      ) : null}
    </section>
  );
}
