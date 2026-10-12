import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

type TrackChoice = { id: string; label: string; note: string };

type ToolRow = {
  id: string;
  name: string;
  use: string;
  easier: string;
  tip: string;
  loan_name: string;
  loan_reason: string;
  have: boolean;
  needs_upgrade: boolean;
  buy_next: boolean;
  upgrade_ask: string;
  upgrade_better: string;
  make: string;
  model: string;
  serial: string;
  notes: string;
  step?: number;
  current?: boolean;
  open_lend?: { id: number; holder_name: string; lent_at: string; days: number } | null;
  last_return?: { holder_name: string; returned_at: string } | null;
  released?: boolean;
};

type LendRow = {
  id: number;
  item_id: string;
  name: string;
  owner_name: string;
  holder_name: string;
  lent_at: string;
  days: number;
  serial?: string;
};

type BottleRow = {
  id: number;
  bottle_type: string;
  serial: string;
  owner_name: string;
  unit_number: string;
  status: string;
  notes: string;
};

type LeftRow = {
  display_name: string;
  name: string;
  make: string;
  model: string;
  serial: string;
  released_at: string;
};

type ToolDraft = { make: string; model: string; serial: string; notes: string };

type ToolPayload = {
  track: string | null;
  suggested_track: string | null;
  position_title: string | null;
  track_note: string;
  tracks: TrackChoice[];
  next_item_id: string | null;
  goals: ToolRow[];
  goals_owned: number;
  goals_total: number;
  owned: number;
  total: number;
  groups: { name: string; items: ToolRow[] }[];
  filed: ToolRow[];
  recommended_because?: string;
  lends_out?: LendRow[];
  borrowed?: LendRow[];
  bottles?: BottleRow[];
  team_out?: LendRow[] | null;
  left_with?: LeftRow[] | null;
  truck_note: string;
  error?: string;
};

type TopicRow = { key: string; label: string; score: number | null; ok: boolean };

type ExamRow = {
  key: string;
  label: string;
  blurb: string;
  recommended: boolean;
  status: "learning" | "close" | "ready";
  status_label: string;
  can_mark: boolean;
  marked: boolean;
  topics_ok: boolean;
  fulls_ok: boolean;
  recent_full_score: number | null;
  topics: TopicRow[];
};

type NatePayload = {
  track: string | null;
  exams: ExamRow[];
  office: OfficeRow[] | null;
  pass_note: string;
  error?: string;
};

type OfficeRow = {
  user_id: number;
  display_name: string;
  position_title: string | null;
  exam_key: string;
  label: string;
  status: string;
  status_label: string;
  recent_full_score: number | null;
};

type PaperQ = { id: string; topic: string; prompt: string; choices: string[] };

type Paper = {
  paper_id: number;
  mode: string;
  minutes: number | null;
  questions: PaperQ[];
};

type GradeDetail = {
  id: string;
  prompt: string;
  choices: string[];
  ok: boolean;
  your_choice: number | null;
  answer: number;
  why: string;
};

function pct(score: number | null): string {
  if (score == null || !Number.isFinite(score)) return "Not yet";
  return `${Math.round(score * 100)}%`;
}

function examProgressLabel(row: ExamRow): string {
  const started =
    row.recent_full_score != null || row.topics.some((topic) => topic.score != null);
  if (!started) return "Not started";
  return row.status_label;
}

function nextNateGoal(exam: ExamRow): { title: string; detail: string } {
  const openTopic = exam.topics.find((topic) => !topic.ok);
  const met = exam.topics.filter((topic) => topic.ok).length;
  if (exam.status === "ready") {
    return {
      title: "Ready to schedule",
      detail:
        "Your practice is in the range for the real test. A short review keeps it fresh. A high score is not a promise you will pass.",
    };
  }
  if (exam.can_mark && !exam.marked) {
    return {
      title: "Mark that you feel ready",
      detail:
        "The scores are in range. The ready mark is yours to set when you want to schedule. It is not a promise you will pass.",
    };
  }
  if (openTopic) {
    const last =
      openTopic.score == null
        ? "This topic has no quiz yet."
        : `Last quiz was ${pct(openTopic.score)}.`;
    return {
      title: `Topic goal: ${openTopic.label}`,
      detail: `${last} The goal is 70% or better. ${met} of ${exam.topics.length} topics are there.`,
    };
  }
  return {
    title: "Two strong full practices",
    detail: exam.fulls_ok
      ? "Full practices are in range. A newer topic quiz can move you back, so check the list."
      : "Every topic is at 70% or better. Next, two full practices in a row at 80% or better (12 of 15).",
  };
}

function goalNumber(goals: ToolRow[], id: string): number {
  const index = goals.findIndex((item) => item.id === id);
  return index < 0 ? 0 : index + 1;
}

function afterGoal(goals: ToolRow[], id: string): ToolRow | null {
  const index = goals.findIndex((item) => item.id === id);
  if (index < 0) return null;
  return goals[index + 1] || null;
}

function loanHref(item: ToolRow): string {
  const q = new URLSearchParams();
  q.set("item", item.loan_name || item.name);
  if (item.loan_reason) q.set("purpose", item.loan_reason);
  return `/tool-loans?${q.toString()}`;
}

function emptyDraft(): ToolDraft {
  return { make: "", model: "", serial: "", notes: "" };
}

function ToolAsk({
  item,
  busy,
  onAnswer,
  onLeave,
}: {
  item: ToolRow;
  busy: boolean;
  onAnswer: (item: ToolRow, older: boolean) => void;
  onLeave: () => void;
}) {
  return (
    <div className="growth-ask">
      <p>{item.upgrade_ask}</p>
      <div className="growth-row-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => onAnswer(item, false)}>
          Yes
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          onClick={() => onAnswer(item, true)}
        >
          I have an older one
        </button>
        <button type="button" className="btn secondary" disabled={busy} onClick={onLeave}>
          Leave it on my list
        </button>
      </div>
      <p className="muted">
        Yes files this one and takes it off the list. An older one stays here until you get{" "}
        {item.upgrade_better}.
      </p>
    </div>
  );
}

export function ToolChecklistPage() {
  return <ToolChecklist />;
}

export function NateStudyPage() {
  return <NateStudy />;
}

function bottleLabel(code: string): string {
  if (code === "N2") return "Nitrogen";
  if (code === "O2") return "Oxygen";
  if (code === "ACE") return "Acetylene";
  return code;
}

function ToolChecklist() {
  const { user } = useAuth();
  const officeCustody = can(user, "viewToolCustody");
  const [data, setData] = useState<ToolPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [askingId, setAskingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ToolDraft>>({});
  const [people, setPeople] = useState<{ id: number; display_name: string }[]>([]);
  const [lendTo, setLendTo] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await api<ToolPayload>("/growth/tools");
      if (res.error) setError(res.error);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the tool list");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api<{ users: { id: number; display_name: string }[] }>("/messages/users")
      .then((res) => setPeople(res.users || []))
      .catch(() => setPeople([]));
  }, []);

  useEffect(() => {
    if (!data?.filed) return;
    const next: Record<string, ToolDraft> = {};
    for (const item of data.filed) {
      next[item.id] = {
        make: item.make || "",
        model: item.model || "",
        serial: item.serial || "",
        notes: item.notes || "",
      };
    }
    setDrafts(next);
  }, [data]);

  async function pickTrack(track: string) {
    setBusy(true);
    setError("");
    setAskingId(null);
    try {
      await api("/growth/tools/track", {
        method: "POST",
        body: JSON.stringify({ track }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the role");
    } finally {
      setBusy(false);
    }
  }

  async function save(body: {
    item_id: string;
    have: boolean;
    needs_upgrade?: boolean;
    make?: string;
    model?: string;
    serial?: string;
    notes?: string;
  }) {
    setBusy(true);
    setError("");
    try {
      await api("/growth/tools/item", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setAskingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that tool");
    } finally {
      setBusy(false);
    }
  }

  function onHave(item: ToolRow) {
    if (item.needs_upgrade) {
      void save({ item_id: item.id, have: true, needs_upgrade: false });
      return;
    }
    if (item.upgrade_ask) {
      setAskingId(item.id);
      return;
    }
    void save({ item_id: item.id, have: true });
  }

  function onAnswer(item: ToolRow, older: boolean) {
    void save({ item_id: item.id, have: true, needs_upgrade: older });
  }

  function saveDetails(item: ToolRow) {
    const draft = drafts[item.id] || emptyDraft();
    void save({
      item_id: item.id,
      have: true,
      needs_upgrade: item.needs_upgrade,
      make: draft.make,
      model: draft.model,
      serial: draft.serial,
      notes: draft.notes,
    });
  }

  async function lend(item: ToolRow) {
    const holder = Number(lendTo[item.id] || 0);
    if (!holder) {
      setError("Pick the tech who is taking the tool.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/growth/tools/lend", {
        method: "POST",
        body: JSON.stringify({ item_id: item.id, holder_user_id: holder }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not lend that tool");
    } finally {
      setBusy(false);
    }
  }

  async function markReturned(lendId: number) {
    setBusy(true);
    setError("");
    try {
      await api(`/growth/tools/lend/${lendId}/return`, { method: "POST", body: "{}" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark that tool returned");
    } finally {
      setBusy(false);
    }
  }

  function setField(id: string, key: keyof ToolDraft, value: string) {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...emptyDraft(), ...prev[id], [key]: value },
    }));
  }

  const nextItem = useMemo(() => {
    if (!data?.next_item_id) return null;
    const fromGoals = (data.goals || []).find((item) => item.id === data.next_item_id);
    if (fromGoals) return fromGoals;
    for (const group of data.groups || []) {
      const hit = group.items.find((item) => item.id === data.next_item_id);
      if (hit) return hit;
    }
    return null;
  }, [data]);

  const goals = (data?.goals || []).filter((item) => !item.have || item.needs_upgrade);
  const filed = data?.filed || [];
  const groups = (data?.groups || [])
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.have || item.needs_upgrade),
    }))
    .filter((group) => group.items.length);
  const goalPct =
    data && data.goals_total > 0 ? Math.round((data.goals_owned / data.goals_total) * 100) : 0;
  const later = nextItem ? afterGoal(goals, nextItem.id) : null;

  return (
    <div className="growth-page">
      <div className="page-header">
        <h1>My tools</h1>
        <p>
          Check a tool you already have and it comes off this list. If a better version is worth
          getting, that upgrade stays. Make, model, and serial are optional under On file. Personal
          tools stay yours. You can lend one to another tech, and accountability moves with it
          until it is returned.
        </p>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {data ? (
        <>
          <div className="card growth-card">
            <h2>Your role</h2>
            {data.position_title ? (
              <p className="muted">Position on file: {data.position_title}</p>
            ) : null}
            <div className="growth-track-row">
              {data.tracks.map((track) => (
                <button
                  key={track.id}
                  type="button"
                  className={track.id === data.track ? "btn" : "btn secondary"}
                  disabled={busy}
                  onClick={() => void pickTrack(track.id)}
                >
                  {track.label}
                </button>
              ))}
            </div>
            {data.track_note ? <p>{data.track_note}</p> : <p>Pick the role you are growing into.</p>}
            {data.track && data.goals_total > 0 ? (
              <>
                <p>
                  Goal tools on file: {data.goals_owned} of {data.goals_total}. Marked on this kit:{" "}
                  {data.owned} of {data.total}.
                </p>
                <div className="growth-progress" aria-hidden="true">
                  <span style={{ width: `${goalPct}%` }} />
                </div>
              </>
            ) : null}
            <p className="muted">{data.truck_note}</p>
          </div>
          {nextItem ? (
            <div className="card growth-card growth-goal">
              <p className="growth-next-tag">
                Recommended · {nextItem.step || goalNumber(goals, nextItem.id)} of {data.goals_total}
              </p>
              {data.recommended_because ? <p>{data.recommended_because}</p> : null}
              <h2>{nextItem.name}</h2>
              <p>
                <strong>Use it for: </strong>
                {nextItem.use}
              </p>
              <p>
                <strong>Your day gets easier: </strong>
                {nextItem.easier}
              </p>
              {nextItem.needs_upgrade ? (
                <p>You have an older one on file. This stays until you get {nextItem.upgrade_better}.</p>
              ) : null}
              {nextItem.tip ? <p className="growth-tip">{nextItem.tip}</p> : null}
              {later ? (
                <p className="muted">
                  After this one: {later.name}. {later.easier}
                </p>
              ) : (
                <p className="muted">This is the last goal tool on this path.</p>
              )}
              {askingId === nextItem.id && !nextItem.needs_upgrade ? (
                <ToolAsk
                  item={nextItem}
                  busy={busy}
                  onAnswer={onAnswer}
                  onLeave={() => setAskingId(null)}
                />
              ) : (
                <div className="growth-row-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => onHave(nextItem)}>
                    {nextItem.needs_upgrade ? "I got the upgrade" : "Check it off"}
                  </button>
                  <details>
                    <summary className="btn secondary">Borrow one</summary>
                    <p>
                      Ask the tech who has it to open My tools and tap Lend this tool. You stay
                      accountable until it comes back.
                    </p>
                  </details>
                  <Link className="btn secondary" to={loanHref(nextItem)}>
                    Start a tool loan
                  </Link>
                </div>
              )}
            </div>
          ) : data.track ? (
            <div className="card growth-card growth-goal">
              <h2>{groups.length ? "Goal tools are on file" : "This list is clear"}</h2>
              <p>
                {groups.length
                  ? "The goal tools for this role are checked off. The lists below are what is still open."
                  : "Every tool for this role is on file. Add a serial under On file if you want it saved."}
              </p>
            </div>
          ) : null}
          {goals.length > 0 ? (
            <section className="card growth-card">
              <h2>The goal path</h2>
              <ol className="growth-path">
                {goals.map((item) => (
                  <li key={item.id} className={item.current ? "is-current" : "is-later"}>
                    <div className="growth-path-head">
                      <span className="growth-path-num">{item.step || goalNumber(goals, item.id)}</span>
                      <strong>{item.name}</strong>
                      {item.needs_upgrade ? <span className="growth-next-tag">Upgrade</span> : null}
                      {item.current ? <span className="growth-next-tag">Get this next</span> : null}
                    </div>
                    <p>{item.needs_upgrade ? item.upgrade_better : item.easier}</p>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {groups.map((group) => (
            <section key={group.name} className="card growth-card">
              <h2>{group.name}</h2>
              <ul className="growth-tool-list">
                {group.items.map((item) => (
                  <li key={item.id} className={item.buy_next ? "is-next" : ""}>
                    <label>
                      <input
                        type="checkbox"
                        checked={false}
                        disabled={busy || askingId === item.id}
                        onChange={() => onHave(item)}
                      />
                      <span>{item.name}</span>
                    </label>
                    {item.buy_next ? <span className="growth-next-tag">Your next goal</span> : null}
                    {item.needs_upgrade ? (
                      <p>You have an older one on file. Check this when you get {item.upgrade_better}.</p>
                    ) : null}
                    <p>
                      <strong>Use it for: </strong>
                      {item.use}
                    </p>
                    <p>
                      <strong>Your day gets easier: </strong>
                      {item.easier}
                    </p>
                    {item.tip ? <p className="growth-tip">{item.tip}</p> : null}
                    {askingId === item.id && !item.needs_upgrade ? (
                      <ToolAsk
                        item={item}
                        busy={busy}
                        onAnswer={onAnswer}
                        onLeave={() => setAskingId(null)}
                      />
                    ) : null}
                    {item.loan_reason ? <Link to={loanHref(item)}>Start a tool loan for this</Link> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <section className="card growth-card">
            <h2>On file</h2>
            <p>
              Make, model, serial, and extra notes are optional. Save them here so you can look up a
              serial if a tool is lost.
            </p>
            <p className="muted">
              Put back on my list returns the tool. A serial you already saved stays stored for the
              next time you check it.
            </p>
            {filed.length === 0 ? (
              <p className="muted">Nothing on file yet. Check a tool you already own.</p>
            ) : (
              <ul className="growth-file-list">
                {filed.map((item) => {
                  const draft = drafts[item.id] || emptyDraft();
                  const summary = [item.make, item.model, item.serial].filter(Boolean).join(" · ");
                  return (
                    <li key={item.id}>
                      <h3>{item.name}</h3>
                      {summary ? <p className="muted">{summary}</p> : null}
                      {item.needs_upgrade ? (
                        <p>Still on your list until you get {item.upgrade_better}.</p>
                      ) : null}
                      <div className="growth-tool-fields">
                        <label htmlFor={`tool-make-${item.id}`}>
                          Make
                          <input
                            id={`tool-make-${item.id}`}
                            value={draft.make}
                            maxLength={80}
                            autoComplete="off"
                            placeholder="Optional"
                            disabled={busy}
                            onChange={(event) => setField(item.id, "make", event.target.value)}
                          />
                        </label>
                        <label htmlFor={`tool-model-${item.id}`}>
                          Model
                          <input
                            id={`tool-model-${item.id}`}
                            value={draft.model}
                            maxLength={80}
                            autoComplete="off"
                            placeholder="Optional"
                            disabled={busy}
                            onChange={(event) => setField(item.id, "model", event.target.value)}
                          />
                        </label>
                        <label htmlFor={`tool-serial-${item.id}`}>
                          Serial number
                          <input
                            id={`tool-serial-${item.id}`}
                            value={draft.serial}
                            maxLength={80}
                            autoComplete="off"
                            placeholder="Optional"
                            disabled={busy}
                            onChange={(event) => setField(item.id, "serial", event.target.value)}
                          />
                        </label>
                        <label className="growth-tool-notes" htmlFor={`tool-notes-${item.id}`}>
                          More detail
                          <textarea
                            id={`tool-notes-${item.id}`}
                            value={draft.notes}
                            maxLength={300}
                            rows={2}
                            placeholder="Optional"
                            disabled={busy}
                            onChange={(event) => setField(item.id, "notes", event.target.value)}
                          />
                        </label>
                      </div>
                      {item.open_lend ? (
                        <p>
                          With {item.open_lend.holder_name} since {item.open_lend.lent_at.slice(0, 10)} (
                          {item.open_lend.days} days). They are accountable until it is returned.
                        </p>
                      ) : item.released ? (
                        <p>This tool left with you when you came off the truck. The serial stays on file.</p>
                      ) : item.last_return ? (
                        <p className="muted">
                          Returned by {item.last_return.holder_name} on {item.last_return.returned_at.slice(0, 10)}.
                          Accountability is back with you.
                        </p>
                      ) : null}
                      <div className="growth-row-actions">
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => saveDetails(item)}
                        >
                          Save details
                        </button>
                        {item.released && !item.open_lend ? null : item.open_lend ? (
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={busy}
                            onClick={() => void markReturned(item.open_lend!.id)}
                          >
                            Mark returned
                          </button>
                        ) : (
                          <>
                            <label className="growth-lend-pick">
                              Lend to
                              <select
                                value={lendTo[item.id] || ""}
                                disabled={busy}
                                onChange={(event) =>
                                  setLendTo((prev) => ({ ...prev, [item.id]: event.target.value }))
                                }
                              >
                                <option value="">Choose a tech</option>
                                {people.map((person) => (
                                  <option key={person.id} value={person.id}>
                                    {person.display_name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={busy}
                              onClick={() => void lend(item)}
                            >
                              Lend this tool
                            </button>
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={busy}
                              onClick={() => void save({ item_id: item.id, have: false })}
                            >
                              Put back on my list
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="card growth-card">
            <h2>Tools you are accountable for</h2>
            <p>A tool you borrowed stays on you until you or the owner marks it returned.</p>
            {(data.borrowed || []).length === 0 ? (
              <p className="muted">You are not holding anyone else's tool.</p>
            ) : (
              <ul className="growth-file-list">
                {(data.borrowed || []).map((row) => (
                  <li key={row.id}>
                    <h3>{row.name}</h3>
                    <p>
                      {row.owner_name}'s tool, with you since {row.lent_at.slice(0, 10)} ({row.days} days).
                    </p>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void markReturned(row.id)}
                    >
                      Mark returned
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {(data.bottles || []).length > 0 ? (
            <section className="card growth-card">
              <h2>Your gas bottles</h2>
              <ul className="growth-file-list">
                {(data.bottles || []).map((bottle) => (
                  <li key={bottle.id}>
                    <h3>
                      {bottleLabel(bottle.bottle_type)}
                      {bottle.serial ? ` · ${bottle.serial}` : ""}
                    </h3>
                    <p>
                      {bottle.status === "left_with_employee"
                        ? "This bottle is marked to leave with you."
                        : bottle.unit_number
                          ? `On truck ${bottle.unit_number}.`
                          : "Yours while you are here."}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {officeCustody && data.team_out ? (
            <section className="card growth-card">
              <h2>Tools out with a tech</h2>
              <p>
                This stays with office. An open borrow shows who has the tool and how long it has been out.
              </p>
              {data.team_out.length === 0 ? (
                <p className="muted">No tools are out with another tech.</p>
              ) : (
                <ul className="growth-file-list">
                  {data.team_out.map((row) => (
                    <li key={row.id}>
                      <h3>{row.name}</h3>
                      <p>
                        {row.owner_name} lent it to {row.holder_name} on {row.lent_at.slice(0, 10)} ({row.days}{" "}
                        days).
                      </p>
                      {row.days >= 14 ? (
                        <p>
                          <strong>Worth buying.</strong> The same tech has had this tool 14 days or more.
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {(data.left_with || []).length > 0 ? (
                <>
                  <h3>Personal tools that left with someone</h3>
                  <ul className="growth-file-list">
                    {(data.left_with || []).map((row) => (
                      <li key={`${row.display_name}-${row.name}-${row.released_at}`}>
                        <strong>{row.display_name}</strong>
                        <p>
                          {row.name}
                          {row.serial ? ` · ${row.serial}` : ""} · left {row.released_at.slice(0, 10)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}
        </>
      ) : !error ? (
        <p>Loading the list...</p>
      ) : null}
    </div>
  );
}

function NateStudy() {
  const { user } = useAuth();
  const officeAllowed = can(user, "viewNateStatus");
  const [data, setData] = useState<NatePayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [examKey, setExamKey] = useState("core");
  const [paper, setPaper] = useState<Paper | null>(null);
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [result, setResult] = useState<{
    correct: number;
    total: number;
    details: GradeDetail[];
    exam: ExamRow;
  } | null>(null);

  const load = useCallback(async () => {
    const res = await api<NatePayload>("/growth/nate");
    if (res.error) throw new Error(res.error);
    setData(res);
    return res;
  }, []);

  useEffect(() => {
    void load().catch((err) => {
      setError(err instanceof Error ? err.message : "Could not load NATE study");
    });
  }, [load]);

  const exam = data?.exams.find((row) => row.key === examKey) || data?.exams[0] || null;

  async function start(mode: "full" | "topic" | "review", topicKey?: string) {
    if (!exam) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await api<Paper & { error?: string }>("/growth/nate/paper", {
        method: "POST",
        body: JSON.stringify({
          exam_key: exam.key,
          mode,
          topic_key: topicKey || undefined,
        }),
      });
      if (res.error) throw new Error(res.error);
      setPaper(res);
      setStep(0);
      setPicks({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start");
    } finally {
      setBusy(false);
    }
  }

  async function submitPaper() {
    if (!paper) return;
    setBusy(true);
    setError("");
    try {
      const res = await api<{
        correct: number;
        total: number;
        details: GradeDetail[];
        exam: ExamRow;
        error?: string;
      }>("/growth/nate/grade", {
        method: "POST",
        body: JSON.stringify({
          paper_id: paper.paper_id,
          answers: paper.questions.map((q) => ({ id: q.id, choice: picks[q.id] })),
        }),
      });
      if (res.error) throw new Error(res.error);
      setResult({
        correct: res.correct,
        total: res.total,
        details: res.details,
        exam: res.exam,
      });
      setPaper(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not score");
    } finally {
      setBusy(false);
    }
  }

  async function markReady(marked: boolean) {
    if (!exam) return;
    setBusy(true);
    setError("");
    try {
      await api("/growth/nate/ready", {
        method: "POST",
        body: JSON.stringify({ exam_key: exam.key, marked }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the ready mark");
    } finally {
      setBusy(false);
    }
  }

  const current = paper?.questions[step];
  const unanswered = paper
    ? paper.questions.filter((q) => picks[q.id] == null).length
    : 0;

  return (
    <div className="growth-page">
      <div className="page-header">
        <h1>NATE study</h1>
        <p>
          Practice for the real NATE test, one goal at a time. Questions are written here for this
          shop. They are not the real exam. Start with Core, then the specialty that matches your work.
        </p>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {data ? <p className="growth-pass-note">{data.pass_note}</p> : null}

      {paper && current ? (
        <div className="card growth-card">
          <p className="muted">
            Question {step + 1} of {paper.questions.length}
            {paper.minutes ? ` · aim for about ${paper.minutes} minutes` : ""}
          </p>
          <h2>{current.prompt}</h2>
          <div className="growth-choices">
            {current.choices.map((choice, index) => (
              <button
                key={choice}
                type="button"
                className={picks[current.id] === index ? "btn" : "btn secondary"}
                onClick={() => setPicks((prev) => ({ ...prev, [current.id]: index }))}
              >
                {choice}
              </button>
            ))}
          </div>
          <div className="growth-nav">
            <button
              type="button"
              className="btn secondary"
              disabled={step === 0}
              onClick={() => setStep((n) => Math.max(0, n - 1))}
            >
              Back
            </button>
            {step < paper.questions.length - 1 ? (
              <button type="button" className="btn" onClick={() => setStep((n) => n + 1)}>
                Next
              </button>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => void submitPaper()}>
                {unanswered ? `Score it (${unanswered} blank)` : "Score it"}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="card growth-card">
          <h2>
            {result.correct} of {result.total} · {result.exam.status_label}
          </h2>
          <ul className="growth-review">
            {result.details.map((row) => (
              <li key={row.id} className={row.ok ? "is-right" : "is-wrong"}>
                <p>{row.prompt}</p>
                <p>{row.ok ? "Right." : `The better answer: ${row.choices[row.answer]}`}</p>
                <p className="growth-tip">{row.why}</p>
              </li>
            ))}
          </ul>
          <button type="button" className="btn secondary" onClick={() => setResult(null)}>
            Back to the test
          </button>
        </div>
      ) : null}

      {!paper && data ? (
        <>
          <div className="growth-exam-row">
            {data.exams.map((row) => (
              <button
                key={row.key}
                type="button"
                className={row.key === (exam?.key || "") ? "btn" : "btn secondary"}
                onClick={() => {
                  setExamKey(row.key);
                  setResult(null);
                }}
              >
                {row.recommended ? `${row.label} · for you` : row.label}
                {` · ${examProgressLabel(row)}`}
              </button>
            ))}
          </div>
          {exam ? (
            <div className="card growth-card">
              <p className={`growth-status growth-status-${exam.status}`}>{exam.status_label}</p>
              <h2>{exam.label}</h2>
              <p>{exam.blurb}</p>
              <div className="growth-goal">
                <p className="growth-next-tag">Your next study goal</p>
                <h3>{nextNateGoal(exam).title}</h3>
                <p>{nextNateGoal(exam).detail}</p>
                <p className="muted">
                  Topics at 70%: {exam.topics.filter((topic) => topic.ok).length} of{" "}
                  {exam.topics.length}. Two full practices at 80%: {exam.fulls_ok ? "done" : "still open"}.
                  {exam.recent_full_score != null
                    ? ` Last full practice: ${pct(exam.recent_full_score)}.`
                    : " No full practice yet."}
                </p>
              </div>
              <ul className="growth-topics">
                {exam.topics.map((topic) => (
                  <li key={topic.key}>
                    <span>{topic.label}</span>
                    <span>
                      {topic.score == null ? "Not yet" : pct(topic.score)}
                      {topic.ok ? " · goal met" : " · goal 70%"}
                    </span>
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={busy}
                      onClick={() => void start("topic", topic.key)}
                    >
                      Topic quiz
                    </button>
                  </li>
                ))}
              </ul>
              <div className="growth-nav">
                <button type="button" className="btn" disabled={busy} onClick={() => void start("full")}>
                  Full practice (15)
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => void start("review")}
                >
                  Review misses
                </button>
              </div>
              {exam.can_mark && !exam.marked ? (
                <button type="button" className="btn" disabled={busy} onClick={() => void markReady(true)}>
                  I feel ready to schedule
                </button>
              ) : null}
              {exam.marked ? (
                <p>
                  You marked that you feel ready.
                  {exam.status !== "ready"
                    ? " The latest scores are not there, so this is not ready to schedule."
                    : " Your practice is in the range to schedule the real test."}
                </p>
              ) : null}
              {exam.marked ? (
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => void markReady(false)}
                >
                  Clear the ready mark
                </button>
              ) : null}
            </div>
          ) : null}
          {officeAllowed && data.office ? (
            <section className="card growth-card">
              <h2>Who is ready</h2>
              <p className="muted">People who have practiced. This is not a ranking.</p>
              {data.office.length ? (
                <ul className="growth-office">
                  {data.office.map((row) => (
                    <li key={`${row.user_id}-${row.exam_key}`}>
                      <strong>{row.display_name}</strong>
                      {row.position_title ? ` · ${row.position_title}` : ""} · {row.label} ·{" "}
                      {row.status_label}
                      {row.recent_full_score != null
                        ? ` · last full ${pct(row.recent_full_score)}`
                        : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No one has taken a practice test yet.</p>
              )}
            </section>
          ) : null}
        </>
      ) : !error && !paper ? (
        <p>Loading study...</p>
      ) : null}
    </div>
  );
}
