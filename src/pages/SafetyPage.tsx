import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, can, roleLabel } from "../api";
import { useAuth } from "../auth";
import { SafetyTrainingFile } from "../components/SafetyTrainingFile";
import { printWithLightTheme } from "../printTheme";
import {
  SAFETY_TRACKS,
  TRACK_LABEL,
  levelFor,
  parseAudiences,
  safetyDateLabel,
  safetyDue,
  safetyTrack,
  type SafetyLevel,
  type SafetyTrack,
} from "../safetyAssign";
import {
  buildSafetyStatusGrid,
  filterSafetyStatusRows,
  safetyDoneLabel,
  safetyStatusTotals,
  type SafetyStampInput,
  type SafetyTopicInput,
  type SafetyUserInput,
} from "../safetyStatus";

type SafetyTopic = {
  id: number;
  title: string;
  body: string | null;
  video_url: string | null;
  video_file_key: string | null;
  sort_order: number;
  active: number;
  category?: string | null;
  for_new_hire?: number | null;
  audiences?: string | null;
  my_completion_count?: number;
  my_completed_at?: string | null;
  completion_count?: number;
};

const EMPTY_LEVELS: Record<SafetyTrack, "" | SafetyLevel> = {
  service: "",
  install: "",
  warehouse: "",
  shop: "",
  office: "",
};

function dueLine(completedAt: string | null | undefined): string {
  const due = safetyDue(completedAt);
  if (due.status === "none") return "Not taken yet";
  if (due.status === "overdue") {
    return `Past due ${safetyDateLabel(due.due_on)}. Last taken ${safetyDateLabel(due.last_taken)}.`;
  }
  if (due.status === "due_soon") {
    return `Refresh before ${safetyDateLabel(due.due_on)}. Last taken ${safetyDateLabel(due.last_taken)}.`;
  }
  return `Last taken ${safetyDateLabel(due.last_taken)}. Current through ${safetyDateLabel(due.due_on)}.`;
}

function TopicRow({
  topic,
  isAdmin,
  onEdit,
}: {
  topic: SafetyTopic;
  isAdmin: boolean;
  onEdit: (topic: SafetyTopic) => void;
}) {
  const due = safetyDue(topic.my_completed_at);
  const badge =
    due.status === "current"
      ? "is-done"
      : due.status === "due_soon"
        ? "is-soon"
        : "is-need";
  return (
    <li className="card safety-topic-row">
      <div>
        <Link to={`/safety/topics/${topic.id}`} className="safety-topic-title">
          <strong>{topic.title}</strong>
        </Link>
        {topic.category ? <span className="muted"> · {topic.category}</span> : null}
        <div className="safety-topic-meta">
          <span className={`safety-badge ${badge}`}>{dueLine(topic.my_completed_at)}</span>
          {isAdmin && topic.completion_count != null
            ? ` · ${topic.completion_count} stamp${topic.completion_count === 1 ? "" : "s"}`
            : ""}
        </div>
      </div>
      <div className="safety-topic-actions">
        <Link className="btn btn-sm" to={`/safety/topics/${topic.id}`}>
          Open
        </Link>
        {isAdmin ? (
          <button type="button" className="btn ghost btn-sm" onClick={() => onEdit(topic)}>
            Edit
          </button>
        ) : null}
      </div>
    </li>
  );
}

function TopicList({
  topics,
  isAdmin,
  onEdit,
  track,
  trackLabel,
}: {
  topics: SafetyTopic[];
  isAdmin: boolean;
  onEdit: (topic: SafetyTopic) => void;
  track: SafetyTrack;
  trackLabel: string;
}) {
  const leveled = topics
    .filter((topic) => Number(topic.active))
    .map((topic) => ({ topic, level: levelFor(parseAudiences(topic.audiences), track) }))
    .filter((row): row is { topic: SafetyTopic; level: SafetyLevel } => row.level != null);
  const essentials = leveled.filter((row) => row.level === "essential").map((row) => row.topic);
  const extras = leveled.filter((row) => row.level === "extra").map((row) => row.topic);
  const blocking = essentials.some((topic) => {
    const status = safetyDue(topic.my_completed_at).status;
    return status === "none" || status === "overdue";
  });
  const covered = essentials.filter((topic) => {
    const status = safetyDue(topic.my_completed_at).status;
    return status === "current" || status === "due_soon";
  }).length;
  const refresh = leveled
    .map((row) => row.topic)
    .filter((topic) => {
      const status = safetyDue(topic.my_completed_at).status;
      return status === "due_soon" || status === "overdue";
    });
  const next = essentials.find((topic) => {
    const status = safetyDue(topic.my_completed_at).status;
    return status === "none" || status === "overdue";
  });

  if (!leveled.length) {
    return (
      <ul className="safety-topic-list">
        <li className="card muted">
          {isAdmin
            ? "No courses are assigned to your job yet. Assign jobs in Manage."
            : "No safety courses for your job yet."}
        </li>
      </ul>
    );
  }

  return (
    <>
      <div className="card safety-new-hire-banner">
        <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>{trackLabel} essentials</h2>
        <p style={{ marginTop: 0 }}>
          Finish these before the other {trackLabel.toLowerCase()} courses. Your stamp is the record
          you were shown them. Each course stays current for a year. The refresher opens 30 days
          before that year ends.
        </p>
        <p className="safety-progress">
          <strong>
            {covered} of {essentials.length} essentials current
          </strong>
        </p>
        {next ? (
          <Link className="btn" to={`/safety/topics/${next.id}`}>
            Continue: {next.title}
          </Link>
        ) : (
          <p className="muted" style={{ marginBottom: 0 }}>
            Essentials for this job are current.
          </p>
        )}
      </div>
      {refresh.length ? (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Refresh before the year is up</h2>
          <ul className="safety-history-list">
            {refresh.map((topic) => (
              <li key={topic.id}>
                <Link to={`/safety/topics/${topic.id}`}>{topic.title}</Link>
                {" · "}
                {dueLine(topic.my_completed_at)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <section aria-label="Essentials">
        <h2 className="safety-category">Essentials for your job</h2>
        <ul className="safety-topic-list">
          {essentials.map((topic) => (
            <TopicRow key={topic.id} topic={topic} isAdmin={isAdmin} onEdit={onEdit} />
          ))}
        </ul>
      </section>
      {blocking ? (
        <p className="muted">
          The other {trackLabel.toLowerCase()} courses open after every essential is current.
        </p>
      ) : (
        <section aria-label="More for this job">
          <h2 className="safety-category">More for this job</h2>
          {extras.length ? (
            <ul className="safety-topic-list">
              {extras.map((topic) => (
                <TopicRow key={topic.id} topic={topic} isAdmin={isAdmin} onEdit={onEdit} />
              ))}
            </ul>
          ) : (
            <p className="muted">No extra courses for this job.</p>
          )}
        </section>
      )}
    </>
  );
}

type SafetyCompletion = {
  id: number;
  topic_id: number;
  user_id: number;
  completed_at: string;
  topic_title?: string;
  user_name?: string;
  stamped_by_name?: string | null;
  is_retake?: number;
  notes?: string | null;
};

function videoSrc(t: SafetyTopic): string | null {
  if (t.video_url?.trim()) return t.video_url.trim();
  if (t.video_file_key?.trim()) {
    return `/api/uploads/${encodeURIComponent(t.video_file_key.trim())}`;
  }
  return null;
}

/** YouTube, Vimeo, Drive, and other page links open in a new tab. Files play inline. */
function isRemotePageLink(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  return !/\.(mp4|webm|mov|m4v|ogg)(\?|#|$)/i.test(url);
}

function csvCell(value: string): string {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function todayStamp(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function printedOn(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** One-tap printable certificate — no extra form. */
function openCertPdf(opts: {
  name: string;
  topic: string;
  completedAt: string;
  company?: string;
}) {
  const company = opts.company || "Total Assurance A/C & Heating";
  const when = opts.completedAt.replace("T", " ").slice(0, 16);
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Safety certificate</title>
<style>
  @page { margin: 0.6in; }
  body { font-family: Georgia, "Times New Roman", serif; color: #111; }
  .cert { border: 3px double #1a4d3a; padding: 2rem 2.25rem; max-width: 720px; margin: 0 auto; }
  h1 { margin: 0 0 0.35rem; font-size: 1.65rem; letter-spacing: 0.04em; text-align: center; }
  .sub { text-align: center; color: #444; margin-bottom: 1.75rem; font-size: 0.95rem; }
  .line { margin: 1rem 0; font-size: 1.15rem; line-height: 1.45; text-align: center; }
  .name { font-size: 1.55rem; font-weight: 700; }
  .topic { font-size: 1.25rem; font-style: italic; }
  .foot { margin-top: 2.5rem; font-size: 0.85rem; color: #555; text-align: center; }
  .actions { text-align: center; margin: 1rem 0 1.5rem; }
  @media print { .actions { display: none; } }
</style></head><body>
  <div class="actions no-print">
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="cert">
    <h1>Certificate of Completion</h1>
    <div class="sub">${escapeHtml(company)} · Safety Training</div>
    <p class="line">This certifies that</p>
    <p class="line name">${escapeHtml(opts.name)}</p>
    <p class="line">completed</p>
    <p class="line topic">${escapeHtml(opts.topic)}</p>
    <p class="line">on <strong>${escapeHtml(when)}</strong></p>
    <p class="foot">Company training record. Stamped in Field App. Not a state license and not a public ranking.</p>
  </div>
  <script>window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`;
  const w = window.open("", "_blank", "noopener,noreferrer,width=800,height=900");
  if (!w) {
    window.alert("Allow pop-ups to print or download the certificate.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatStamp(s: string | null | undefined): string {
  if (!s) return "—";
  return String(s).replace("T", " ").slice(0, 16);
}

export function SafetyPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const canViewStatus = can(user, "viewSafetyStatus");
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const topicId = Number(params.topicId || "") || null;
  const tab = searchParams.get("tab") || (isAdmin ? "topics" : "topics");

  const [topics, setTopics] = useState<SafetyTopic[]>([]);
  const [completions, setCompletions] = useState<SafetyCompletion[]>([]);
  const [topicDetail, setTopicDetail] = useState<SafetyTopic | null>(null);
  const [myCompletions, setMyCompletions] = useState<SafetyCompletion[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [videoOpened, setVideoOpened] = useState(false);
  const [readConfirmed, setReadConfirmed] = useState(false);
  const [people, setPeople] = useState<Array<{ id: number; display_name: string }>>([]);

  // Admin filters
  const [filterPerson, setFilterPerson] = useState("");
  const [filterTopic, setFilterTopic] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  // Admin topic form
  const [editId, setEditId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [active, setActive] = useState(true);
  const [category, setCategory] = useState("");
  const [jobLevels, setJobLevels] = useState(EMPTY_LEVELS);
  const [myTrack, setMyTrack] = useState<SafetyTrack | null>(null);
  const [trackLabel, setTrackLabel] = useState("Service");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [statusTopics, setStatusTopics] = useState<SafetyTopicInput[]>([]);
  const [statusUsers, setStatusUsers] = useState<SafetyUserInput[]>([]);
  const [statusStamps, setStatusStamps] = useState<SafetyStampInput[]>([]);
  const [statusRole, setStatusRole] = useState("");
  const [statusOnlyNeeds, setStatusOnlyNeeds] = useState(false);

  const loadTopics = useCallback(async () => {
    const d = await api<{
      topics: SafetyTopic[];
      error?: string;
      my_track?: SafetyTrack;
      my_track_label?: string;
    }>("/safety/topics");
    setTopics(d.topics || []);
    const fallback = safetyTrack({
      role: user?.role,
      is_warehouse: user?.is_warehouse,
    });
    const track = d.my_track || fallback;
    setMyTrack(track);
    setTrackLabel(d.my_track_label || TRACK_LABEL[track]);
    if (d.error) setError(d.error);
  }, [user?.role, user?.is_warehouse]);

  const loadCompletions = useCallback(async () => {
    const q = new URLSearchParams();
    if (isAdmin && filterPerson) q.set("user_id", filterPerson);
    if (filterTopic) q.set("topic_id", filterTopic);
    if (filterFrom) q.set("from", filterFrom);
    if (filterTo) q.set("to", filterTo);
    const d = await api<{ completions: SafetyCompletion[] }>(
      `/safety/completions${q.toString() ? `?${q}` : ""}`
    );
    setCompletions(d.completions || []);
  }, [isAdmin, filterPerson, filterTopic, filterFrom, filterTo]);

  const loadTopic = useCallback(async (id: number) => {
    setVideoOpened(false);
    setReadConfirmed(false);
    const d = await api<{
      topic: SafetyTopic;
      my_completions: SafetyCompletion[];
    }>(`/safety/topics/${id}`);
    setTopicDetail(d.topic);
    setMyCompletions(d.my_completions || []);
  }, []);

  useEffect(() => {
    loadTopics().catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [loadTopics]);

  useEffect(() => {
    if (tab === "history") {
      loadCompletions().catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
    }
  }, [tab, loadCompletions]);

  useEffect(() => {
    if (topicId) {
      loadTopic(topicId).catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
    } else {
      setTopicDetail(null);
      setMyCompletions([]);
    }
  }, [topicId, loadTopic]);

  const loadStatus = useCallback(async () => {
    const d = await api<{
      topics?: SafetyTopicInput[];
      users?: SafetyUserInput[];
      stamps?: SafetyStampInput[];
      error?: string;
    }>("/safety/status");
    setStatusTopics(d.topics || []);
    setStatusUsers(d.users || []);
    setStatusStamps(d.stamps || []);
    if (d.error) setError(d.error);
  }, []);

  useEffect(() => {
    if (tab !== "status" || !canViewStatus) return;
    loadStatus().catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [tab, canViewStatus, loadStatus]);

  const statusGrid = useMemo(
    () => buildSafetyStatusGrid({ topics: statusTopics, users: statusUsers, stamps: statusStamps }),
    [statusTopics, statusUsers, statusStamps]
  );
  const statusRows = useMemo(
    () => filterSafetyStatusRows(statusGrid.rows, { role: statusRole, onlyNeeds: statusOnlyNeeds }),
    [statusGrid.rows, statusRole, statusOnlyNeeds]
  );
  const statusTotals = useMemo(
    () => safetyStatusTotals(statusGrid.topics, statusRows),
    [statusGrid.topics, statusRows]
  );
  const statusRoles = useMemo(() => {
    const roles = new Set(statusGrid.rows.map((row) => row.user.role).filter(Boolean));
    return [...roles].sort();
  }, [statusGrid.rows]);
  const missingRequired = useMemo(() => {
    const usesJobs = statusGrid.topics.some(
      (topic) => Object.keys(parseAudiences(topic.audiences)).length > 0
    );
    const requiredIds = new Set(
      statusGrid.topics.filter((topic) => Number(topic.for_new_hire) === 1).map((topic) => topic.id)
    );
    const titleById = new Map(statusGrid.topics.map((topic) => [topic.id, topic.title]));
    return statusGrid.rows
      .map((row) => ({
        id: row.user.id,
        name: row.user.display_name,
        topics: row.cells
          .filter((cell) =>
            usesJobs
              ? cell.level === "essential" && !cell.done
              : !cell.done && requiredIds.has(cell.topic_id)
          )
          .map((cell) => titleById.get(cell.topic_id) || "")
          .filter(Boolean),
      }))
      .filter((row) => row.topics.length > 0);
  }, [statusGrid]);

  function downloadStatusCsv() {
    const headers = ["Person", "Role", "Position", ...statusGrid.topics.map((topic) => topic.title)];
    const lines = [
      headers.map(csvCell).join(","),
      ...statusRows.map((row) =>
        [
          row.user.display_name,
          roleLabel(row.user.role),
          row.user.position_title || "",
          ...row.cells.map((cell) => cell.label),
        ]
          .map(csvCell)
          .join(",")
      ),
      ["Totals", "", "", ...statusTotals.map((total) => total.label)].map(csvCell).join(","),
    ];
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `safety-team-status-${todayStamp()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    if (!isAdmin) return;
    void api<{ employees?: Array<{ id: number; name: string }> }>("/employees")
      .then((r) => {
        const list = (r.employees || [])
          .filter((e) => e.name?.trim())
          .map((e) => ({ id: e.id, display_name: e.name.trim() }))
          .sort((a, b) => a.display_name.localeCompare(b.display_name));
        // employees id ≠ users id often — also load users for admin filter if available
        setPeople(list);
      })
      .catch(() => null);
    void api<{ users?: Array<{ id: number; display_name: string }> }>("/users")
      .then((r) => {
        if (r.users?.length) {
          setPeople(
            r.users
              .map((u) => ({ id: u.id, display_name: u.display_name }))
              .sort((a, b) => a.display_name.localeCompare(b.display_name))
          );
        }
      })
      .catch(() => null);
  }, [isAdmin]);

  const alreadyDone = useMemo(
    () => (myCompletions?.length || 0) > 0,
    [myCompletions]
  );
  const latestDue = useMemo(
    () => safetyDue(myCompletions[0]?.completed_at),
    [myCompletions]
  );
  const refreshDue = latestDue.status === "due_soon" || latestDue.status === "overdue";

  function resetForm() {
    setEditId(null);
    setTitle("");
    setBody("");
    setVideoUrl("");
    setSortOrder("0");
    setActive(true);
    setCategory("");
    setJobLevels(EMPTY_LEVELS);
    setVideoFile(null);
  }

  function startEdit(t: SafetyTopic) {
    setEditId(t.id);
    setTitle(t.title || "");
    setBody(t.body || "");
    setVideoUrl(t.video_url || "");
    setSortOrder(String(t.sort_order ?? 0));
    setActive(!!t.active);
    setCategory(t.category || "");
    const parsed = parseAudiences(t.audiences);
    setJobLevels({
      service: parsed.service || "",
      install: parsed.install || "",
      warehouse: parsed.warehouse || "",
      shop: parsed.shop || "",
      office: parsed.office || "",
    });
    setVideoFile(null);
    setSearchParams({ tab: "manage" });
  }

  async function saveTopic(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      const fd = new FormData();
      fd.append("title", title.trim() || "Untitled safety topic");
      fd.append("body", body);
      fd.append("video_url", videoUrl.trim());
      fd.append("sort_order", String(Number(sortOrder) || 0));
      fd.append("active", active ? "1" : "0");
      fd.append("category", category.trim());
      const audiences: Partial<Record<SafetyTrack, SafetyLevel>> = {};
      for (const track of SAFETY_TRACKS) {
        if (jobLevels[track]) audiences[track] = jobLevels[track];
      }
      fd.append("audiences", JSON.stringify(audiences));
      if (videoFile) fd.append("video_file", videoFile);

      if (editId) {
        await api(`/safety/topics/${editId}`, { method: "PATCH", body: fd, timeoutMs: 120_000 });
        setOk("Topic saved.");
      } else {
        await api("/safety/topics", { method: "POST", body: fd, timeoutMs: 120_000 });
        setOk("Topic created.");
      }
      resetForm();
      await loadTopics();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save topic");
    } finally {
      setBusy(false);
    }
  }

  async function archiveTopic(id: number) {
    if (!window.confirm("Archive this topic? Techs will no longer see it.")) return;
    setBusy(true);
    try {
      await api(`/safety/topics/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ archive: true }),
      });
      setOk("Topic archived.");
      await loadTopics();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Archive failed");
    } finally {
      setBusy(false);
    }
  }

  async function markComplete() {
    if (!topicDetail) return;
    setBusy(true);
    setError("");
    try {
      const hasVideo = Boolean(videoSrc(topicDetail));
      const d = await api<{ completion: SafetyCompletion }>("/safety/completions", {
        method: "POST",
        body: JSON.stringify({
          topic_id: topicDetail.id,
          video_opened: hasVideo ? videoOpened : false,
          read_confirmed: hasVideo ? false : readConfirmed,
        }),
      });
      setOk("Completion stamped.");
      await loadTopic(topicDetail.id);
      await loadTopics();
      if (d.completion) {
        openCertPdf({
          name: user?.display_name || "Team member",
          topic: topicDetail.title,
          completedAt: d.completion.completed_at,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not stamp completion";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function adminRetake(topicIdNum: number, forUserId: number) {
    setBusy(true);
    setError("");
    try {
      await api("/safety/completions", {
        method: "POST",
        body: JSON.stringify({
          topic_id: topicIdNum,
          video_opened: true,
          retake: true,
          for_user_id: forUserId,
        }),
      });
      setOk("Retake stamped (prior history kept).");
      await loadCompletions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retake failed");
    } finally {
      setBusy(false);
    }
  }

  // ——— Topic detail ———
  if (topicId && !topicDetail) {
    return (
      <div className="safety-page">
        {error ? (
          <div className="error inv-flash">{error}</div>
        ) : (
          <p className="muted">Loading topic…</p>
        )}
        <button type="button" className="btn ghost btn-sm" onClick={() => navigate("/safety")}>
          ← All topics
        </button>
      </div>
    );
  }

  if (topicId && topicDetail) {
    const src = videoSrc(topicDetail);
    return (
      <div className="safety-page">
        <div className="page-header">
          <div>
            <button type="button" className="btn ghost btn-sm" onClick={() => navigate("/safety")}>
              ← All topics
            </button>
            <h1 style={{ marginTop: "0.5rem" }}>{topicDetail.title}</h1>
            {topicDetail.category || myTrack ? (
              <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                {topicDetail.category || "Safety"}
                {myTrack
                  ? ` · ${
                      levelFor(parseAudiences(topicDetail.audiences), myTrack) === "essential"
                        ? "Essential"
                        : levelFor(parseAudiences(topicDetail.audiences), myTrack) === "extra"
                          ? "Extra"
                          : "Not on your job list"
                    } for ${trackLabel}`
                  : ""}
              </p>
            ) : null}
            {alreadyDone ? (
              <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                {dueLine(myCompletions[0]?.completed_at)}
              </p>
            ) : null}
            {!topicDetail.active ? (
              <p className="muted">Archived (admin only)</p>
            ) : null}
          </div>
        </div>
        {error ? <div className="error inv-flash">{error}</div> : null}
        {ok ? <div className="success inv-flash">{ok}</div> : null}

        {topicDetail.body?.trim() ? (
          <div className="card safety-body">
            <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{topicDetail.body}</p>
          </div>
        ) : null}

        {src ? (
        <div className="card safety-video-card">
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Training video</h2>
          {isRemotePageLink(src) ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                This video is a link. Open it, then mark complete.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setVideoOpened(true);
                  window.open(src, "_blank", "noopener,noreferrer");
                }}
              >
                Open video
              </button>
              <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
                {videoOpened ? "Video opened" : "Open the video to unlock Mark complete"}
              </p>
            </>
          ) : (
            <>
              <video
                className="safety-video"
                controls
                src={src}
                onPlay={() => setVideoOpened(true)}
              />
              <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  onClick={() => {
                    setVideoOpened(true);
                    window.open(src, "_blank", "noopener,noreferrer");
                  }}
                >
                  Open video
                </button>{" "}
                {videoOpened ? "· Video opened" : "· Open or play the video to unlock Mark complete"}
              </p>
            </>
          )}
        </div>
        ) : (
          <div className="card safety-complete-card">
            <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Your acknowledgement</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Read the precautions above. Your stamp saves the wording you were shown.
            </p>
            <label className="safety-ack">
              <input
                type="checkbox"
                checked={readConfirmed}
                disabled={alreadyDone && !refreshDue}
                onChange={(e) => setReadConfirmed(e.target.checked)}
              />
              <span>I read this. I will follow it on the job.</span>
            </label>
          </div>
        )}

        <div className="card safety-complete-card">
          <button
            type="button"
            className="btn"
            disabled={busy || (alreadyDone && !refreshDue) || (src ? !videoOpened : !readConfirmed)}
            onClick={() => void markComplete()}
            title={
              alreadyDone && !refreshDue
                ? "Already current. The refresher opens 30 days before the year ends."
                : src && !videoOpened
                  ? "Open or play the video first"
                  : !src && !readConfirmed
                    ? "Confirm you read this first"
                    : refreshDue
                      ? "Stamp the refresher"
                      : "Stamp completion"
            }
          >
            {busy
              ? "Saving…"
              : alreadyDone && !refreshDue
                ? "Already current"
                : refreshDue
                  ? "Stamp refresher"
                  : "Mark complete"}
          </button>
          {alreadyDone ? (
            <p className="muted" style={{ marginTop: "0.65rem" }}>
              Stamped {formatStamp(myCompletions[0]?.completed_at)}.{" "}
              <button
                type="button"
                className="btn ghost btn-sm"
                onClick={() =>
                  openCertPdf({
                    name: user?.display_name || "Team member",
                    topic: topicDetail.title,
                    completedAt: myCompletions[0]?.completed_at || "",
                  })
                }
              >
                Cert PDF
              </button>
            </p>
          ) : null}
        </div>

        {myCompletions.length > 0 ? (
          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Your stamps for this topic</h2>
            <ul className="safety-history-list">
              {myCompletions.map((c) => (
                <li key={c.id}>
                  {formatStamp(c.completed_at)}
                  {c.is_retake
                  ? String(c.notes || "").startsWith("Refresher")
                    ? " · refresher"
                    : " · retake"
                  : ""}
                  {" · "}
                  <button
                    type="button"
                    className="btn ghost btn-sm"
                    onClick={() =>
                      openCertPdf({
                        name: user?.display_name || "Team member",
                        topic: topicDetail.title,
                        completedAt: c.completed_at,
                      })
                    }
                  >
                    Cert PDF
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  // ——— List / manage / history ———
  return (
    <div className="safety-page">
      <div className="page-header">
        <div>
          <h1>Safety</h1>
          <p className="muted" style={{ margin: 0 }}>
            Courses follow the job. Finish the essentials for your job before the extra courses. Your stamp records the day you were shown each one, and a refresher opens 30 days before the year is up. The certificate is our training record. It is not a state license.
          </p>
        </div>
      </div>
      {error ? <div className="error inv-flash">{error}</div> : null}
      {ok ? <div className="success inv-flash">{ok}</div> : null}

      <div className="warranty-filters no-print">
        <button
          type="button"
          className={`inv-tab${tab === "topics" ? " active" : ""}`}
          onClick={() => setSearchParams({ tab: "topics" })}
        >
          Topics
        </button>
        <button
          type="button"
          className={`inv-tab${tab === "history" ? " active" : ""}`}
          onClick={() => setSearchParams({ tab: "history" })}
        >
          {isAdmin ? "All completions" : "My history"}
        </button>
        {canViewStatus ? (
          <button
            type="button"
            className={`inv-tab${tab === "status" ? " active" : ""}`}
            onClick={() => setSearchParams({ tab: "status" })}
          >
            Team status
          </button>
        ) : null}
        <button
          type="button"
          className={`inv-tab${tab === "file" ? " active" : ""}`}
          onClick={() => setSearchParams({ tab: "file" })}
        >
          Training file
        </button>
        {isAdmin ? (
          <button
            type="button"
            className={`inv-tab${tab === "manage" ? " active" : ""}`}
            onClick={() => setSearchParams({ tab: "manage" })}
          >
            Manage topics
          </button>
        ) : null}
      </div>

      {tab === "topics" ? (
        myTrack ? (
          <TopicList
            topics={topics}
            isAdmin={!!isAdmin}
            onEdit={startEdit}
            track={myTrack}
            trackLabel={trackLabel}
          />
        ) : (
          <p className="muted">Loading courses…</p>
        )
      ) : null}

      {tab === "file" ? (
        <SafetyTrainingFile
          userId={Number(searchParams.get("user") || "") || null}
          employeeId={Number(searchParams.get("employee_id") || "") || null}
        />
      ) : null}

      {tab === "history" ? (
        <div className="card">
          {isAdmin ? (
            <div className="safety-filters">
              <label>
                Person
                <select value={filterPerson} onChange={(e) => setFilterPerson(e.target.value)}>
                  <option value="">Everyone</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Topic
                <select value={filterTopic} onChange={(e) => setFilterTopic(e.target.value)}>
                  <option value="">All topics</option>
                  {topics.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                From
                <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
              </label>
              <label>
                To
                <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
              </label>
              <button type="button" className="btn secondary btn-sm" onClick={() => void loadCompletions()}>
                Apply
              </button>
            </div>
          ) : null}
          <ul className="safety-history-list">
            {!completions.length ? (
              <li className="muted">No completion stamps yet.</li>
            ) : null}
            {completions.map((c) => (
              <li key={c.id}>
                <strong>{c.user_name || "Someone"}</strong>
                {" · "}
                {c.topic_title || `Topic #${c.topic_id}`}
                {" · "}
                {formatStamp(c.completed_at)}
                {c.is_retake
                  ? String(c.notes || "").startsWith("Refresher")
                    ? " · refresher"
                    : " · retake"
                  : ""}
                {" · "}
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  onClick={() =>
                    openCertPdf({
                      name: c.user_name || "Team member",
                      topic: c.topic_title || "Safety topic",
                      completedAt: c.completed_at,
                    })
                  }
                >
                  Cert PDF
                </button>
                {isAdmin ? (
                  <button
                    type="button"
                    className="btn ghost btn-sm"
                    disabled={busy}
                    onClick={() => void adminRetake(c.topic_id, c.user_id)}
                  >
                    Record retake
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tab === "status" && canViewStatus ? (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Missing required topics</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            People who still need an essential course for their job, or whose essential course is past
            the year. A dash on the grid means that course is not part of that job. Not a ranking.
          </p>
          {!statusGrid.topics.length ? (
            <p className="muted">No active safety topics yet.</p>
          ) : !missingRequired.length ? (
            <p className="muted">No one is missing a required topic.</p>
          ) : (
            <ul className="safety-history-list">
              {missingRequired.map((row) => (
                <li key={row.id}>
                  <strong>{row.name}</strong>
                  {" - "}
                  {row.topics.join(", ")}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {tab === "status" && canViewStatus ? (
        <div className="card safety-status-sheet">
          <header className="safety-print-letterhead">
            <img src="/logo-form-primary.png" alt="Total Assurance" />
            <div>
              <div className="safety-print-title">Safety team status</div>
              <div className="muted">Printed {printedOn()}</div>
            </div>
          </header>
          <div className="safety-status-tools no-print">
            <label>
              Role
              <select value={statusRole} onChange={(e) => setStatusRole(e.target.value)}>
                <option value="">All roles</option>
                {statusRoles.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </select>
            </label>
            <label className="safety-check">
              <input
                type="checkbox"
                checked={statusOnlyNeeds}
                onChange={(e) => setStatusOnlyNeeds(e.target.checked)}
              />{" "}
              Only people who still need something
            </label>
            <button type="button" className="btn secondary btn-sm" onClick={() => void printWithLightTheme("print-safety-status")}>
              Print
            </button>
            <button type="button" className="btn ghost btn-sm" onClick={downloadStatusCsv}>
              CSV
            </button>
          </div>
          {!statusGrid.topics.length ? (
            <p className="muted">
              {isAdmin ? "Add your first topic in Manage." : "No active safety topics yet."}
            </p>
          ) : (
            <div className="safety-status-wrap">
              <table className="safety-status-table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Position</th>
                    {statusGrid.topics.map((topic) => (
                      <th key={topic.id}>{topic.title}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!statusRows.length ? (
                    <tr>
                      <td colSpan={3 + statusGrid.topics.length} className="muted">
                        {statusOnlyNeeds ? "No one still needs a topic." : "No people match this filter."}
                      </td>
                    </tr>
                  ) : null}
                  {statusRows.map((row) => (
                    <tr key={row.user.id}>
                      <td>{row.user.display_name}</td>
                      <td>{roleLabel(row.user.role)}</td>
                      <td>{row.user.position_title || ""}</td>
                      {row.cells.map((cell) => (
                        <td key={cell.topic_id} className={cell.done ? "is-done" : "is-need"}>
                          {cell.label}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Totals</th>
                    <td></td>
                    <td></td>
                    {statusTotals.map((total) => (
                      <td key={total.topic_id}>{total.label}</td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {tab === "manage" && isAdmin ? (
        <form className="card safety-manage-form" onSubmit={saveTopic}>
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>
            {editId ? `Edit topic #${editId}` : "New topic"}
          </h2>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Company precautions live here. Edit a topic if the shop rule changes. Stamps already saved keep the wording the person was shown.
          </p>
          <label>
            Title *
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder="Untitled safety topic"
            />
          </label>
          <label>
            Short body
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Optional notes for the tech"
            />
          </label>
          <label>
            Video URL
            <input
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
          <label>
            Or upload video file
            <input
              type="file"
              accept="video/*"
              onChange={(e) => setVideoFile(e.target.files?.[0] || null)}
            />
          </label>
          <label>
            Category
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="New hire, Heights, Electrical"
            />
          </label>
          <label>
            Sort order
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </label>
          {SAFETY_TRACKS.map((track) => (
            <label key={track}>
              {TRACK_LABEL[track]}
              <select
                value={jobLevels[track]}
                onChange={(e) =>
                  setJobLevels((prev) => ({
                    ...prev,
                    [track]: e.target.value as "" | SafetyLevel,
                  }))
                }
              >
                <option value="">Not for this job</option>
                <option value="essential">Essential, before the extras</option>
                <option value="extra">Extra, after essentials</option>
              </select>
            </label>
          ))}
          <label className="safety-check">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />{" "}
            Active (visible to techs)
          </label>
          <div className="safety-manage-actions">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : editId ? "Save topic" : "Create topic"}
            </button>
            {editId ? (
              <>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => resetForm()}
                >
                  Cancel edit
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => void archiveTopic(editId)}
                >
                  Archive
                </button>
              </>
            ) : null}
          </div>

          <h3 style={{ fontSize: "1rem", marginTop: "1.5rem" }}>All topics</h3>
          <ul className="safety-history-list">
            {topics.map((t) => (
              <li key={t.id}>
                #{t.id} · {t.title}
                {t.category ? ` · ${t.category}` : ""}
                {Number(t.for_new_hire) === 1 ? " · new hire" : ""}
                {!t.active ? " · archived" : ""}
                {" · "}
                <button type="button" className="btn ghost btn-sm" onClick={() => startEdit(t)}>
                  Edit
                </button>
              </li>
            ))}
          </ul>
        </form>
      ) : null}
    </div>
  );
}
