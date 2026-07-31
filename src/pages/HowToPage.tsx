import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { roleLabel, type Role } from "../api";
import { useAuth } from "../auth";
import {
  defaultHowToFilter,
  guidesForFilter,
  HOWTO_GUIDES,
  HOWTO_ROLES,
  type HowToAudience,
  type HowToGuide,
} from "../howtoContent";

function GuideCard({ guide, open, onToggle }: { guide: HowToGuide; open: boolean; onToggle: () => void }) {
  return (
    <article className={`howto-card${open ? " is-open" : ""}`}>
      <button type="button" className="howto-card-toggle" onClick={onToggle} aria-expanded={open}>
        <span className="howto-card-title-block">
          <strong>{guide.title}</strong>
          <span className="howto-card-summary">{guide.summary}</span>
        </span>
        <span className="howto-card-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="howto-card-body">
          <ol className="howto-steps">
            {guide.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          {guide.tips && guide.tips.length > 0 && (
            <div className="howto-tips">
              <strong>Tips</strong>
              <ul>
                {guide.tips.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          )}
          {guide.path && (
            <Link className="btn secondary btn-sm howto-open-page" to={guide.path}>
              Open {guide.path === "/" ? "Home" : guide.path.replace(/^\//, "")}
            </Link>
          )}
        </div>
      )}
    </article>
  );
}

export function HowToPage() {
  const { user } = useAuth();
  const myRole = user?.role as Role | undefined;
  const [filter, setFilter] = useState<HowToAudience>(() => defaultHowToFilter(myRole));
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const roleMeta = HOWTO_ROLES.find((r) => r.id === filter);

  const guides = useMemo(() => {
    let list = guidesForFilter(filter);
    const q = query.trim().toLowerCase();
    if (q) {
      list = HOWTO_GUIDES.filter((g) => {
        const hay = `${g.title} ${g.summary} ${g.steps.join(" ")} ${(g.tips || []).join(" ")}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }, [filter, query]);

  // Group: everyone first, then role-specific (when not searching)
  const { common, roleSpecific } = useMemo(() => {
    if (query.trim()) {
      return { common: guides, roleSpecific: [] as HowToGuide[] };
    }
    const common = guides.filter((g) => g.roles.includes("everyone"));
    const roleSpecific = guides.filter((g) => !g.roles.includes("everyone"));
    return { common, roleSpecific };
  }, [guides, query]);

  function toggle(id: string) {
    setOpenId((prev) => (prev === id ? null : id));
  }

  function expandAll() {
    if (guides.length && openId === "__all__") {
      setOpenId(null);
      return;
    }
    // Open first; expand-all is simulated by opening a sentinel and rendering all open
    setOpenId("__all__");
  }

  const allOpen = openId === "__all__";

  return (
    <div className="page howto-page">
      <div className="page-header">
        <div>
          <h1>How-to guides</h1>
          <p>
            Short walkthroughs for everyday Field App work. Start with{" "}
            <strong>{roleLabel(myRole) || "your"}</strong> guides — switch roles below if you cover
            more than one job.
          </p>
        </div>
      </div>

      <div className="card howto-intro">
        <p className="muted" style={{ margin: 0 }}>
          Stuck on a screen? Open the matching how-to, follow the steps, then use{" "}
          <strong>Open …</strong> to jump into that page. Company policy still lives in the{" "}
          <Link to="/handbook">Handbook</Link> — this page is app training, not the employee manual.
        </p>
      </div>

      <div className="howto-toolbar card">
        <label className="howto-search">
          <span className="sr-only">Search how-tos</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search (fuel, pickup, password…)"
            autoComplete="off"
          />
        </label>
        <div className="howto-role-chips" role="tablist" aria-label="Filter by role">
          {HOWTO_ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              role="tab"
              aria-selected={!query && filter === r.id}
              className={`howto-chip${
                !query.trim() && filter === r.id ? " is-active" : ""
              }${myRole === r.id || (r.id === "everyone" && !myRole) ? " is-mine" : ""}`}
              onClick={() => {
                setQuery("");
                setFilter(r.id);
                setOpenId(null);
              }}
            >
              {r.label}
              {(myRole === r.id || (r.id === "driver" && myRole === "driver")) && r.id !== "everyone"
                ? " · you"
                : ""}
            </button>
          ))}
        </div>
        {!query.trim() && roleMeta && (
          <p className="howto-role-blurb muted">{roleMeta.blurb}</p>
        )}
        <div className="howto-toolbar-actions">
          <button type="button" className="btn secondary btn-sm" onClick={expandAll}>
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {guides.length} guide{guides.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {guides.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No guides match that search. Try “fuel”, “inventory”, or “invite”.
          </p>
        </div>
      )}

      {query.trim() ? (
        <div className="howto-list">
          {guides.map((g) => (
            <GuideCard
              key={g.id}
              guide={g}
              open={allOpen || openId === g.id}
              onToggle={() => toggle(g.id)}
            />
          ))}
        </div>
      ) : (
        <>
          {common.length > 0 && (
            <section className="howto-section">
              <h2 className="howto-section-title">Basics for everyone</h2>
              <div className="howto-list">
                {common.map((g) => (
                  <GuideCard
                    key={g.id}
                    guide={g}
                    open={allOpen || openId === g.id}
                    onToggle={() => toggle(g.id)}
                  />
                ))}
              </div>
            </section>
          )}
          {roleSpecific.length > 0 && (
            <section className="howto-section">
              <h2 className="howto-section-title">
                {filter === "everyone"
                  ? "More topics"
                  : `${HOWTO_ROLES.find((r) => r.id === filter)?.label || "Role"} tasks`}
              </h2>
              <div className="howto-list">
                {roleSpecific.map((g) => (
                  <GuideCard
                    key={g.id}
                    guide={g}
                    open={allOpen || openId === g.id}
                    onToggle={() => toggle(g.id)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <div className="card howto-footer muted">
        <p style={{ margin: "0 0 0.5rem" }}>
          Still stuck? Message your lead, or ask Admin to walk through the screen with you. If
          something in the app is broken (not just unclear), report it to Admin with the page name
          and what you tapped.
        </p>
        <p style={{ margin: 0, fontSize: "0.82rem" }}>
          Related: <Link to="/handbook">Handbook</Link>
          {user?.role === "admin" ? (
            <>
              {" · "}
              <Link to="/roles">Role simulator</Link>
            </>
          ) : null}
          {" · "}
          <Link to="/settings">Settings</Link>
        </p>
      </div>
    </div>
  );
}
