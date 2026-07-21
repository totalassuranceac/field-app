import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, can } from "../api";
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
  const [book, setBook] = useState<Handbook | null>(null);
  const [pending, setPending] = useState(false);
  const [ackAt, setAckAt] = useState<string | null>(null);
  const [ackName, setAckName] = useState(user?.display_name || "");
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("Employee Handbook");
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    const d = await api<{
      handbook: Handbook | null;
      pending: boolean;
      acknowledged_at?: string | null;
    }>("/handbook");
    setBook(d.handbook);
    setPending(!!d.pending);
    setAckAt(d.acknowledged_at || null);
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
    if (!ackName.trim()) {
      setError("Type your full name to confirm you read the handbook.");
      return;
    }
    if (
      !confirm(
        `I confirm I have read and understand “${book?.title || "the employee handbook"}”.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/handbook/acknowledge", {
        method: "POST",
        body: JSON.stringify({
          handbook_id: book?.id,
          ack_name: ackName.trim(),
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
            Read the company handbook in the app and acknowledge that you understand it. New
            versions require a fresh acknowledgment.
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
              <a className="btn" href={fileUrl} target="_blank" rel="noreferrer">
                Open handbook
              </a>
            )}
          </div>
          {fileUrl && book.content_type?.includes("pdf") && (
            <iframe
              className="handbook-frame"
              title={book.title}
              src={fileUrl}
            />
          )}

          {pending ? (
            <form className="handbook-ack-form" onSubmit={acknowledge}>
              <h3 className="inv-section-title">Acknowledge</h3>
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                After you’ve read the handbook, type your name and confirm. This is logged with the
                date and time for company records.
              </p>
              <label>
                Full name (as signature) *
                <input
                  value={ackName}
                  onChange={(e) => setAckName(e.target.value)}
                  required
                  autoComplete="name"
                />
              </label>
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Saving…" : "I have read and understand the handbook"}
              </button>
            </form>
          ) : (
            <div className="handbook-ack-done">
              ✓ Acknowledged
              {ackAt ? ` · ${String(ackAt).replace("T", " ").slice(0, 16)}` : ""}
              {ackName ? ` as ${ackName}` : ""}
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
          <form className="card" onSubmit={upload}>
            <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Upload / replace handbook</h2>
            <p className="muted" style={{ fontSize: "0.82rem" }}>
              Uploading a new file retires the old one and asks everyone to acknowledge again. Prefer
              PDF. Keep under ~900KB without R2 storage, or enable R2 for larger files.
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
                Acknowledgments
                <span className="muted" style={{ fontWeight: 500, fontSize: "0.85rem" }}>
                  {" "}
                  · {roster.length - pendingCount} done · {pendingCount} pending
                </span>
              </h2>
              <LogList>
                {roster.map((r) => (
                  <LogItem
                    key={r.id}
                    tone={r.acknowledged ? "ok" : "warn"}
                    summary={
                      <>
                        <strong>{r.display_name}</strong>
                        <span className="log-item-badge">
                          {r.acknowledged ? "Done" : "Pending"}
                        </span>
                        <span className="log-item-meta">{r.role}</span>
                        {r.acknowledged_at ? (
                          <span className="log-item-meta">
                            {String(r.acknowledged_at).replace("T", " ").slice(0, 16)}
                          </span>
                        ) : null}
                      </>
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
