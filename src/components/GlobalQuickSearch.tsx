import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { FAVORITE_CATALOG, canFavoritePath } from "../favoriteRoutes";

type Hit = {
  key: string;
  label: string;
  hint?: string;
  to: string;
  kind: "page" | "person" | "unit";
};

/**
 * Quiet header typeahead — pages/routes + people + units the role can open.
 * No settings flood; Enter/tap navigates.
 */
export function GlobalQuickSearch() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Array<{ id: number; name: string }>>([]);
  const [units, setUnits] = useState<Array<{ id: number; unit_number: string; assigned_driver?: string | null }>>(
    []
  );
  const [loaded, setLoaded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || loaded || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const tasks: Promise<void>[] = [];
        if (can(user, "manageUsers") || user.role === "admin" || user.role === "office") {
          tasks.push(
            api<{ employees: Array<{ id: number; name: string; active?: number }> }>("/employees")
              .then((d) => {
                if (cancelled) return;
                setPeople(
                  (d.employees || [])
                    .filter((e) => e.active !== 0)
                    .map((e) => ({ id: e.id, name: e.name }))
                );
              })
              .catch(() => {
                /* ignore */
              })
          );
        }
        if (can(user, "manageVehicles") || can(user, "logFuel") || user.role === "driver") {
          tasks.push(
            api<{
              vehicles: Array<{
                id: number;
                unit_number: string;
                assigned_driver?: string | null;
                status?: string;
              }>;
            }>("/vehicles?filter=active&scope=fleet")
              .then((d) => {
                if (cancelled) return;
                setUnits(
                  (d.vehicles || []).map((v) => ({
                    id: v.id,
                    unit_number: String(v.unit_number || ""),
                    assigned_driver: v.assigned_driver || null,
                  }))
                );
              })
              .catch(() => {
                /* ignore */
              })
          );
        }
        await Promise.all(tasks);
        if (!cancelled) setLoaded(true);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loaded, user]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 1) return [] as Hit[];
    const out: Hit[] = [];

    for (const r of FAVORITE_CATALOG) {
      if (!canFavoritePath(user, r.path)) continue;
      const hay = `${r.label} ${r.hint || ""} ${r.path}`.toLowerCase();
      if (!hay.includes(needle)) continue;
      out.push({
        key: `p-${r.path}`,
        label: r.label,
        hint: r.hint,
        to: r.path,
        kind: "page",
      });
      if (out.length >= 8) break;
    }

    if (people.length) {
      for (const p of people) {
        if (!p.name.toLowerCase().includes(needle)) continue;
        out.push({
          key: `e-${p.id}`,
          label: p.name,
          hint: "People",
          to: `/admin?q=${encodeURIComponent(p.name)}`,
          kind: "person",
        });
        if (out.filter((h) => h.kind === "person").length >= 5) break;
      }
    }

    if (units.length) {
      const digits = needle.replace(/\D/g, "");
      for (const u of units) {
        const unit = u.unit_number.toLowerCase();
        const driver = (u.assigned_driver || "").toLowerCase();
        const match =
          unit.includes(needle) ||
          driver.includes(needle) ||
          (digits && unit.replace(/\D/g, "").includes(digits));
        if (!match) continue;
        out.push({
          key: `u-${u.id}`,
          label: `Unit ${u.unit_number}`,
          hint: u.assigned_driver || "Yard / trucks",
          to: `/yard?unit=${encodeURIComponent(u.unit_number)}`,
          kind: "unit",
        });
        if (out.filter((h) => h.kind === "unit").length >= 5) break;
      }
    }

    return out.slice(0, 12);
  }, [q, user, people, units]);

  function go(hit: Hit) {
    setOpen(false);
    setQ("");
    navigate(hit.to);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "Enter" && hits[0]) {
      e.preventDefault();
      go(hits[0]);
    }
  }

  return (
    <div className="global-quick-search" ref={rootRef}>
      <input
        ref={inputRef}
        type="search"
        className="global-quick-search-input"
        placeholder="Search…"
        value={q}
        aria-label="Quick search pages, people, units"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && q.trim() && (
        <div className="global-quick-search-menu" role="listbox">
          {!hits.length ? (
            <div className="global-quick-search-empty muted">No matches</div>
          ) : (
            hits.map((h) => (
              <button
                key={h.key}
                type="button"
                className="global-quick-search-item"
                role="option"
                onClick={() => go(h)}
              >
                <span className="global-quick-search-kind">{h.kind}</span>
                <span className="global-quick-search-label">{h.label}</span>
                {h.hint ? <span className="muted global-quick-search-hint">{h.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
