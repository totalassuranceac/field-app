import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, can, roleLabel } from "../api";
import { useAuth } from "../auth";
import { LogItem, LogList } from "../components/CollapsibleLog";

interface Handbook {
  id: number;
  title: string;
  version_label: string | null;
  file_key: string;
  content_type: string;
  file_size: number | null;
  created_at: string;
  uploaded_by_name?: string | null;
}

interface RosterRow {
  id: number;
  display_name: string;
  role: string;
  acknowledged: boolean;
  acknowledged_at?: string;
}

export function HandbookPage() {
  const { user } = useAuth();
  const canUpload = can(user, "manageEmployees") || user?.role === "admin";
  const isAdmin = user?.role === "admin";
  const [book, setBook] = useState<Handbook | null>(null);
  const [pending, setPending] = useState(false);
  const [ackAt, setAckAt] = useState<string | null>(null);
  const [ackName, setAckName] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("Employee Handbook");
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);

  /** Must open/view handbook before the checkmark is available */
  const [hasViewed, setHasViewed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const load = useCallback(async () => {
    const d = await api<{
      handbook: Handbook | null;
      pending: boolean;
      acknowledged_at?: string | null;
      ack_name?: string | null;
    }>("/handbook");
    setBook(d.handbook);
    setPending(!!d.pending);
    setAckAt(d.acknowledged_at || null);
    setAckName(d.ack_name || null);
    if (!d.pending) {
      setHasViewed(true);
      setConfirmed(true);
    } else {
      setHasViewed(false);
      setConfirmed(false);
    }
    if (canUpload) {
      const s = await api<{ roster: RosterRow[] }>("/handbook/status").catch(() => ({
        roster: [] as RosterRow[],
      }));
      setRoster(s.roster || []);
    }
  }, [canUpload]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose a PDF (or document) to upload.");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", title);
      if (version.trim()) fd.append("version_label", version.trim());
      await api("/handbook", { method: "POST", body: fd });
      setOk("Handbook uploaded. Team will be asked to read and acknowledge.");
      setFile(null);
      setVersion("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge(e: FormEvent) {
    e.preventDefault();
    if (!hasViewed) {
      setError("Open and read the handbook first, then check the box to confirm.");
      return;
    }
    if (!confirmed) {
      setError("Check the box to confirm you have read and understand the handbook.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/handbook/acknowledge", {
        method: "POST",
        body: JSON.stringify({
          handbook_id: book?.id,
          confirmed: true,
          ack_name: user?.display_name || user?.username || "",
        }),
      });
      setOk("Thank you — your acknowledgment is on file.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save acknowledgment");
    } finally {
      setBusy(false);
    }
  }

  const fileUrl = book ? `/api/uploads/${encodeURIComponent(book.file_key)}` : null;
  const pendingCount = roster.filter((r) => !r.acknowledged).length;

  return (
    <div className="page handbook-page">
      <div className="page-header">
        <div>
          <h1>Employee handbook</h1>
          <p>
            Read the company handbook below. When you’re finished, check the box to confirm you
            understand it.
          </p>
        </div>
      </div>
      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {book ? (
        <div className="card handbook-current">
          <div className="handbook-current-top">
            <div>
              <h2 style={{ margin: 0, fontSize: "1.05rem" }}>{book.title}</h2>
              <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.82rem" }}>
                {book.version_label ? `Version ${book.version_label} · ` : ""}
                Uploaded {String(book.created_at).replace("T", " ").slice(0, 16)}
                {book.uploaded_by_name ? ` by ${book.uploaded_by_name}` : ""}
              </p>
            </div>
            {fileUrl && (
              <a
                className="btn"
                href={fileUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => setHasViewed(true)}
              >
                Open full screen
              </a>
            )}
          </div>

          {/* Read first — viewer is always above the confirm control */}
          {fileUrl && book.content_type?.includes("pdf") ? (
            <iframe
              className="handbook-frame"
              title={book.title}
              src={fileUrl}
              onLoad={() => setHasViewed(true)}
            />
          ) : fileUrl ? (
            <p className="muted">
              <a href={fileUrl} target="_blank" rel="noreferrer" onClick={() => setHasViewed(true)}>
                Open the handbook file
              </a>{" "}
              to read it, then confirm below.
            </p>
          ) : null}

          {pending ? (
            <form className="handbook-ack-form" onSubmit={(ev) => void acknowledge(ev)}>
              <h3 className="inv-section-title">Confirm after reading</h3>
              {!hasViewed ? (
                <p className="muted handbook-ack-hint">
                  Scroll through the handbook above (or open full screen). When you’ve finished
                  reading, you can check the box below.
                </p>
              ) : (
                <p className="muted handbook-ack-hint">
                  Check the box only after you have read the handbook.
                </p>
              )}

              <label
                className={`handbook-check-row${!hasViewed ? " is-locked" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={!hasViewed || busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>
                  I have read and understand this handbook
                  {!hasViewed ? (
                    <span className="muted"> — available after you open it</span>
                  ) : null}
                </span>
              </label>

              <button className="btn" type="submit" disabled={busy || !hasViewed || !confirmed}>
                {busy ? "Saving…" : "Submit confirmation"}
              </button>
            </form>
          ) : (
            <div className="handbook-ack-done" role="status">
              <span className="handbook-ack-check" aria-hidden>
                ✓
              </span>
              <div>
                <strong>Confirmed</strong>
                <div className="muted" style={{ fontSize: "0.82rem", fontWeight: 500 }}>
                  {ackAt ? String(ackAt).replace("T", " ").slice(0, 16) : "On file"}
                  {ackName ? ` · ${ackName}` : ""}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {canUpload
              ? "No handbook uploaded yet. Use the form below to add the PDF."
              : "No handbook is available yet. Check back after admin uploads it."}
          </p>
        </div>
      )}

      {canUpload && (
        <>
          <form className="card" onSubmit={(ev) => void upload(ev)}>
            <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Upload / replace handbook</h2>
            <p className="muted" style={{ fontSize: "0.82rem" }}>
              Uploading a new file retires the old one and asks everyone to confirm again. Prefer PDF
              (up to about 20MB).
            </p>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </label>
            <label>
              Version label
              <input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="e.g. 2026-A"
              />
            </label>
            <label>
              File (PDF) *
              <input
                type="file"
                accept="application/pdf,.pdf,image/*"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                required
              />
            </label>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Uploading…" : "Upload handbook"}
            </button>
          </form>

          {roster.length > 0 && (
            <div className="card">
              <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>
                Team confirmations
                <span className="muted" style={{ fontWeight: 500, fontSize: "0.85rem" }}>
                  {" "}
                  · {roster.length - pendingCount} done · {pendingCount} pending
                </span>
              </h2>
              {isAdmin && (
                <p className="muted" style={{ margin: "0 0 0.65rem", fontSize: "0.82rem" }}>
                  To require someone to re-read and sign again, clear their acknowledgment under{" "}
                  <strong>Admin → People &amp; settings → Handbook acknowledgments</strong> (not
                  here — avoids accidental clears).
                </p>
              )}
              <LogList>
                {roster.map((r) => (
                  <LogItem
                    key={r.id}
                    tone={r.acknowledged ? "ok" : "warn"}
                    summary={
                      <div className="handbook-roster-row">
                        <div className="handbook-roster-main">
                          <strong>{r.display_name}</strong>
                          <span className="log-item-badge">
                            {r.acknowledged ? "Confirmed" : "Pending"}
                          </span>
                          <span className="log-item-meta">
                            {roleLabel(r.role as never) || r.role}
                          </span>
                          {r.acknowledged_at ? (
                            <span className="log-item-meta">
                              {String(r.acknowledged_at).replace("T", " ").slice(0, 16)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    }
                  />
                ))}
              </LogList>
            </div>
          )}
        </>
      )}
    </div>
  );
}
