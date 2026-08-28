import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiBinary, apiBinaryWithHeaders } from "../api";
import { useAuth } from "../auth";

/** Unified camera tile (NVR channel or Wyze). */
type CamTile = {
  key: string;
  source: "nvr" | "wyze";
  id: string;
  label: string;
  enabled?: boolean;
  rtsp_path?: string;
};

/** One motion recording from the NVR / Wyze ring buffer */
type MotionClip = {
  start: string;
  end: string;
  durationSec: number;
};

/** @deprecated legacy shape — still accepted from older API responses */
type Channel = { id: number; label: string; enabled?: boolean };

type CamConfig = {
  configured: boolean;
  nvr_base_url: string;
  nvr_user: string;
  nvr_pass_set: boolean;
  channels: Channel[];
  /** Preferred: NVR + Wyze */
  cameras?: CamTile[];
  wyze_cameras?: { id: string; label: string; rtsp_path?: string; enabled?: boolean }[];
  reachable_hint: string;
  needs_tunnel: boolean;
};

function tilesFromConfig(cfg: CamConfig | null): CamTile[] {
  if (!cfg) return [];
  if (cfg.cameras?.length) {
    return cfg.cameras.filter((c) => c.enabled !== false);
  }
  // Fallback: NVR channels + default Wyze three if API is older mid-deploy
  const nvr: CamTile[] = (cfg.channels || [])
    .filter((c) => c.enabled !== false)
    .map((c) => ({
      key: `nvr:${c.id}`,
      source: "nvr" as const,
      id: String(c.id),
      label: c.label,
      enabled: true,
    }));
  // Only show Wyze when API includes them (enabled). Do not invent defaults
  // that hammer a shop proxy with no Bridge installed.
  const wyze: CamTile[] = (cfg.wyze_cameras || [])
    .filter((w) => w.enabled !== false)
    .map((w) => ({
      key: `wyze:${w.id}`,
      source: "wyze" as const,
      id: w.id,
      label: w.label,
      enabled: true,
      rtsp_path: w.rtsp_path,
    }));
  return [...nvr, ...wyze];
}

const SNAPSHOT_REFRESH_MS = 5000;
/** 2.5-minute clips — half of 5 min for faster load, still enough to scrub */
const CLIP_SEC = 150;
/** First emergency play window — shorter so the first load is not a 40MB wait */
const FIRST_PLAY_SEC = 60;
const DEFAULT_PAD_MIN = 30;
/** Play rates: normal + FF/REW cycle (1 click = 2x, 2 = 5x, 3 = 10x) */
const SPEED_STEPS = [1, 2, 5, 10] as const;

/** Snap to CLIP_SEC boundaries for clean continuous chaining */
function snapToClipStart(d: Date): Date {
  const ms = CLIP_SEC * 1000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

function canViewWarehouseCameras(
  user: { role?: string; is_warehouse?: boolean } | null | undefined
): boolean {
  if (!user) return false;
  if (user.is_warehouse) return true;
  return (
    user.role === "admin" ||
    user.role === "office" ||
    user.role === "warehouse" ||
    user.role === "supervisor"
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toDatePart(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toTimePart(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function combineDateTime(dateStr: string, timeStr: string): Date | null {
  if (!dateStr || !timeStr) return null;
  // HTML time can be "HH:MM" or "HH:MM:SS" — never append a second ":00" to seconds
  const t = timeStr.trim();
  const withSec = /^\d{1,2}:\d{2}:\d{2}$/.test(t)
    ? t
    : /^\d{1,2}:\d{2}$/.test(t)
      ? `${t}:00`
      : t;
  const d = new Date(`${dateStr}T${withSec}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function friendlyCamError(msg: string): string {
  const s = msg.replace(/\s+/g, " ").trim();
  if (/530|Tunnel error|trycloudflare/i.test(s)) {
    return "Camera link is down (tunnel offline on shop PC).";
  }
  if (/502|503|timeout|took too long/i.test(s)) {
    return "Camera took too long to respond. Try again in a moment.";
  }
  if (/No recording found|no recording near|No Wyze recording|No earlier recording|No later recording/i.test(s)) {
    return "No recording near that time. This NVR only saves motion clips — quiet gaps have no video. Try when something was moving, or jump a few minutes.";
  }
  if (
    /Wyze path not on shop|Wyze Bridge|wyze snapshot|Wyze snapshot|media proxy may be outdated|Update media proxy|install-wyze-bridge/i.test(
      s
    )
  ) {
    return "Wyze not ready on shop PC — run install-wyze-bridge.ps1 + update media proxy.";
  }
  if (
    /Document Error|Access Error 404|Can't open URL|<!DOCTYPE|no \/fieldapp\/segments|outdated/i.test(
      s
    )
  ) {
    return "Shop camera proxy is outdated. Update nvr-media-proxy on the NUC and restart FIX-CAMERAS-NOW.";
  }
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Shop-local clock label for a clip start (e.g. 3:32:15 PM) */
function formatClipTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatClipDur(sec: number): string {
  if (!Number.isFinite(sec) || sec < 1) return "1s";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function formatGapHint(gapSec: number | null | undefined): string {
  if (gapSec == null || gapSec < 45) return "";
  if (gapSec < 120) return `~${gapSec}s from pick`;
  return `~${Math.round(gapSec / 60)} min from pick`;
}

/**
 * Choose a play window inside a listed clip.
 * Short motion clips: play the whole event.
 * Long continuous segments: start near the time the user picked (emergency-friendly).
 */
function clipWindowForPlay(
  clip: MotionClip,
  around?: Date | null
): { start: Date; end: Date } {
  const segStart = new Date(clip.start);
  const segEnd = new Date(clip.end);
  const aroundMs = around && !Number.isNaN(around.getTime()) ? around.getTime() : null;
  const segMs = segEnd.getTime() - segStart.getTime();
  if (
    aroundMs != null &&
    aroundMs >= segStart.getTime() - 2000 &&
    aroundMs <= segEnd.getTime() + 2000 &&
    segMs > FIRST_PLAY_SEC * 1000
  ) {
    const start = new Date(Math.max(segStart.getTime(), aroundMs - 15_000));
    const end = new Date(Math.min(segEnd.getTime(), start.getTime() + FIRST_PLAY_SEC * 1000));
    return { start, end };
  }
  // Cap very long segments so the first load stays snappy
  const end = new Date(
    Math.min(segEnd.getTime(), segStart.getTime() + Math.max(CLIP_SEC, 180) * 1000)
  );
  return { start: segStart, end };
}

/**
 * Security camera wall — tap one camera for playback.
 * Clean picker: calendar date + time. FF/REW cycle 2x → 5x → 10x.
 */
export function WarehouseCamerasPage() {
  const { user } = useAuth();
  const allowed = canViewWarehouseCameras(user);

  const [cfg, setCfg] = useState<CamConfig | null>(null);
  const [error, setError] = useState("");
  const [tileUrls, setTileUrls] = useState<Record<string, string>>({});
  const [tileErr, setTileErr] = useState<Record<string, string>>({});
  const [proxyStatus, setProxyStatus] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [proxyError, setProxyError] = useState("");
  const blobUrlsRef = useRef<string[]>([]);

  const [viewerCh, setViewerCh] = useState<CamTile | null>(null);
  const [pickDate, setPickDate] = useState(() => toDatePart(new Date(Date.now() - 5 * 60 * 1000)));
  const [pickTime, setPickTime] = useState(() => toTimePart(new Date(Date.now() - 5 * 60 * 1000)));
  const [playBusy, setPlayBusy] = useState(false);
  const [playError, setPlayError] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  /** 0 = 1x, 1 = 2x, 2 = 5x, 3 = 10x */
  const [speedIdx, setSpeedIdx] = useState(0);
  /** forward playbackRate, or reverse via seek interval */
  const [direction, setDirection] = useState<"fwd" | "rew">("fwd");
  /** YouTube-style chrome over video */
  const [showChrome, setShowChrome] = useState(true);
  /** Motion clips near the picked time — tap to play */
  const [clipList, setClipList] = useState<MotionClip[]>([]);
  const [clipListPadMin, setClipListPadMin] = useState(DEFAULT_PAD_MIN);
  const [clipListBusy, setClipListBusy] = useState(false);
  const [activeClipIdx, setActiveClipIdx] = useState<number>(-1);
  const [nearestClipIdx, setNearestClipIdx] = useState<number>(-1);
  const [nearestGapSec, setNearestGapSec] = useState<number | null>(null);
  /** Time used for the last Find clips search — used to land inside long segments */
  const searchAroundRef = useRef<Date | null>(null);
  const clipListRef = useRef<HTMLDivElement | null>(null);

  const videoBlobRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const autoPlayGen = useRef(0);
  const rewTimerRef = useRef<number | null>(null);
  const chromeHideRef = useRef<number | null>(null);
  /** Absolute start of the clip currently loaded (actual NVR segment) */
  const clipStartRef = useRef<Date | null>(null);
  /** Absolute end of the clip currently loaded (actual NVR segment) */
  const clipEndRef = useRef<Date | null>(null);
  /** Prevent double auto-load while a chain request is in flight */
  const chainLockRef = useRef(false);
  /** Resume mode after a continuous block loads */
  const resumeRef = useRef<{
    dir: "fwd" | "rew";
    speedIdx: number;
    seek: "start" | "end";
  } | null>(null);

  const playRate = SPEED_STEPS[speedIdx] ?? 1;

  const revokeBlobs = useCallback(() => {
    for (const u of blobUrlsRef.current) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    }
    blobUrlsRef.current = [];
  }, []);

  useEffect(() => () => revokeBlobs(), [revokeBlobs]);

  useEffect(() => {
    return () => {
      if (videoBlobRef.current) {
        try {
          URL.revokeObjectURL(videoBlobRef.current);
        } catch {
          /* ignore */
        }
      }
      if (rewTimerRef.current) window.clearInterval(rewTimerRef.current);
      if (chromeHideRef.current) window.clearTimeout(chromeHideRef.current);
    };
  }, []);

  function bumpChrome() {
    setShowChrome(true);
    if (chromeHideRef.current) window.clearTimeout(chromeHideRef.current);
    // Auto-hide controls while playing forward (YouTube-style)
    chromeHideRef.current = window.setTimeout(() => {
      if (direction === "fwd" && !paused && videoUrl) setShowChrome(false);
    }, 2800);
  }

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api<CamConfig>("/warehouse-cameras/config");
        if (!cancelled) setCfg(res);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load cameras");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  const activeCameras = useMemo(() => tilesFromConfig(cfg), [cfg]);

  const cloudProxyReady = Boolean(
    cfg?.configured && cfg.nvr_pass_set && !cfg.needs_tunnel && cfg.nvr_base_url
  );

  const refreshCloudTiles = useCallback(async () => {
    if (!allowed || !cloudProxyReady || !activeCameras.length) return;
    if (viewerCh) return;

    setProxyStatus((s) => (s === "ok" ? "ok" : "loading"));
    const next: Record<string, string> = {};
    const errs: Record<string, string> = {};
    const newBlobs: string[] = [];
    let anyOk = false;
    let firstNvrErr = "";

    // NVR first (must stay fast); Wyze second with short timeout
    const ordered = [
      ...activeCameras.filter((c) => c.source === "nvr"),
      ...activeCameras.filter((c) => c.source !== "nvr"),
    ];

    await Promise.all(
      ordered.map(async (ch) => {
        try {
          const snapKey = encodeURIComponent(ch.key);
          // Wyze: fail fast if Bridge offline so NVR wall never freezes
          const timeoutMs = ch.source === "wyze" ? 8_000 : 18_000;
          const blob = await apiBinary(`/warehouse-cameras/snapshot/${snapKey}`, {
            timeoutMs,
          });
          const url = URL.createObjectURL(blob);
          newBlobs.push(url);
          next[ch.key] = url;
          anyOk = true;
        } catch (e) {
          const msg = friendlyCamError(e instanceof Error ? e.message : "Failed");
          errs[ch.key] = msg;
          if (!firstNvrErr && ch.source === "nvr") firstNvrErr = msg;
        }
      })
    );

    revokeBlobs();
    blobUrlsRef.current = newBlobs;
    setTileUrls(next);
    setTileErr(errs);

    if (anyOk) {
      setProxyStatus("ok");
      setProxyError("");
    } else {
      setProxyStatus("fail");
      setProxyError(firstNvrErr || "Could not load camera snapshots.");
    }
  }, [allowed, cloudProxyReady, activeCameras, revokeBlobs, viewerCh]);

  useEffect(() => {
    if (!cloudProxyReady || !allowed) return;
    void refreshCloudTiles();
    const id = window.setInterval(() => void refreshCloudTiles(), SNAPSHOT_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [cloudProxyReady, allowed, refreshCloudTiles]);

  const stopRewTimer = useCallback(() => {
    if (rewTimerRef.current) {
      window.clearInterval(rewTimerRef.current);
      rewTimerRef.current = null;
    }
  }, []);

  const chainBlockRef = useRef<
    ((dir: -1 | 1, playDir: "fwd" | "rew") => Promise<void>) | null
  >(null);

  const clearVideo = useCallback(
    (opts?: { keepRate?: boolean }) => {
      stopRewTimer();
      if (videoBlobRef.current) {
        try {
          URL.revokeObjectURL(videoBlobRef.current);
        } catch {
          /* ignore */
        }
        videoBlobRef.current = null;
      }
      setVideoUrl(null);
      setCurrentTime(0);
      setDuration(0);
      if (!opts?.keepRate) {
        setSpeedIdx(0);
        setDirection("fwd");
        setPaused(true);
      }
    },
    [stopRewTimer]
  );

  const loadClip = useCallback(
    async (
      ch: CamTile,
      startRaw: Date,
      opts?: {
        /** Continuous chain: keep speed and land at start or end of new block */
        chain?: { dir: "fwd" | "rew"; speedIdx: number; seek: "start" | "end" };
        /** NVR motion-segment chain mode */
        mode?: "at" | "prev" | "next";
        /** Play this exact window (from clip list) — do not snap to clock blocks */
        exactEnd?: Date;
        /** Index in clipList when playing from the picker */
        clipIndex?: number;
      }
    ) => {
      const mode = opts?.mode || "at";
      const exact = Boolean(opts?.exactEnd);
      const start =
        mode === "at" && !exact ? snapToClipStart(startRaw) : startRaw;
      // Don't load future blocks
      if (start.getTime() > Date.now() + 60_000) {
        setPlayError("No more video in that direction yet.");
        chainLockRef.current = false;
        return;
      }
      const end =
        opts?.exactEnd && opts.exactEnd.getTime() > start.getTime()
          ? opts.exactEnd
          : new Date(start.getTime() + CLIP_SEC * 1000);
      setPickDate(toDatePart(start));
      setPickTime(toTimePart(start));
      if (typeof opts?.clipIndex === "number") setActiveClipIdx(opts.clipIndex);
      setPlayBusy(true);
      setPlayError("");
      clearVideo({ keepRate: Boolean(opts?.chain) });

      const gen = ++autoPlayGen.current;
      if (opts?.chain) resumeRef.current = opts.chain;
      else resumeRef.current = null;

      try {
        const qs = new URLSearchParams({
          key: ch.key,
          start: start.toISOString(),
          end: end.toISOString(),
          // Exact list picks still use "at" on the proxy (overlap that window)
          mode: mode === "prev" || mode === "next" ? mode : "at",
        });
        const { blob, headers } = await apiBinaryWithHeaders(
          `/warehouse-cameras/clip?${qs.toString()}`,
          { timeoutMs: 300_000 }
        );
        if (gen !== autoPlayGen.current) return;

        const hdrStart = headers.get("X-Clip-Start");
        const hdrEnd = headers.get("X-Clip-End");
        const gapSec = Number(headers.get("X-Clip-Gap-Sec") || "0");
        const actualStart = hdrStart ? new Date(hdrStart) : start;
        const actualEnd = hdrEnd ? new Date(hdrEnd) : end;
        if (!Number.isNaN(actualStart.getTime())) {
          clipStartRef.current = actualStart;
          setPickDate(toDatePart(actualStart));
          setPickTime(toTimePart(actualStart));
        } else {
          clipStartRef.current = start;
        }
        clipEndRef.current = !Number.isNaN(actualEnd.getTime()) ? actualEnd : end;

        if (gapSec >= 90 && !exact) {
          const gapMin = Math.round(gapSec / 60);
          setPlayError(
            `Motion gap: no recording for ~${gapMin} min before/after this clip (NVR only saves when something moves). Use the clip list below to pick the right time.`
          );
        }

        const url = URL.createObjectURL(blob);
        videoBlobRef.current = url;
        setVideoUrl(url);

        const resume = resumeRef.current;
        resumeRef.current = null;
        const dir = resume?.dir ?? "fwd";
        const sp = resume?.speedIdx ?? 0;
        const seek = resume?.seek ?? "start";

        setDirection(dir);
        setSpeedIdx(sp);
        setPaused(false);

        window.setTimeout(() => {
          if (gen !== autoPlayGen.current) return;
          const v = videoRef.current;
          if (!v) return;
          const applySeek = () => {
            if (!v.duration || !Number.isFinite(v.duration)) return;
            if (seek === "end") {
              // Land near end so reverse can continue smoothly
              v.currentTime = Math.max(0, v.duration - 0.35);
            } else {
              v.currentTime = 0.05;
            }
            setCurrentTime(v.currentTime);
            setDuration(v.duration);
          };
          if (v.readyState >= 1) applySeek();
          else v.addEventListener("loadedmetadata", applySeek, { once: true });

          if (dir === "fwd") {
            v.playbackRate = SPEED_STEPS[sp] ?? 1;
            void v.play().catch(() => undefined);
          }
          // rew mode is applied by applyPlaybackMode effect when direction/speed set
        }, 120);
      } catch (e) {
        if (gen !== autoPlayGen.current) return;
        setPlayError(
          friendlyCamError(e instanceof Error ? e.message : "Could not load this camera’s clip")
        );
        // Stop reverse if chain failed
        setDirection("fwd");
        setSpeedIdx(0);
        setPaused(true);
      } finally {
        if (gen === autoPlayGen.current) {
          setPlayBusy(false);
          chainLockRef.current = false;
        }
      }
    },
    [clearVideo]
  );

  const fetchClipList = useCallback(
    async (
      ch: CamTile,
      around: Date,
      padMin = DEFAULT_PAD_MIN,
      opts?: { autoPlayNearest?: boolean }
    ) => {
      setClipListBusy(true);
      setPlayError("");
      searchAroundRef.current = around;
      try {
        const qs = new URLSearchParams({
          key: ch.key,
          around: around.toISOString(),
          padMin: String(padMin),
        });
        const res = await api<{
          ok: boolean;
          segments: MotionClip[];
          nearestIndex: number;
          nearestGapSec: number | null;
          padMin?: number;
        }>(`/warehouse-cameras/segments?${qs.toString()}`, { timeoutMs: 90_000 });
        const segs = res.segments || [];
        setClipList(segs);
        setClipListPadMin(res.padMin ?? padMin);
        setNearestClipIdx(res.nearestIndex ?? -1);
        setNearestGapSec(res.nearestGapSec ?? null);
        if (!segs.length) {
          setActiveClipIdx(-1);
          setPlayError(
            "No motion clips in that window. This NVR only saves when something moves — try another time or widen the search."
          );
          return segs;
        }
        // Scroll nearest into view after paint
        window.setTimeout(() => {
          const el = clipListRef.current?.querySelector(
            `[data-clip-idx="${res.nearestIndex}"]`
          ) as HTMLElement | null;
          el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }, 80);
        if (opts?.autoPlayNearest !== false && res.nearestIndex >= 0 && segs[res.nearestIndex]) {
          const nearest = segs[res.nearestIndex];
          const win = clipWindowForPlay(nearest, around);
          void loadClip(ch, win.start, {
            exactEnd: win.end,
            clipIndex: res.nearestIndex,
            mode: "at",
          });
        }
        return segs;
      } catch (e) {
        setClipList([]);
        setActiveClipIdx(-1);
        setNearestClipIdx(-1);
        setPlayError(
          friendlyCamError(e instanceof Error ? e.message : "Could not list clips")
        );
        return [];
      } finally {
        setClipListBusy(false);
      }
    },
    [loadClip]
  );

  const playClipFromList = useCallback(
    (idx: number) => {
      if (!viewerCh || playBusy) return;
      const clip = clipList[idx];
      if (!clip) return;
      const win = clipWindowForPlay(clip, searchAroundRef.current);
      if (Number.isNaN(win.start.getTime()) || Number.isNaN(win.end.getTime())) return;
      setPlayError("");
      void loadClip(viewerCh, win.start, {
        exactEnd: win.end,
        clipIndex: idx,
        mode: "at",
      });
    },
    [viewerCh, playBusy, clipList, loadClip]
  );

  const jumpClipInList = useCallback(
    (dir: -1 | 1) => {
      if (!clipList.length || playBusy) return;
      const base = activeClipIdx >= 0 ? activeClipIdx : nearestClipIdx;
      const next = Math.max(0, Math.min(clipList.length - 1, (base < 0 ? 0 : base) + dir));
      if (next === activeClipIdx && videoUrl) return;
      playClipFromList(next);
    },
    [clipList, playBusy, activeClipIdx, nearestClipIdx, videoUrl, playClipFromList]
  );

  /** Load previous / next *motion segment* (prefer clip list, else NVR prev/next) */
  const chainBlock = useCallback(
    async (dir: -1 | 1, playDir: "fwd" | "rew") => {
      if (!viewerCh || chainLockRef.current || playBusy) return;

      // Prefer jumping within the visible clip list — predictable in emergencies
      if (clipList.length > 0) {
        const base = activeClipIdx >= 0 ? activeClipIdx : nearestClipIdx;
        const next = (base < 0 ? 0 : base) + dir;
        if (next < 0 || next >= clipList.length) {
          setPlayError(
            dir < 0
              ? "No earlier clip in this list — widen the search or pick an earlier time."
              : "No later clip in this list — widen the search or pick a later time."
          );
          return;
        }
        const clip = clipList[next];
        const win = clipWindowForPlay(clip, searchAroundRef.current);
        if (Number.isNaN(win.start.getTime()) || Number.isNaN(win.end.getTime())) return;
        chainLockRef.current = true;
        stopRewTimer();
        setPlayError("");
        await loadClip(viewerCh, win.start, {
          exactEnd: win.end,
          clipIndex: next,
          mode: "at",
          chain: {
            dir: playDir,
            speedIdx: playDir === "rew" ? Math.max(1, speedIdx || 1) : Math.max(0, speedIdx),
            seek: playDir === "rew" ? "end" : "start",
          },
        });
        return;
      }

      const segStart = clipStartRef.current || combineDateTime(pickDate, pickTime);
      const segEnd =
        clipEndRef.current ||
        (segStart ? new Date(segStart.getTime() + CLIP_SEC * 1000) : null);
      if (!segStart || !segEnd) return;

      // prev: find clip ending before current start; next: clip starting after current end
      const anchor = dir < 0 ? segStart : segEnd;
      const mode = dir < 0 ? "prev" : "next";

      chainLockRef.current = true;
      stopRewTimer();
      setPlayError("");
      await loadClip(viewerCh, anchor, {
        mode,
        chain: {
          dir: playDir,
          speedIdx: playDir === "rew" ? Math.max(1, speedIdx || 1) : Math.max(0, speedIdx),
          seek: playDir === "rew" ? "end" : "start",
        },
      });
    },
    [
      viewerCh,
      playBusy,
      pickDate,
      pickTime,
      speedIdx,
      loadClip,
      stopRewTimer,
      clipList,
      activeClipIdx,
      nearestClipIdx,
    ]
  );

  chainBlockRef.current = chainBlock;

  const applyPlaybackMode = useCallback(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return;
    stopRewTimer();

    if (direction === "fwd") {
      v.playbackRate = playRate;
      if (!v.paused) void v.play().catch(() => undefined);
      return;
    }

    // Reverse: step backward (HTML video has no reliable negative rate)
    v.playbackRate = 1;
    void v.pause();
    const step = 0.12; // seconds of wall clock per tick
    const jump = playRate * step; // 2x/5x/10x
    rewTimerRef.current = window.setInterval(() => {
      const el = videoRef.current;
      if (!el) return;
      const next = Math.max(0, (el.currentTime || 0) - jump);
      el.currentTime = next;
      setCurrentTime(next);
      if (next <= 0.2) {
        stopRewTimer();
        // Continuous: load previous block
        void chainBlockRef.current?.(-1, "rew");
      }
    }, step * 1000);
  }, [direction, playRate, videoUrl, stopRewTimer]);

  useEffect(() => {
    applyPlaybackMode();
    return () => stopRewTimer();
  }, [applyPlaybackMode, stopRewTimer]);

  function openViewer(ch: CamTile) {
    const start = new Date(Date.now() - 5 * 60 * 1000);
    setViewerCh(ch);
    setPickDate(toDatePart(start));
    setPickTime(toTimePart(start));
    setPlayError("");
    chainLockRef.current = false;
    clipStartRef.current = null;
    clipEndRef.current = null;
    setClipList([]);
    setActiveClipIdx(-1);
    setNearestClipIdx(-1);
    setNearestGapSec(null);
    setClipListPadMin(DEFAULT_PAD_MIN);
    clearVideo();
    // List motion clips near now, then auto-play the nearest — no clock-block jumping
    void fetchClipList(ch, start, DEFAULT_PAD_MIN, { autoPlayNearest: true });
  }

  function closeViewer() {
    autoPlayGen.current += 1;
    setViewerCh(null);
    setPlayError("");
    setClipList([]);
    setActiveClipIdx(-1);
    setNearestClipIdx(-1);
    setNearestGapSec(null);
    clearVideo();
  }

  function onScrub(value: number) {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    // Scrubbing cancels special rates
    stopRewTimer();
    setDirection("fwd");
    setSpeedIdx(0);
    v.playbackRate = 1;
    v.currentTime = value;
    setCurrentTime(value);
  }

  function togglePlayPause() {
    const v = videoRef.current;
    if (!v || !videoUrl) return;
    if (direction === "rew") {
      // Leave reverse, resume normal play
      stopRewTimer();
      setDirection("fwd");
      setSpeedIdx(0);
      v.playbackRate = 1;
      void v.play().catch(() => undefined);
      setPaused(false);
      return;
    }
    if (v.paused) {
      void v.play().catch(() => undefined);
      setPaused(false);
    } else {
      void v.pause();
      setPaused(true);
      setSpeedIdx(0);
      v.playbackRate = 1;
    }
  }

  /** FF: 1st click 2x, 2nd 5x, 3rd 10x, 4th back to 1x */
  function cycleFastForward() {
    if (!videoUrl || !videoRef.current) return;
    stopRewTimer();
    const v = videoRef.current;
    const wasRew = direction === "rew";
    setDirection("fwd");
    setPaused(false);
    setSpeedIdx((prev) => {
      const base = wasRew ? 0 : prev;
      const next = base >= 3 ? 0 : base + 1;
      v.playbackRate = SPEED_STEPS[next] ?? 1;
      void v.play().catch(() => undefined);
      return next;
    });
  }

  /** Rew: 1st click 2x reverse, 2nd 5x, 3rd 10x, then cycles 2x again */
  function cycleRewind() {
    if (!videoUrl || !videoRef.current) return;
    const entering = direction !== "rew";
    setPaused(true);
    void videoRef.current.pause();
    setDirection("rew");
    setSpeedIdx((prev) => {
      if (entering) return 1; // start reverse at 2x
      return prev >= 3 ? 1 : prev + 1; // 2x → 5x → 10x → 2x
    });
  }

  function loadPickedSlot() {
    if (!viewerCh) return;
    if (playBusy || clipListBusy) return;
    const start = combineDateTime(pickDate, pickTime);
    if (!start) {
      setPlayError("Pick a valid date and time (use the calendar and clock).");
      return;
    }
    if (start.getTime() > Date.now()) {
      setPlayError("That time is in the future — pick a time earlier today or another day.");
      return;
    }
    setPlayError("");
    // Find motion clips near the picked time — tap the right one (e.g. 3:32 drop-off)
    void fetchClipList(viewerCh, start, clipListPadMin || DEFAULT_PAD_MIN, { autoPlayNearest: true });
  }

  function widenClipSearch() {
    if (!viewerCh || playBusy || clipListBusy) return;
    const start = combineDateTime(pickDate, pickTime) || new Date(Date.now() - 5 * 60 * 1000);
    const nextPad = clipListPadMin >= 180 ? 360 : clipListPadMin >= 60 ? 180 : 60;
    void fetchClipList(viewerCh, start, nextPad, { autoPlayNearest: true });
  }

  const speedLabel =
    direction === "rew"
      ? `◀ ${playRate}x`
      : playRate === 1
        ? "1x"
        : `${playRate}x`;

  if (!allowed) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Security cameras</h2>
        <p className="error" style={{ marginBottom: 0 }}>
          Camera access is limited to office and warehouse staff.
        </p>
      </div>
    );
  }

  return (
    <div className="warehouse-cameras-page">
      <div className="card warehouse-cam-head" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0, marginBottom: "0.25rem" }}>Security cameras</h2>
        <p className="muted" style={{ margin: 0, fontSize: "0.9rem" }}>
          {error
            ? error
            : !cfg
              ? "Loading…"
              : cloudProxyReady
                ? proxyStatus === "loading" && !Object.keys(tileUrls).length
                  ? "Loading cameras…"
                  : proxyStatus === "fail"
                    ? "Cameras temporarily unavailable."
                    : "Tap a camera to open playback. NVR + Wyze on one wall."
                : "Cameras are not available right now."}
        </p>
        {proxyError && (
          <div className="error" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
            {friendlyCamError(proxyError)}
          </div>
        )}
      </div>

      {cloudProxyReady && activeCameras.length > 0 && (
        <div className="warehouse-cam-grid">
          {activeCameras.map((ch) => (
            <button
              key={ch.key}
              type="button"
              className="warehouse-cam-tile warehouse-cam-tile-btn"
              onClick={() => openViewer(ch)}
              title={`Open ${ch.label}`}
            >
              <div className="warehouse-cam-tile-label">
                {ch.label}
                <span className="warehouse-cam-tile-hint">
                  {ch.source === "wyze" ? "Wyze · Open →" : "Open →"}
                </span>
              </div>
              <div className="warehouse-cam-tile-img-wrap">
                {tileUrls[ch.key] ? (
                  <img src={tileUrls[ch.key]} alt={ch.label} className="warehouse-cam-tile-img" />
                ) : (
                  <div className="warehouse-cam-tile-err">
                    {tileErr[ch.key] ||
                      (proxyStatus === "loading" ? "Loading…" : "No image yet")}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {viewerCh && (
        <div
          className="warehouse-cam-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeViewer();
          }}
        >
          <div
            className="card warehouse-cam-modal warehouse-cam-viewer"
            role="dialog"
            aria-modal="true"
            aria-label={`${viewerCh.label} playback`}
          >
            <div className="warehouse-cam-head-row" style={{ marginBottom: "0.75rem" }}>
              <h3 style={{ margin: 0, fontSize: "1.15rem" }}>{viewerCh.label}</h3>
              <button type="button" className="btn secondary small" onClick={closeViewer}>
                Back
              </button>
            </div>

            {/* Date + time → list of real motion clips (no quiet-gap jumping) */}
            <div className="warehouse-cam-pick-row">
              <label className="warehouse-cam-pick">
                <span>Date</span>
                <input
                  type="date"
                  value={pickDate}
                  max={toDatePart(new Date())}
                  onChange={(e) => setPickDate(e.target.value)}
                />
              </label>
              <label className="warehouse-cam-pick">
                <span>Time (shop local)</span>
                <input
                  type="time"
                  step={60}
                  value={pickTime.length === 5 ? pickTime : pickTime.slice(0, 5)}
                  onChange={(e) => {
                    // Normalize to HH:MM so Find always parses cleanly
                    const v = e.target.value;
                    setPickTime(v.length >= 5 ? v.slice(0, 5) : v);
                  }}
                />
              </label>
              <button
                type="button"
                className="btn primary warehouse-cam-find-btn"
                disabled={playBusy || clipListBusy}
                onClick={loadPickedSlot}
              >
                {clipListBusy ? "Finding..." : "Play this minute"}
              </button>
            </div>
            <p className="muted" style={{ margin: "0.35rem 0 0.5rem", fontSize: "0.85rem" }}>
              NVR saves motion only. Plays the clip nearest this minute. Quiet gaps have no video.
            </p>
            {(clipListBusy || playBusy) && (
              <p className="muted" style={{ margin: "0 0 0.5rem", fontSize: "0.85rem" }}>
                {clipListBusy
                  ? "Listing motion clips near that time…"
                  : viewerCh.source === "wyze"
                    ? "Loading Wyze clip… can take up to a minute."
                    : "Loading clip… can take up to a minute."}
              </p>
            )}

            {(clipList.length > 0 || clipListBusy) && (
              <div className="warehouse-cam-clip-list-wrap">
                <div className="warehouse-cam-clip-list-head">
                  <strong>
                    {clipListBusy
                      ? "Finding clips…"
                      : `${clipList.length} motion clip${clipList.length === 1 ? "" : "s"} (±${clipListPadMin} min)`}
                  </strong>
                  <div className="warehouse-cam-clip-list-actions">
                    <button
                      type="button"
                      className="btn secondary small"
                      disabled={
                        playBusy ||
                        clipListBusy ||
                        activeClipIdx <= 0 ||
                        (activeClipIdx < 0 && nearestClipIdx <= 0)
                      }
                      onClick={() => jumpClipInList(-1)}
                      title="Previous motion clip"
                    >
                      ← Prev clip
                    </button>
                    <button
                      type="button"
                      className="btn secondary small"
                      disabled={
                        playBusy ||
                        clipListBusy ||
                        !clipList.length ||
                        (activeClipIdx >= 0
                          ? activeClipIdx >= clipList.length - 1
                          : nearestClipIdx >= clipList.length - 1)
                      }
                      onClick={() => jumpClipInList(1)}
                      title="Next motion clip"
                    >
                      Next clip →
                    </button>
                    {clipListPadMin < 360 && (
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={playBusy || clipListBusy}
                        onClick={widenClipSearch}
                      >
                        Wider (±{clipListPadMin >= 180 ? 6 : 3}h)
                      </button>
                    )}
                  </div>
                </div>
                {nearestGapSec != null && nearestGapSec >= 90 && clipList.length > 0 && (
                  <p className="muted" style={{ margin: "0 0 0.4rem", fontSize: "0.8rem" }}>
                    Nearest clip is {formatGapHint(nearestGapSec)} — tap the list if that is not the right event.
                  </p>
                )}
                <div className="warehouse-cam-clip-list" ref={clipListRef} role="list">
                  {clipList.map((clip, idx) => {
                    const isActive = idx === activeClipIdx;
                    const isNearest = idx === nearestClipIdx;
                    return (
                      <button
                        key={`${clip.start}-${idx}`}
                        type="button"
                        role="listitem"
                        data-clip-idx={idx}
                        className={`warehouse-cam-clip-item${isActive ? " is-active" : ""}${isNearest && !isActive ? " is-nearest" : ""}`}
                        disabled={playBusy || clipListBusy}
                        onClick={() => playClipFromList(idx)}
                      >
                        <span className="warehouse-cam-clip-time">{formatClipTime(clip.start)}</span>
                        <span className="warehouse-cam-clip-dur">
                          {clip.durationSec > 180
                            ? `${formatClipDur(clip.durationSec)} - jumps to pick`
                            : formatClipDur(clip.durationSec)}
                        </span>
                        {isActive ? (
                          <span className="warehouse-cam-clip-tag">Playing</span>
                        ) : isNearest ? (
                          <span className="warehouse-cam-clip-tag warehouse-cam-clip-tag-near">Nearest</span>
                        ) : null}
                      </button>
                    );
                  })}
                  {!clipListBusy && clipList.length === 0 && (
                    <div className="warehouse-cam-clip-empty">No clips in this window</div>
                  )}
                </div>
              </div>
            )}
            <div
              className={`warehouse-cam-viewer-stage${showChrome || paused || !videoUrl ? " show-chrome" : ""}`}
              onMouseMove={bumpChrome}
              onTouchStart={bumpChrome}
            >
              {videoUrl ? (
                <video
                  ref={videoRef}
                  className="warehouse-cam-video warehouse-cam-video-large"
                  src={videoUrl}
                  playsInline
                  preload="auto"
                  controls={false}
                  onTimeUpdate={(e) => {
                    const t = e.currentTarget.currentTime || 0;
                    const d = e.currentTarget.duration || 0;
                    setCurrentTime(t);
                    // Continuous: near end while playing forward → next block
                    if (
                      direction === "fwd" &&
                      !paused &&
                      d > 1 &&
                      t >= d - 0.4 &&
                      !chainLockRef.current &&
                      !playBusy
                    ) {
                      void chainBlockRef.current?.(1, "fwd");
                    }
                  }}
                  onEnded={() => {
                    if (direction === "fwd" && !chainLockRef.current) {
                      void chainBlockRef.current?.(1, "fwd");
                    }
                  }}
                  onLoadedMetadata={(e) => {
                    setDuration(e.currentTarget.duration || 0);
                    setCurrentTime(e.currentTarget.currentTime || 0);
                    bumpChrome();
                  }}
                  onPlay={() => {
                    setPaused(false);
                    bumpChrome();
                  }}
                  onPause={() => {
                    if (direction === "fwd") setPaused(true);
                    setShowChrome(true);
                  }}
                  onClick={() => {
                    bumpChrome();
                    togglePlayPause();
                  }}
                />
              ) : tileUrls[viewerCh.key] ? (
                <img
                  src={tileUrls[viewerCh.key]}
                  alt={viewerCh.label}
                  className="warehouse-cam-video warehouse-cam-video-large warehouse-cam-video-still"
                />
              ) : (
                <div className="warehouse-cam-viewer-placeholder">
                  {clipListBusy
                    ? "Finding motion clips…"
                    : playBusy
                      ? "Loading recording…"
                      : "Pick a date and time, then Find clips"}
                </div>
              )}

              {/* YouTube-style controls over the video */}
              {videoUrl && (
                <div
                  className={`warehouse-cam-yt-chrome${showChrome || paused ? " is-visible" : ""}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="warehouse-cam-yt-gradient" />
                  <div className="warehouse-cam-yt-bar">
                    <input
                      type="range"
                      className="warehouse-cam-yt-scrub"
                      min={0}
                      max={duration > 0 ? duration : 1}
                      step={0.1}
                      value={Math.min(currentTime, duration || 0)}
                      disabled={!duration}
                      onChange={(e) => {
                        bumpChrome();
                        onScrub(Number(e.target.value));
                      }}
                      aria-label="Seek"
                    />
                    <div className="warehouse-cam-yt-row">
                      <div className="warehouse-cam-yt-controls">
                        <button
                          type="button"
                          className={`warehouse-cam-yt-btn${direction === "rew" ? " is-active" : ""}`}
                          onClick={() => {
                            bumpChrome();
                            cycleRewind();
                          }}
                          title="Rewind (2x → 5x → 10x)"
                          aria-label="Rewind"
                        >
                          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
                            <path
                              fill="currentColor"
                              d="M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="warehouse-cam-yt-btn warehouse-cam-yt-btn-play"
                          onClick={() => {
                            bumpChrome();
                            togglePlayPause();
                          }}
                          title={paused && direction === "fwd" ? "Play" : "Pause"}
                          aria-label={paused && direction === "fwd" ? "Play" : "Pause"}
                        >
                          {paused && direction === "fwd" ? (
                            <svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true">
                              <path fill="currentColor" d="M8 5v14l11-7L8 5z" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true">
                              <path fill="currentColor" d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
                            </svg>
                          )}
                        </button>
                        <button
                          type="button"
                          className={`warehouse-cam-yt-btn${direction === "fwd" && speedIdx > 0 ? " is-active" : ""}`}
                          onClick={() => {
                            bumpChrome();
                            cycleFastForward();
                          }}
                          title="Fast forward (2x → 5x → 10x)"
                          aria-label="Fast forward"
                        >
                          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
                            <path
                              fill="currentColor"
                              d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"
                            />
                          </svg>
                        </button>
                      </div>
                      <div className="warehouse-cam-yt-meta">
                        <span>
                          {formatClock(currentTime)} / {formatClock(duration)}
                        </span>
                        {speedLabel !== "1x" && (
                          <span className="warehouse-cam-yt-speed">{speedLabel}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {playBusy && (
                <div className="warehouse-cam-yt-loading">Loading clip…</div>
              )}
            </div>

            {playBusy && videoUrl && (
              <p className="muted" style={{ marginTop: "0.5rem", marginBottom: 0, fontSize: "0.85rem" }}>
                Loading next block…
              </p>
            )}
            {playError && (
              <div className="error" style={{ marginTop: "0.65rem" }}>
                {playError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
