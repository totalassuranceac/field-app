import { useState } from "react";
import { api } from "../api";

type Boxes = { found: string[]; did: string[]; recommend: string[]; parts: string[] };
type Wrap = Boxes & { id: number; split_by: string; copy_text?: string; copied_at?: string | null };

const EMPTY: Boxes = { found: [], did: [], recommend: [], parts: [] };

export function WrapUpCard({ stJobId }: { stJobId: string }) {
  const [raw, setRaw] = useState("");
  const [input, setInput] = useState<"typed" | "spoken">("typed");
  const [boxes, setBoxes] = useState<Boxes | null>(null);
  const [saved, setSaved] = useState<Wrap | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);

  function mic() {
    const host = window as unknown as {
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const Ctor = host.SpeechRecognition || host.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    const base = raw;
    rec.onresult = (ev) => {
      let said = "";
      for (let i = 0; i < ev.results.length; i++) said += ev.results[i][0].transcript;
      setRaw(`${base} ${said}`.replace(/\s+/g, " ").trim());
      setInput("spoken");
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  }

  async function tidy() {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ wrapup: Wrap }>(`/tech/wrapups`, {
        method: "POST",
        body: JSON.stringify({ st_job_id: stJobId, raw_text: raw, input }),
      });
      setSaved(res.wrapup);
      setBoxes({
        found: res.wrapup.found || [],
        did: res.wrapup.did || [],
        recommend: res.wrapup.recommend || [],
        parts: res.wrapup.parts || [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not tidy");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!saved || !boxes) return;
    setBusy(true);
    setError("");
    try {
      const res = await api<{ wrapup: Wrap }>(`/tech/wrapups/${saved.id}`, {
        method: "PATCH",
        body: JSON.stringify(boxes),
      });
      setSaved(res.wrapup);
      setBoxes({
        found: res.wrapup.found || [],
        did: res.wrapup.did || [],
        recommend: res.wrapup.recommend || [],
        parts: res.wrapup.parts || [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!saved || !boxes) return;
    const text = ["FOUND", "DID", "RECOMMEND", "PARTS"]
      .map((key) => {
        const list = boxes[key.toLowerCase() as keyof Boxes];
        return `${key}: ${list.length ? list.join("; ") : "-"}`;
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Copy failed. Select the text and copy it yourself.");
      return;
    }
    try {
      const res = await api<{ wrapup: Wrap }>(`/tech/wrapups/${saved.id}`, {
        method: "PATCH",
        body: JSON.stringify({ copied: true }),
      });
      setSaved(res.wrapup);
    } catch {
      /* the clipboard already has the text */
    }
  }

  const showMic = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  return (
    <div className="card" style={{ marginTop: "0.6rem", padding: "0.7rem" }}>
      <strong>Wrap-up notes</strong>
      <p className="muted">Nothing is written to ServiceTitan. Copy the four lines and paste them there.</p>
      <textarea value={raw} onChange={(e) => { setRaw(e.target.value); setInput("typed"); }} rows={4} maxLength={4000} placeholder="What you found, what you did, what you recommend, what parts you used" />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.4rem" }}>
        {showMic ? (
          <button type="button" className="btn secondary" onClick={mic} disabled={listening}>
            {listening ? "Listening..." : "Mic"}
          </button>
        ) : null}
        <button type="button" className="btn" disabled={busy || raw.trim().length < 3} onClick={() => void tidy()}>
          {busy ? "Working..." : "Tidy up"}
        </button>
      </div>
      {showMic ? <p className="muted">Chrome sends audio to Google. The keyboard mic works too.</p> : null}
      {boxes ? (
        <div>
          {(["found", "did", "recommend", "parts"] as const).map((key) => (
            <label key={key} style={{ display: "block", marginTop: "0.4rem" }}>
              {key === "found" ? "FOUND" : key === "did" ? "DID" : key === "recommend" ? "RECOMMEND" : "PARTS"}
              <textarea
                rows={2}
                value={boxes[key].join("\n")}
                onChange={(e) => setBoxes({ ...boxes, [key]: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
              />
            </label>
          ))}
          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void save()}>Save</button>
            <button type="button" className="btn secondary" onClick={() => void copy()}>Copy for ServiceTitan</button>
          </div>
          {saved?.copied_at ? <p className="muted">Copied.</p> : null}
        </div>
      ) : null}
      {error ? <p className="muted">{error}</p> : null}
    </div>
  );
}

type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
};
