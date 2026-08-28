import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { useAuth } from "./auth";
import {
  allowedFavoriteCatalog,
  canFavoritePath,
  favoriteMeta,
  MAX_FAVORITES,
  normalizeFavoritePath,
  type FavoriteRoute,
} from "./favoriteRoutes";

function cacheKey(userId: number) {
  return `fleet_favorites_v1_${userId}`;
}

function readCache(userId: number): string[] {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String).map(normalizeFavoritePath).filter(Boolean);
  } catch {
    return [];
  }
}

function writeCache(userId: number, paths: string[]) {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(paths));
  } catch {
    /* ignore */
  }
}

export function useFavorites() {
  const { user } = useAuth();
  const userId = user?.id ?? 0;
  const [paths, setPaths] = useState<string[]>(() => (userId ? readCache(userId) : []));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!userId) {
      setPaths([]);
      setLoaded(true);
      return;
    }
    try {
      const d = await api<{ favorites: { path: string; sort_order: number }[] }>("/me/favorites");
      const next = (d.favorites || [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((f) => normalizeFavoritePath(f.path))
        .filter((p) => canFavoritePath(user, p));
      setPaths(next);
      writeCache(userId, next);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load favorites");
      // keep cache
    } finally {
      setLoaded(true);
    }
  }, [user, userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isFavorite = useCallback(
    (path: string) => paths.includes(normalizeFavoritePath(path)),
    [paths]
  );

  const toggleFavorite = useCallback(
    async (path: string) => {
      if (!userId || busy) return;
      const p = normalizeFavoritePath(path);
      if (!canFavoritePath(user, p)) return;
      setBusy(true);
      setError("");
      const had = paths.includes(p);
      try {
        if (had) {
          await api(`/me/favorites?path=${encodeURIComponent(p)}`, { method: "DELETE" });
          const next = paths.filter((x) => x !== p);
          setPaths(next);
          writeCache(userId, next);
        } else {
          if (paths.length >= MAX_FAVORITES) {
            setError(`Max ${MAX_FAVORITES} stars — unstar one first.`);
            return;
          }
          await api("/me/favorites", {
            method: "POST",
            body: JSON.stringify({ path: p }),
          });
          const next = [...paths, p];
          setPaths(next);
          writeCache(userId, next);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not update favorite");
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [busy, paths, refresh, user, userId]
  );

  const setOrderedPaths = useCallback(
    async (nextPaths: string[]) => {
      if (!userId || busy) return;
      const cleaned = nextPaths
        .map(normalizeFavoritePath)
        .filter((p, i, arr) => p && arr.indexOf(p) === i && canFavoritePath(user, p))
        .slice(0, MAX_FAVORITES);
      setBusy(true);
      setError("");
      const prev = paths;
      setPaths(cleaned);
      writeCache(userId, cleaned);
      try {
        await api("/me/favorites", {
          method: "PUT",
          body: JSON.stringify({ paths: cleaned }),
        });
      } catch (e) {
        setPaths(prev);
        writeCache(userId, prev);
        setError(e instanceof Error ? e.message : "Could not save order");
      } finally {
        setBusy(false);
      }
    },
    [busy, paths, user, userId]
  );

  const move = useCallback(
    (path: string, dir: -1 | 1) => {
      const p = normalizeFavoritePath(path);
      const i = paths.indexOf(p);
      if (i < 0) return;
      const j = i + dir;
      if (j < 0 || j >= paths.length) return;
      const next = paths.slice();
      const [item] = next.splice(i, 1);
      next.splice(j, 0, item);
      void setOrderedPaths(next);
    },
    [paths, setOrderedPaths]
  );

  const items: FavoriteRoute[] = useMemo(() => {
    return paths
      .map((p) => favoriteMeta(p))
      .filter((r): r is FavoriteRoute => !!r && canFavoritePath(user, r.path));
  }, [paths, user]);

  const addable = useMemo(() => {
    const have = new Set(paths);
    return allowedFavoriteCatalog(user).filter((r) => !have.has(r.path));
  }, [paths, user]);

  return {
    paths,
    items,
    addable,
    loaded,
    busy,
    error,
    isFavorite,
    toggleFavorite,
    setOrderedPaths,
    move,
    refresh,
    max: MAX_FAVORITES,
  };
}
