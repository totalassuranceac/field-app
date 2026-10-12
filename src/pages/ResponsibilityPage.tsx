import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, roleLabel } from "../api";
import { useAuth } from "../auth";
import { SignaturePad, type SignaturePadHandle } from "../components/SignaturePad";
import { printWithLightTheme } from "../printTheme";
import {
  CARD_CLOSING,
  CARD_LINES,
  VEHICLE_CLOSING,
  VEHICLE_LINES,
  type CardUse,
} from "../responsibilityCopy";

type Ack = {
  id: number;
  kind: string;
  status: string;
  card_last4: string | null;
  card_use: string | null;
  card_use_label: string;
  vehicle_label: string | null;
  shown_text: string;
  signer_name: string | null;
  signed_at: string | null;
  signature_url: string | null;
};

type StatusPayload = {
  self: boolean;
  can_assign: boolean;
  can_void: boolean;
  person: { user_id: number; name: string; role: string; active: boolean };
  vehicle: {
    required: boolean;
    status: "signed" | "needed" | "none";
    label: string;
    ack: Ack | null;
  };
  cards: Ack[];
  roster: null | {
    vehicle_missing: { user_id: number; name: string; role: string }[];
    cards_waiting: {
      id: number;
      user_id: number;
      name: string;
      card_last4: string | null;
      card_use_label: string;
    }[];
  };
};

function signedLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const raw = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16);
  return date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function Sheet({
  printId,
  printingId,
  title,
  children,
}: {
  printId: string;
  printingId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <article className={`resp-sheet${printingId === printId ? " is-printing" : ""}`}>
      <header className="resp-letterhead">
        <img className="resp-logo" src="/logo-form-primary.png" alt="Total Assurance" />
        <div>
          <div className="resp-company">Total Assurance A/C &amp; Heating</div>
          <h2>{title}</h2>
        </div>
      </header>
      {children}
      <p className="resp-footer">Company record. Signed in Field App.</p>
    </article>
  );
}

function SignedBlock({ ack }: { ack: Ack }) {
  return (
    <>
      <pre className="resp-record">{ack.shown_text}</pre>
      {ack.signature_url ? (
        <img className="resp-sign-img" src={ack.signature_url} alt={`Signature of ${ack.signer_name || "employee"}`} />
      ) : null}
      <p className="resp-signed-line">
        Signed {signedLabel(ack.signed_at)}
        {ack.signer_name ? ` by ${ack.signer_name}` : ""}
      </p>
    </>
  );
}

export function ResponsibilityPage() {
  const { user, viewAsPerson } = useAuth();
  const [params] = useSearchParams();
  const requested = Number(params.get("user") || 0);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [printingId, setPrintingId] = useState("");
  const [showCardForm, setShowCardForm] = useState(false);
  const [showVehicleForm, setShowVehicleForm] = useState(false);
  const [last4, setLast4] = useState("");
  const [cardUse, setCardUse] = useState<CardUse | "">("");
  const [assignLast4, setAssignLast4] = useState("");
  const [assignUse, setAssignUse] = useState<CardUse | "">("");
  const [readVehicle, setReadVehicle] = useState(false);
  const [readCard, setReadCard] = useState(false);
  const [inkVehicle, setInkVehicle] = useState(false);
  const [inkCard, setInkCard] = useState(false);
  const vehiclePad = useRef<SignaturePadHandle>(null);
  const cardPad = useRef<SignaturePadHandle>(null);

  const load = useCallback(async () => {
    const query = requested > 0 ? `?user_id=${requested}` : "";
    const row = await api<StatusPayload>(`/responsibility/status${query}`);
    setStatus(row);
  }, [requested]);

  useEffect(() => {
    let cancelled = false;
    setError("");
    load().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Could not load forms");
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function printSheet(id: string) {
    setPrintingId(id);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await printWithLightTheme("print-responsibility");
    setPrintingId("");
  }

  async function sign(kind: "card" | "vehicle") {
    if (viewAsPerson) {
      setError("Exit view-as before signing.");
      return;
    }
    const pad = kind === "vehicle" ? vehiclePad.current : cardPad.current;
    const blob = await pad?.toPngBlob();
    if (!blob) {
      setError("Sign in the box with your finger.");
      return;
    }
    const body = new FormData();
    body.set("kind", kind);
    body.set("read_confirmed", "1");
    body.set("signature", new File([blob], "signature.png", { type: "image/png" }));
    if (kind === "card") {
      body.set("card_last4", last4);
      body.set("card_use", cardUse);
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api("/responsibility/sign", { method: "POST", body });
      setOk(kind === "card" ? "Card form signed." : "Vehicle form signed.");
      setShowCardForm(false);
      setLast4("");
      setCardUse("");
      setReadCard(false);
      setReadVehicle(false);
      pad?.clear();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the signature");
    } finally {
      setBusy(false);
    }
  }

  async function ask(kind: "card" | "vehicle") {
    if (!status) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api("/responsibility/expect", {
        method: "POST",
        body: JSON.stringify({
          user_id: status.person.user_id,
          kind,
          card_last4: kind === "card" ? assignLast4 : undefined,
          card_use: kind === "card" ? assignUse : undefined,
        }),
      });
      setOk(kind === "card" ? "They will see the card form on Home." : "They will see the vehicle form on Home.");
      setAssignLast4("");
      setAssignUse("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not ask for a signature");
    } finally {
      setBusy(false);
    }
  }

  async function clearSignature(ack: Ack) {
    const reason = window.prompt("Why is this signature being cleared?");
    if (!reason) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api(`/responsibility/${ack.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setOk("Signature cleared. They can sign again.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear the signature");
    } finally {
      setBusy(false);
    }
  }

  const vehicleSigned = status?.vehicle.ack?.status === "signed" ? status.vehicle.ack : null;
  const neededCards = (status?.cards || []).filter((row) => row.status === "needed");
  const signedCards = (status?.cards || []).filter((row) => row.status === "signed");
  const cardPrefill = neededCards[0];

  useEffect(() => {
    if (!cardPrefill?.card_last4) return;
    setLast4(cardPrefill.card_last4);
    if (cardPrefill.card_use === "fuel" || cardPrefill.card_use === "parts" || cardPrefill.card_use === "both") {
      setCardUse(cardPrefill.card_use);
    }
    setShowCardForm(true);
  }, [cardPrefill?.id, cardPrefill?.card_last4, cardPrefill?.card_use]);

  return (
    <div className="page resp-page">
      <div className="page-header no-print">
        <div>
          <h1>Card and vehicle forms</h1>
          <p className="muted">
            <Link to="/onboarding">Company forms</Link>
            {status && !status.self ? ` - ${status.person.name}` : ""}
          </p>
          <p>
            The signature is the company record. It names who is responsible for a company card, and who
            agreed to how a company vehicle is used.
          </p>
        </div>
      </div>

      {error ? <div className="error inv-flash no-print">{error}</div> : null}
      {ok ? <div className="success inv-flash no-print">{ok}</div> : null}
      {!status && !error ? <p className="muted no-print">Loading forms...</p> : null}

      {status?.self && status.roster ? (
        <section className="card no-print resp-roster">
          <h2>Waiting on a signature</h2>
          <p className="muted">People still need to sign. This is a checklist, not a ranking.</p>
          <h3>Company vehicle</h3>
          {status.roster.vehicle_missing.length ? (
            <ul className="resp-people">
              {status.roster.vehicle_missing.map((row) => (
                <li key={`v-${row.user_id}`}>
                  <Link to={`/responsibility?user=${row.user_id}`}>{row.name}</Link>
                  <span className="muted"> - {roleLabel(row.role)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>Every driver and the shop have a current vehicle signature.</p>
          )}
          <h3>Company card</h3>
          {status.roster.cards_waiting.length ? (
            <ul className="resp-people">
              {status.roster.cards_waiting.map((row) => (
                <li key={`c-${row.id}`}>
                  <Link to={`/responsibility?user=${row.user_id}`}>{row.name}</Link>
                  <span className="muted">
                    {" "}
                    - card {row.card_last4 ? `ending ${row.card_last4}` : "waiting"}
                    {row.card_use_label ? ` - ${row.card_use_label}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No card is waiting on a signature.</p>
          )}
        </section>
      ) : null}

      {status ? (
        <>
          {status.vehicle.required || vehicleSigned || showVehicleForm ? (
          <Sheet printId="vehicle" printingId={printingId} title="Company vehicle use">
            {vehicleSigned ? (
              <SignedBlock ack={vehicleSigned} />
            ) : (
              <>
                <p>
                  <strong>{status.person.name}</strong>
                  {status.vehicle.label ? ` - ${status.vehicle.label}` : ""}
                </p>
                <ol className="resp-lines">
                  {VEHICLE_LINES.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
                <p>{VEHICLE_CLOSING}</p>
              </>
            )}
          </Sheet>
          ) : null}
          <div className="no-print resp-actions">
            {vehicleSigned ? (
              <>
                <button type="button" className="btn" onClick={() => void printSheet("vehicle")}>
                  Print vehicle form
                </button>
                {status.can_void ? (
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => void clearSignature(vehicleSigned)}>
                    Clear signature
                  </button>
                ) : null}
              </>
            ) : status.self && (status.vehicle.required || showVehicleForm) ? (
              <>
                <label className="resp-check">
                  <input type="checkbox" checked={readVehicle} onChange={(e) => setReadVehicle(e.target.checked)} />
                  I read each line.
                </label>
                <SignaturePad ref={vehiclePad} caption="Employee signs here" onChange={setInkVehicle} disabled={busy} />
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !readVehicle || !inkVehicle || Boolean(viewAsPerson)}
                  onClick={() => void sign("vehicle")}
                >
                  {busy ? "Saving..." : "Sign vehicle form"}
                </button>
              </>
            ) : status.can_assign && status.vehicle.status === "none" ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void ask("vehicle")}>
                Ask {status.person.name} to sign the vehicle form
              </button>
            ) : status.vehicle.status === "none" ? (
              status.self ? (
                <button type="button" className="btn secondary" onClick={() => setShowVehicleForm(true)}>
                  I drive a company vehicle
                </button>
              ) : (
                <p className="muted">This login is not marked as driving a company vehicle.</p>
              )
            ) : (
              <p className="muted">Waiting for {status.person.name} to sign. They will see it on Home.</p>
            )}
          </div>

          {signedCards.map((ack) => (
            <div key={ack.id}>
              <Sheet printId={`card-${ack.id}`} printingId={printingId} title="Company credit card responsibility">
                <SignedBlock ack={ack} />
              </Sheet>
              <div className="no-print resp-actions">
                <button type="button" className="btn" onClick={() => void printSheet(`card-${ack.id}`)}>
                  Print card ending {ack.card_last4}
                </button>
                {status.can_void ? (
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => void clearSignature(ack)}>
                    Clear signature
                  </button>
                ) : null}
              </div>
            </div>
          ))}

          {status.self && (showCardForm || neededCards.length > 0) ? (
            <>
              <Sheet printId="card-draft" printingId={printingId} title="Company credit card responsibility">
                <p>
                  <strong>{status.person.name}</strong>
                  {last4.length === 4 ? ` - card ending ${last4}` : ""}
                </p>
                <ol className="resp-lines">
                  {CARD_LINES.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
                <p>{CARD_CLOSING}</p>
              </Sheet>
              <div className="no-print resp-actions">
                <label>
                  Last 4 of the company card
                  <input
                    inputMode="numeric"
                    maxLength={4}
                    value={last4}
                    onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  />
                </label>
                <label>
                  Used for
                  <select value={cardUse} onChange={(e) => setCardUse(e.target.value as CardUse | "")}>
                    <option value="">Choose</option>
                    <option value="fuel">Fuel</option>
                    <option value="parts">Parts and materials</option>
                    <option value="both">Fuel and parts</option>
                  </select>
                </label>
                <label className="resp-check">
                  <input type="checkbox" checked={readCard} onChange={(e) => setReadCard(e.target.checked)} />
                  I read each line.
                </label>
                <SignaturePad ref={cardPad} caption="Employee signs here" onChange={setInkCard} disabled={busy} />
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !readCard || !inkCard || last4.length !== 4 || !cardUse || Boolean(viewAsPerson)}
                  onClick={() => void sign("card")}
                >
                  {busy ? "Saving..." : "Sign card form"}
                </button>
              </div>
            </>
          ) : null}

          {status.self && !showCardForm && neededCards.length === 0 ? (
            <p className="no-print">
              <button type="button" className="btn secondary" onClick={() => setShowCardForm(true)}>
                I have a company card
              </button>
            </p>
          ) : null}

          {status.can_assign ? (
            <section className="card no-print">
              <h2>Ask {status.person.name} to sign for a card</h2>
              <p className="muted">They sign on their own phone. This page does not sign for them.</p>
              <div className="resp-assign">
                <label>
                  Last 4
                  <input
                    inputMode="numeric"
                    maxLength={4}
                    value={assignLast4}
                    onChange={(e) => setAssignLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  />
                </label>
                <label>
                  Used for
                  <select value={assignUse} onChange={(e) => setAssignUse(e.target.value as CardUse | "")}>
                    <option value="">Choose</option>
                    <option value="fuel">Fuel</option>
                    <option value="parts">Parts and materials</option>
                    <option value="both">Fuel and parts</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || assignLast4.length !== 4 || !assignUse}
                  onClick={() => void ask("card")}
                >
                  Ask them to sign
                </button>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
