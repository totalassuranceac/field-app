import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

type SafetyTopic = {
  id: number;
  title: string;
  body: string | null;
  video_url: string | null;
  video_file_key: string | null;
  sort_order: number;
  active: number;
  my_completion_count?: number;
  completion_count?: number;
};

type SafetyCompletion = {
  id: number;
  topic_id: number;
  user_id: number;
  completed_at: string;
  topic_title?: string;
  user_name?: string;
  stamped_by_name?: string | null;
  is_retake?: number;
};

function videoSrc(t: SafetyTopic): string | null {
  if (t.video_url?.trim()) return t.video_url.trim();
  if (t.video_file_key?.trim()) {
    return `/api/uploads/${encodeURIComponent(t.video_file_key.trim())}`;
  }
  return null;
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
    <p class="foot">Private training record · stamped in Field App · not a public ranking</p>
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
  const [videoFile, setVideoFile] = useState<File | null>(null);

  const loadTopics = useCallback(async () => {
    const d = await api<{ topics: SafetyTopic[]; error?: string }>("/safety/topics");
    setTopics(d.topics || []);
    if (d.error) setError(d.error);
  }, []);

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

  function resetForm() {
    setEditId(null);
    setTitle("");
    setBody("");
    setVideoUrl("");
    setSortOrder("0");
    setActive(true);
    setVideoFile(null);
  }

  function startEdit(t: SafetyTopic) {
    setEditId(t.id);
    setTitle(t.title || "");
    setBody(t.body || "");
    setVideoUrl(t.video_url || "");
    setSortOrder(String(t.sort_order ?? 0));
    setActive(!!t.active);
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
      const d = await api<{ completion: SafetyCompletion }>("/safety/completions", {
        method: "POST",
        body: JSON.stringify({ topic_id: topicDetail.id, video_opened: videoOpened }),
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
        <p className="muted safety-deploy-note">Safety is not live until Chris deploys.</p>
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
        <p className="muted safety-deploy-note">Safety is not live until Chris deploys.</p>
        <div className="page-header">
          <div>
            <button type="button" className="btn ghost btn-sm" onClick={() => navigate("/safety")}>
              ← All topics
            </button>
            <h1 style={{ marginTop: "0.5rem" }}>{topicDetail.title}</h1>
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

        <div className="card safety-video-card">
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Training video</h2>
          {src ? (
            <>
              <video
                className="safety-video"
                controls
                src={src}
                onPlay={() => setVideoOpened(true)}
                onLoadedData={() => {
                  /* opened in player */
                }}
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
          ) : (
            <p className="muted">No video yet — Chris will add the URL or file.</p>
          )}
        </div>

        <div className="card safety-complete-card">
          <button
            type="button"
            className="btn"
            disabled={busy || !videoOpened || alreadyDone}
            onClick={() => void markComplete()}
            title={
              !videoOpened
                ? "Open or play the video first"
                : alreadyDone
                  ? "Already stamped — open Cert from history, or ask admin for a retake"
                  : "Stamp completion"
            }
          >
            {busy
              ? "Saving…"
              : alreadyDone
                ? "Already completed"
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
                  {c.is_retake ? " · retake" : ""}
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
      <p className="muted safety-deploy-note">Safety is not live until Chris deploys.</p>
      <div className="page-header">
        <div>
          <h1>Safety</h1>
          <p className="muted" style={{ margin: 0 }}>
            Private training — your topics and stamps only. No rankings or public scores.
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
        <ul className="safety-topic-list">
          {!topics.length ? (
            <li className="card muted">
              {isAdmin
                ? "No topics yet — open Manage topics to add one. Seed may include an archived Untitled row."
                : "No active safety topics yet."}
            </li>
          ) : null}
          {topics
            .filter((t) => isAdmin || t.active)
            .map((t) => (
              <li key={t.id} className="card safety-topic-row">
                <div>
                  <Link to={`/safety/topics/${t.id}`} className="safety-topic-title">
                    <strong>{t.title}</strong>
                  </Link>
                  {!t.active ? <span className="muted"> · archived</span> : null}
                  <div className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                    {(t.my_completion_count || 0) > 0
                      ? "Completed"
                      : t.video_url || t.video_file_key
                        ? "Video ready"
                        : "No video yet"}
                    {isAdmin && t.completion_count != null
                      ? ` · ${t.completion_count} stamp${t.completion_count === 1 ? "" : "s"}`
                      : ""}
                  </div>
                </div>
                <div className="safety-topic-actions">
                  <Link className="btn btn-sm" to={`/safety/topics/${t.id}`}>
                    Open
                  </Link>
                  {isAdmin ? (
                    <button
                      type="button"
                      className="btn ghost btn-sm"
                      onClick={() => startEdit(t)}
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
        </ul>
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
                {c.is_retake ? " · retake" : ""}
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

      {tab === "manage" && isAdmin ? (
        <form className="card safety-manage-form" onSubmit={saveTopic}>
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>
            {editId ? `Edit topic #${editId}` : "New topic"}
          </h2>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Add real video URLs when ready — do not invent OSHA course text here.
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
            Sort order
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </label>
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
