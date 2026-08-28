import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, can, roleLabel } from "../api";
import { useAuth } from "../auth";
import { LogItem, LogList } from "../components/CollapsibleLog";
import { topicBlocks, type HandbookBlock } from "../handbookBlocks";
import {
  getHandbookSection,
  getHandbookTopic,
  HANDBOOK_META,
  HANDBOOK_QUICK_ANSWERS,
  HANDBOOK_SECTIONS,
  neighboringTopics,
  searchHandbookTopics,
  type HandbookSection,
  type HandbookTopic,
} from "../handbookContent";

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

type View =
  | { kind: "home" }
  | { kind: "section"; sectionId: string }
  | { kind: "topic"; topicId: string };

function formatEffective(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
}

function SectionCard({
  section,
  onOpen,
}: {
  section: HandbookSection;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="handbook-nav-card" onClick={onOpen}>
      <span className="handbook-nav-card-kicker">Section {section.id}</span>
      <strong className="handbook-nav-card-title">{section.title}</strong>
      <span className="handbook-nav-card-summary">{section.summary}</span>
      <span className="handbook-nav-card-meta">
        {section.topicIds.length} topic{section.topicIds.length === 1 ? "" : "s"}
      </span>
    </button>
  );
}

function TopicRow({
  topic,
  onOpen,
}: {
  topic: HandbookTopic;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="handbook-topic-row" onClick={onOpen}>
      <span className="handbook-topic-id">{topic.id}</span>
      <span className="handbook-topic-row-main">
        <strong>{topic.title}</strong>
        <span className="handbook-topic-row-summary">{topic.summary}</span>
      </span>
      <span className="handbook-topic-chevron" aria-hidden>
        ›
      </span>
    </button>
  );
}

function HandbookBlocks({ blocks }: { blocks: HandbookBlock[] }) {
  return (
    <div className="handbook-topic-body">
      {blocks.map((b, i) => {
        if (b.type === "h") {
          return (
            <h3 key={i} className="handbook-block-h">
              {b.text}
            </h3>
          );
        }
        if (b.type === "ul") {
          return (
            <ul key={i} className="handbook-block-ul">
              {b.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          );
        }
        if (b.type === "ol") {
          return (
            <ol
              key={i}
              className={`handbook-block-ol${b.ordered === "letter" ? " is-letter" : ""}`}
            >
              {b.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ol>
          );
        }
        if (b.type === "note") {
          return (
            <aside key={i} className="handbook-block-note">
              {b.text}
            </aside>
          );
        }
        return (
          <p key={i} className="handbook-block-p">
            {b.text}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Phone-first Employee Manual: searchable sections/topics + acknowledgment.
 * Policy text lives in handbookContent.ts (migrated from the 2026 PDF).
 */
export function HandbookPage() {
  const { user } = useAuth();
  const canUpload = can(user, "manageEmployees") || user?.role === "admin";
  const isAdmin = user?.role === "admin";
  const [searchParams, setSearchParams] = useSearchParams();

  const [book, setBook] = useState<Handbook | null>(null);
  const [pending, setPending] = useState(false);
  const [ackAt, setAckAt] = useState<string | null>(null);
  const [ackName, setAckName] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  const [hasViewed, setHasViewed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const ackFormRef = useRef<HTMLFormElement | null>(null);

  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>({ kind: "home" });
  const [showAdminUpload, setShowAdminUpload] = useState(false);
  const [title, setTitle] = useState("Employee Handbook");
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const markViewed = useCallback(() => {
    setHasViewed(true);
  }, []);

  const openHome = useCallback(() => {
    setView({ kind: "home" });
    setSearchParams({}, { replace: true });
    markViewed();
  }, [markViewed, setSearchParams]);

  const openSection = useCallback(
    (sectionId: string) => {
      setQuery("");
      setView({ kind: "section", sectionId });
      setSearchParams({ section: sectionId }, { replace: true });
      markViewed();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [markViewed, setSearchParams]
  );

  const openTopic = useCallback(
    (topicId: string) => {
      setQuery("");
      setView({ kind: "topic", topicId });
      setSearchParams({ topic: topicId }, { replace: true });
      markViewed();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [markViewed, setSearchParams]
  );

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

  // Deep links: ?topic=6.2 or ?section=4
  useEffect(() => {
    const topic = (searchParams.get("topic") || "").trim();
    const section = (searchParams.get("section") || "").trim();
    if (topic && getHandbookTopic(topic)) {
      setView({ kind: "topic", topicId: topic });
      markViewed();
      return;
    }
    if (section && getHandbookSection(section)) {
      setView({ kind: "section", sectionId: section });
      markViewed();
    }
  }, [searchParams, markViewed]);

  const searchHits = useMemo(() => searchHandbookTopics(query), [query]);

  const activeSection =
    view.kind === "section" ? getHandbookSection(view.sectionId) : undefined;
  const activeTopic = view.kind === "topic" ? getHandbookTopic(view.topicId) : undefined;
  const topicNeighbors = activeTopic ? neighboringTopics(activeTopic.id) : null;
  const topicSection = activeTopic ? getHandbookSection(activeTopic.sectionId) : undefined;

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
      setOk(
        "Archive PDF uploaded. Note: staff read the in-app manual — uploading a new file still asks everyone to re-confirm."
      );
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
      setError("Open a section or topic and read the handbook first, then check the box.");
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

  const pendingCount = roster.filter((r) => !r.acknowledged).length;
  const rosterSorted = useMemo(
    () =>
      [...roster].sort((a, b) => {
        if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
        return a.display_name.localeCompare(b.display_name, undefined, {
          sensitivity: "base",
        });
      }),
    [roster]
  );

  const searching = query.trim().length > 0;

  return (
    <div className="page handbook-page">
      <div className="page-header">
        <div>
          <h1>{HANDBOOK_META.title}</h1>
          <p>
            Company policies in plain, phone-friendly sections. Search or browse to find what you
            need.
          </p>
        </div>
      </div>
      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {pending ? (
        <div className="handbook-pending-banner" role="status">
          Please read the manual below, then confirm at the bottom that you understand it.
        </div>
      ) : null}

      <div className="card handbook-meta-card">
        <div className="handbook-meta-main">
          <div className="handbook-meta-title-row">
            <strong>{HANDBOOK_META.company}</strong>
            {!pending && ackAt ? (
              <span
                className="handbook-ack-chip"
                role="status"
                title={
                  ackName
                    ? `Confirmed ${String(ackAt).replace("T", " ").slice(0, 16)} · ${ackName}`
                    : `Confirmed ${String(ackAt).replace("T", " ").slice(0, 16)}`
                }
              >
                ✓ Confirmed
              </span>
            ) : null}
          </div>
          <span className="muted">
            Version {HANDBOOK_META.versionLabel} · Effective{" "}
            {formatEffective(HANDBOOK_META.effectiveDate)}
          </span>
          <span className="muted handbook-meta-address">
            {HANDBOOK_META.address} · {HANDBOOK_META.phone}
          </span>
        </div>
      </div>

      <div className="card handbook-browse-toolbar">
        <label className="handbook-search">
          <span className="sr-only">Search handbook</span>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              markViewed();
            }}
            placeholder="Search (sick, overtime, vehicle, harassment…)"
            autoComplete="off"
          />
        </label>
        {!searching && view.kind !== "home" ? (
          <div className="handbook-crumb">
            <button type="button" className="btn secondary btn-sm" onClick={openHome}>
              All sections
            </button>
            {view.kind === "topic" && topicSection ? (
              <button
                type="button"
                className="btn secondary btn-sm"
                onClick={() => openSection(topicSection.id)}
              >
                Section {topicSection.id}: {topicSection.title}
              </button>
            ) : null}
          </div>
        ) : null}
        {!searching && view.kind === "home" ? (
          <div className="handbook-quick">
            <div className="handbook-quick-label">Quick answers</div>
            <div className="handbook-quick-chips">
              {HANDBOOK_QUICK_ANSWERS.map((q) => (
                <button
                  key={q.topicId}
                  type="button"
                  className="handbook-quick-chip"
                  onClick={() => openTopic(q.topicId)}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {searching ? (
        <section className="handbook-results">
          <h2 className="handbook-section-heading">
            Search results
            <span className="muted"> · {searchHits.length}</span>
          </h2>
          {searchHits.length === 0 ? (
            <div className="card">
              <p className="muted" style={{ margin: 0 }}>
                No topics match that search. Try “sick”, “overtime”, “vehicle”, or “harassment”.
              </p>
            </div>
          ) : (
            <div className="handbook-topic-list">
              {searchHits.map((t) => (
                <TopicRow key={t.id} topic={t} onOpen={() => openTopic(t.id)} />
              ))}
            </div>
          )}
        </section>
      ) : view.kind === "home" ? (
        <section className="handbook-sections">
          <h2 className="handbook-section-heading">Browse by section</h2>
          <div className="handbook-section-grid">
            {HANDBOOK_SECTIONS.map((s) => (
              <SectionCard key={s.id} section={s} onOpen={() => openSection(s.id)} />
            ))}
          </div>
          <p className="handbook-disclaimer muted">
            This manual replaces prior versions and is the governing document for employment
            policies. It is <strong>not a contract</strong> and does not alter at-will employment.
            Questions? Ask your manager or office.
          </p>
        </section>
      ) : view.kind === "section" && activeSection ? (
        <section className="handbook-section-view">
          <div className="handbook-exit-bar">
            <button type="button" className="btn handbook-done-btn" onClick={openHome}>
              Done
            </button>
            <button type="button" className="btn secondary" onClick={openHome}>
              All sections
            </button>
          </div>
          <div className="card handbook-section-hero">
            <span className="handbook-nav-card-kicker">Section {activeSection.id}</span>
            <h2 className="handbook-section-hero-title">{activeSection.title}</h2>
            <p className="muted" style={{ margin: "0.35rem 0 0" }}>
              {activeSection.summary}
            </p>
          </div>
          <div className="handbook-topic-list">
            {activeSection.topicIds.map((id) => {
              const t = getHandbookTopic(id);
              if (!t) return null;
              return <TopicRow key={id} topic={t} onOpen={() => openTopic(id)} />;
            })}
          </div>
        </section>
      ) : view.kind === "topic" && activeTopic ? (
        <article className="card handbook-topic-view">
          <div className="handbook-exit-bar handbook-exit-bar-in-card">
            <button type="button" className="btn handbook-done-btn" onClick={openHome}>
              Done
            </button>
            {topicSection ? (
              <button
                type="button"
                className="btn secondary"
                onClick={() => openSection(topicSection.id)}
              >
                Back to section
              </button>
            ) : (
              <button type="button" className="btn secondary" onClick={openHome}>
                All sections
              </button>
            )}
          </div>
          <header className="handbook-topic-header">
            <span className="handbook-nav-card-kicker">
              {topicSection
                ? `Section ${topicSection.id} · ${topicSection.title}`
                : `Topic ${activeTopic.id}`}
            </span>
            <h2 className="handbook-topic-title">
              <span className="handbook-topic-id-lg">{activeTopic.id}</span> {activeTopic.title}
            </h2>
          </header>
          <HandbookBlocks blocks={topicBlocks(activeTopic)} />
          <nav className="handbook-topic-nav" aria-label="Nearby topics">
            <button
              type="button"
              className="btn secondary"
              disabled={!topicNeighbors?.prev}
              onClick={() => topicNeighbors?.prev && openTopic(topicNeighbors.prev.id)}
            >
              {topicNeighbors?.prev
                ? `← ${topicNeighbors.prev.id}`
                : "← Previous"}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={!topicNeighbors?.next}
              onClick={() => topicNeighbors?.next && openTopic(topicNeighbors.next.id)}
            >
              {topicNeighbors?.next
                ? `${topicNeighbors.next.id} →`
                : "Next →"}
            </button>
          </nav>
          <div className="handbook-topic-ack-nudge">
            {pending ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  ackFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              >
                Done reading — confirm below
              </button>
            ) : (
              <button type="button" className="btn handbook-done-btn" onClick={openHome}>
                Done — back to sections
              </button>
            )}
          </div>
        </article>
      ) : (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            That section or topic was not found.{" "}
            <button type="button" className="linkish" onClick={openHome}>
              Back to all sections
            </button>
          </p>
        </div>
      )}

      {pending ? (
        <form
          ref={ackFormRef}
          className="card handbook-ack-form"
          onSubmit={(ev) => void acknowledge(ev)}
        >
          <h3 className="inv-section-title">Confirm after reading</h3>
          {!hasViewed ? (
            <p className="muted handbook-ack-hint">
              Open any section or topic above. After you’ve read, you can check the box here.
            </p>
          ) : (
            <p className="muted handbook-ack-hint">
              Check the box only after you have read and understand this manual.
            </p>
          )}

          <label className={`handbook-check-row${!hasViewed ? " is-locked" : ""}`}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!hasViewed || busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I have read and understand this Employee Manual
              {!hasViewed ? (
                <span className="muted"> — available after you open a section</span>
              ) : null}
            </span>
          </label>

          <button className="btn" type="submit" disabled={busy || !hasViewed || !confirmed}>
            {busy ? "Saving…" : "Submit confirmation"}
          </button>
        </form>
      ) : null}

      {canUpload && (
        <>
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
                  <strong>Admin → People &amp; settings → Handbook acknowledgments</strong>.
                </p>
              )}
              <LogList>
                {rosterSorted.map((r) => (
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

          <div className="card handbook-admin-archive">
            <button
              type="button"
              className="btn secondary btn-sm"
              onClick={() => setShowAdminUpload((v) => !v)}
            >
              {showAdminUpload ? "Hide archive upload" : "Admin: archive PDF upload"}
            </button>
            {showAdminUpload ? (
              <form className="handbook-admin-upload" onSubmit={(ev) => void upload(ev)}>
                <p className="muted" style={{ fontSize: "0.85rem" }}>
                  Staff read the <strong>in-app manual</strong> above. Uploading a PDF here is only
                  for archive / backup — a new upload still resets confirmations for everyone.
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
                  File (PDF)
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                    required
                  />
                </label>
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? "Uploading…" : "Upload archive PDF"}
                </button>
                {book ? (
                  <p className="muted" style={{ fontSize: "0.8rem", marginBottom: 0 }}>
                    Current ack target: {book.title}
                    {book.version_label ? ` (${book.version_label})` : ""} · uploaded{" "}
                    {String(book.created_at).replace("T", " ").slice(0, 16)}
                  </p>
                ) : null}
              </form>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
