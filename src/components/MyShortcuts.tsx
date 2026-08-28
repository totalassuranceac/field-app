import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useFavorites } from "../useFavorites";

const LONG_PRESS_MS = 3000;

/** Starred pages pinned at the top of Home for quicker access. */
export function MyShortcuts() {
  const fav = useFavorites();
  const [reorder, setReorder] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const pressPath = useRef<string | null>(null);
  const longPressed = useRef(false);

  useEffect(() => {
    return () => {
      if (pressTimer.current) window.clearTimeout(pressTimer.current);
    };
  }, []);

  function clearPress() {
    if (pressTimer.current) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressPath.current = null;
  }

  function startPress(path: string) {
    clearPress();
    longPressed.current = false;
    pressPath.current = path;
    pressTimer.current = window.setTimeout(() => {
      if (pressPath.current === path) {
        longPressed.current = true;
        setReorder(true);
        try {
          navigator.vibrate?.(20);
        } catch {
          /* ignore */
        }
      }
      pressTimer.current = null;
    }, LONG_PRESS_MS);
  }

  // Nothing starred yet — keep Home clean
  if (!fav.items.length && !fav.error) return null;

  return (
    <section className="home-section home-favs" aria-label="Starred">
      {reorder ? (
        <div className="home-favs-reorder-bar">
          <span className="muted">Rearrange with ↑ ↓ · tap ★ to remove</span>
          <button type="button" className="btn secondary btn-sm" onClick={() => setReorder(false)}>
            Done
          </button>
        </div>
      ) : null}

      {fav.error ? (
        <div className="error" style={{ marginBottom: "0.5rem" }}>
          {fav.error}
        </div>
      ) : null}

      <div className={`home-favs-grid${reorder ? " is-reorder" : ""}`}>
        {fav.items.map((r, idx) => (
          <div key={r.path} className="home-favs-tile-wrap">
            {reorder ? (
              <>
                <div className="home-favs-tile is-static">
                  <strong>{r.label}</strong>
                  {r.hint ? <span>{r.hint}</span> : null}
                </div>
                <div className="home-favs-tile-ops">
                  <button
                    type="button"
                    className="btn ghost btn-sm"
                    disabled={fav.busy || idx === 0}
                    onClick={() => fav.move(r.path, -1)}
                    aria-label={`Move ${r.label} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn ghost btn-sm"
                    disabled={fav.busy || idx === fav.items.length - 1}
                    onClick={() => fav.move(r.path, 1)}
                    aria-label={`Move ${r.label} down`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn ghost btn-sm"
                    disabled={fav.busy}
                    onClick={() => void fav.toggleFavorite(r.path)}
                    aria-label={`Unstar ${r.label}`}
                    title="Unstar"
                  >
                    ★
                  </button>
                </div>
              </>
            ) : (
              <Link
                to={r.path}
                className="home-favs-tile"
                onClick={(e) => {
                  if (longPressed.current) {
                    e.preventDefault();
                    longPressed.current = false;
                  }
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  startPress(r.path);
                }}
                onPointerUp={clearPress}
                onPointerCancel={clearPress}
                onPointerLeave={clearPress}
                onContextMenu={(e) => e.preventDefault()}
              >
                <strong>{r.label}</strong>
                {r.hint ? <span>{r.hint}</span> : null}
              </Link>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
