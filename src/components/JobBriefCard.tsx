import { useState } from "react";
import { api, ApiError } from "../api";

type Note = { code: string; level: string; text: string };
type Brief = {
  st_job_id: string;
  job_number: string | null;
  built_at: string;
  cached: boolean;
  lines: string[];
  notes: Note[];
  past_jobs: { job_number: string | null; date: string | null; job_type: string | null; summary: string | null }[];
  warranty: { log_number: string; part_name: string | null; status: string }[];
  equipment: { unit_role: string; manufacturer: string | null; model_number: string | null; mfg_year: number | null; tonnage: number | null }[];
  open_estimates: { count: number; names: string[] };
  ai_text: string | null;
  missing: string[];
  ai_reason?: string;
};

function label(level: string): string {
  if (level === "bring") return "Bring:";
  if (level === "heads_up") return "Heads up:";
  return "Talk:";
}

export function JobBriefCard({ stJobId, aiEnabled }: { stJobId: string; aiEnabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(refresh = false) {
    setBusy(true);
    setError("");
    try {
      const path = `/tech/brief/${encodeURIComponent(stJobId)}${refresh ? "?refresh=1" : ""}`;
      const row = await api<Brief>(path);
      setBrief(row);
      setOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not load the brief");
    } finally {
      setBusy(false);
    }
  }

  function listen() {
    if (!brief || !("speechSynthesis" in window)) return;
    const text = brief.ai_text || brief.lines.join(". ");
    if (!text) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "en-US";
    window.speechSynthesis.speak(utter);
  }

  async function shortVersion() {
    setBusy(true);
    setError("");
    try {
      const row = await api<Brief>(`/tech/brief/${encodeURIComponent(stJobId)}/ai`, { method: "POST", body: "{}" });
      setBrief(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not shorten");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="job-brief" style={{ marginTop: "0.6rem" }}>
      {!open ? (
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void load(false)}>
          {busy ? "Loading..." : "Job brief"}
        </button>
      ) : (
        <div className="card" style={{ padding: "0.7rem" }}>
          <strong>Job brief</strong>
          {brief?.cached ? <span className="muted"> (saved copy)</span> : null}
          {error ? <p className="muted">{error}</p> : null}
          {(brief?.lines || []).map((line) => (
            <p key={line} style={{ margin: "0.35rem 0" }}>{line}</p>
          ))}
          {(brief?.notes || []).map((n) => (
            <div key={n.code} className={`job-note job-note-${n.level}`} role="note">
              <strong>{label(n.level)}</strong> {n.text}
            </div>
          ))}
          {(brief?.past_jobs || []).length ? (
            <ul>
              {brief?.past_jobs.map((p) => (
                <li key={`${p.job_number}-${p.date}`}>
                  #{p.job_number || "?"} {p.job_type || "job"} {p.summary || ""}
                </li>
              ))}
            </ul>
          ) : null}
          {(brief?.missing || []).length ? (
            <p className="muted">Not available: {brief?.missing.join(", ")}</p>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.4rem" }}>
            {"speechSynthesis" in window ? (
              <button type="button" className="btn secondary" onClick={listen}>Listen</button>
            ) : null}
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void load(true)}>
              {busy ? "Loading..." : "Refresh"}
            </button>
            {aiEnabled ? (
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void shortVersion()}>
                Short version
              </button>
            ) : null}
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
      {!open && error ? <p className="muted">{error}</p> : null}
    </div>
  );
}
