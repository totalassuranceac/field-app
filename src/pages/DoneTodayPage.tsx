import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

type Item = { at?: string; time_ct?: string; text: string; kind?: string; link?: string | null; source?: string };
type Extra = { id: number; body: string; input?: string };
type Person = { id: number; display_name: string; count: number; first_at?: string | null; last_at?: string | null };

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function todayCt(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function DoneTodayPage() {
  const { user } = useAuth();
  const all = can(user, "viewDoneTodayAll");
  const [day, setDay] = useState(todayCt);
  const [header, setHeader] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [who, setWho] = useState<number | "me">("me");
  const [text, setText] = useState("");
  const [spoken, setSpoken] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [splitBy, setSplitBy] = useState("rules");
  const [micOn, setMicOn] = useState(false);
  const [error, setError] = useState("");
  const [extraNote, setExtraNote] = useState("");
  const speechOk = typeof window !== "undefined" && Boolean((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);
  const today = todayCt();
  const readOnly = all && who !== "me";

  async function load() {
    if (readOnly && typeof who === "number") {
      const d = await api<{ header: string | null; items: Item[]; extras: Extra[] }>(`/done-today/user/${who}?day=${day}`);
      setHeader(d.header);
      setItems(d.items || []);
      setExtras(d.extras || []);
      return;
    }
    const d = await api<{ header: string | null; items: Item[]; extras: Extra[]; ready?: boolean }>(`/done-today?day=${day}`);
    setHeader(d.header);
    setItems(d.items || []);
    setExtras(d.extras || []);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "Could not load"));
  }, [day, who]);

  useEffect(() => {
    if (!all) return;
    api<{ people: Person[] }>(`/done-today/people?day=${day}`).then((d) => setPeople(d.people || [])).catch(() => setPeople([]));
  }, [all, day]);

  function listen() {
    const Ctor = (window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }).SpeechRecognition
      || (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let said = "";
      for (let i = 0; i < ev.results.length; i++) said += ev.results[i][0].transcript;
      setText(said);
      setSpoken(true);
    };
    rec.onend = () => setMicOn(false);
    setMicOn(true);
    rec.start();
  }

  const oldest = shiftDay(today, -31);

  return (
    <div className="fs-page">
      <h1>Done today</h1>
      <p>Filled in automatically from what you did in the app.</p>
      <div className="fs-top">
        <button type="button" className="btn secondary btn-sm" disabled={day <= oldest} onClick={() => setDay(shiftDay(day, -1))}>Back</button>
        <strong>{day}</strong>
        <button type="button" className="btn secondary btn-sm" disabled={day >= today} onClick={() => setDay(shiftDay(day, 1))}>Forward</button>
      </div>
      {header ? <p>Clock: {header}</p> : null}
      {all ? (
        <>
          <label>
            Person
            <select value={String(who)} onChange={(e) => setWho(e.target.value === "me" ? "me" : Number(e.target.value))}>
              <option value="me">Me</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.display_name} ({p.count})</option>
              ))}
            </select>
          </label>
          <table className="fs-table">
            <thead><tr><th>Name</th><th>Items</th><th>First</th><th>Last</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}><td>{p.display_name}</td><td>{p.count}</td><td>{p.first_at || ""}</td><td>{p.last_at || ""}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      <ul>
        {items.map((item, i) => (
          <li key={`${item.at || ""}-${i}`}>
            {item.time_ct || ""} {item.text}{" "}
            {item.link ? <Link to={item.link} aria-label="Open">open</Link> : null}
          </li>
        ))}
      </ul>
      <h2>Extras</h2>
      <ul>
        {extras.map((ex) => (
          <li key={ex.id}>
            {ex.body}
            {!readOnly && day === today ? (
              <button type="button" className="btn ghost btn-sm" onClick={() => void api(`/done-today/extras/${ex.id}`, { method: "DELETE" }).then(load)}>x</button>
            ) : null}
          </li>
        ))}
      </ul>
      {!readOnly && day === today ? (
        <div>
          <h3>+ Add something</h3>
          {extraNote ? <p className="muted">{extraNote}</p> : null}
          <textarea rows={3} value={text} onChange={(e) => { setText(e.target.value); setSpoken(false); }} />
          {speechOk ? (
            <button type="button" className="btn secondary btn-sm" onClick={listen}>{micOn ? "Listening..." : "Mic"}</button>
          ) : null}
          <button
            type="button"
            className="btn secondary"
            onClick={() =>
              void api<{ lines: string[]; split_by: string }>("/done-today/extras/preview", {
                method: "POST",
                body: JSON.stringify({ text, input: spoken ? "spoken" : "typed" }),
              }).then((d) => {
                setPreview(d.lines || []);
                setSplitBy(d.split_by || "rules");
              })
            }
          >
            Preview lines
          </button>
          {preview ? (
            <ul>
              {preview.map((line, i) => (
                <li key={i}>
                  <input
                    value={line}
                    onChange={(e) => setPreview(preview.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                  <button type="button" onClick={() => setPreview(preview.filter((_, j) => j !== i))}>x</button>
                </li>
              ))}
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void api("/done-today/extras", {
                    method: "POST",
                    body: JSON.stringify({ lines: preview, input: spoken ? "spoken" : "typed", split_by: splitBy }),
                  }).then(() => {
                    setPreview(null);
                    setText("");
                    setExtraNote("Saved.");
                    return load();
                  }).catch(() => {
                    setExtraNote("Those lines could not be saved.");
                  })
                }
              >
                Save
              </button>
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type SpeechRec = {
  lang: string;
  interimResults: boolean;
  onresult: (ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  start: () => void;
};
