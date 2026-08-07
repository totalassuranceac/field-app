import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiBinary } from "../api";
import { useAuth } from "../auth";

type Channel = { id: number; label: string; enabled?: boolean };

type CamConfig = {
  configured: boolean;
  nvr_base_url: string;
  nvr_user: string;
  nvr_pass_set: boolean;
  channels: Channel[];
  reachable_hint: string;
  needs_tunnel: boolean;
};

const SNAPSHOT_REFRESH_MS = 5000;
/** 2.5-minute clips — half of 5 min for faster load, still enough to scrub */
const CLIP_SEC = 150;
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
  const d = new Date(`${dateStr}T${timeStr}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function friendlyCamError(msg: string): string {
  const s = msg.replace(/\s+/g, " ").trim();
  if (/530|Tunnel error|trycloudflare/i.test(s)) {
    return "Camera link is down (tunnel offline on shop PC).";
  }
  if (/502|503|timeout|took too long/i.test(s)) {
    return "Camera took too long to respond. Try again.";
  }
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
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
  const [tileUrls, setTileUrls] = useState<Record<number, string>>({});
  const [tileErr, setTileErr] = useState<Record<number, string>>({});
  const [proxyStatus, setProxyStatus] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [proxyError, setProxyError] = useState("");
  const blobUrlsRef = useRef<string[]>([]);

  const [viewerCh, setViewerCh] = useState<Channel | null>(null);
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

  const videoBlobRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const autoPlayGen = useRef(0);
  const rewTimerRef = useRef<number | null>(null);
  const chromeHideRef = useRef<number | null>(null);
  /** Absolute start of the clip currently loaded (for continuous chain) */
  const clipStartRef = useRef<Date | null>(null);
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

  const activeChannels = useMemo(
    () => (cfg?.channels || []).filter((c) => c.enabled !== false),
    [cfg]
  );

  const cloudProxyReady = Boolean(
    cfg?.configured && cfg.nvr_pass_set && !cfg.needs_tunnel && cfg.nvr_base_url
  );

  const refreshCloudTiles = useCallback(async () => {
    if (!allowed || !cloudProxyReady || !activeChannels.length) return;
    if (viewerCh) return;

    setProxyStatus((s) => (s === "ok" ? "ok" : "loading"));
    const next: Record<number, string> = {};
    const errs: Record<number, string> = {};
    const newBlobs: string[] = [];
    let anyOk = false;
    let firstErr = "";

    await Promise.all(
      activeChannels.map(async (ch) => {
        try {
          const blob = await apiBinary(`/warehouse-cameras/snapshot/${ch.id}`, {
            timeoutMs: 20_000,
          });
          const url = URL.createObjectURL(blob);
          newBlobs.push(url);
          next[ch.id] = url;
          anyOk = true;
        } catch (e) {
          const msg = friendlyCamError(e instanceof Error ? e.message : "Failed");
          errs[ch.id] = msg;
          if (!firstErr) firstErr = msg;
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
      setProxyError(firstErr || "Could not load camera snapshots.");
    }
  }, [allowed, cloudProxyReady, activeChannels, revokeBlobs, viewerCh]);

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
      ch: Channel,
      startRaw: Date,
      opts?: {
        /** Continuous chain: keep speed and land at start or end of new block */
        chain?: { dir: "fwd" | "rew"; speedIdx: number; seek: "start" | "end" };
      }
    ) => {
      const start = snapToClipStart(startRaw);
      // Don't load future blocks
      if (start.getTime() > Date.now()) {
        setPlayError("No more video in that direction yet.");
        chainLockRef.current = false;
        return;
      }
      const end = new Date(start.getTime() + CLIP_SEC * 1000);
      setPickDate(toDatePart(start));
      setPickTime(toTimePart(start));
      setPlayBusy(true);
      setPlayError("");
      clearVideo({ keepRate: Boolean(opts?.chain) });

      const gen = ++autoPlayGen.current;
      if (opts?.chain) resumeRef.current = opts.chain;
      else resumeRef.current = null;

      try {
        const blob = await apiBinary(
          `/warehouse-cameras/clip?channel=${ch.id}&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`,
          { timeoutMs: 300_000 }
        );
        if (gen !== autoPlayGen.current) return;

        const url = URL.createObjectURL(blob);
        videoBlobRef.current = url;
        clipStartRef.current = start;
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

  /** Load previous (-1) or next (+1) block for continuous scrub */
  const chainBlock = useCallback(
    async (dir: -1 | 1, playDir: "fwd" | "rew") => {
      if (!viewerCh || chainLockRef.current || playBusy) return;
      const base = clipStartRef.current || combineDateTime(pickDate, pickTime);
      if (!base) return;
      const nextStart = snapToClipStart(new Date(base.getTime() + dir * CLIP_SEC * 1000));
      // Same block (snap edge) — nothing to do
      if (clipStartRef.current && nextStart.getTime() === clipStartRef.current.getTime()) {
        if (playDir === "rew") {
          setDirection("fwd");
          setSpeedIdx(0);
          setPaused(true);
        }
        return;
      }
      chainLockRef.current = true;
      stopRewTimer();
      setPlayError("");
      await loadClip(viewerCh, nextStart, {
        chain: {
          dir: playDir,
          speedIdx: playDir === "rew" ? Math.max(1, speedIdx || 1) : Math.max(0, speedIdx),
          seek: playDir === "rew" ? "end" : "start",
        },
      });
    },
    [viewerCh, playBusy, pickDate, pickTime, speedIdx, loadClip, stopRewTimer]
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

  function openViewer(ch: Channel) {
    const start = snapToClipStart(new Date(Date.now() - 5 * 60 * 1000));
    setViewerCh(ch);
    setPickDate(toDatePart(start));
    setPickTime(toTimePart(start));
    setPlayError("");
    chainLockRef.current = false;
    clipStartRef.current = null;
    clearVideo();
    void loadClip(ch, start);
  }

  function closeViewer() {
    autoPlayGen.current += 1;
    setViewerCh(null);
    setPlayError("");
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
    const start = combineDateTime(pickDate, pickTime);
    if (!start) {
      setPlayError("Pick a valid date and time.");
      return;
    }
    void loadClip(viewerCh, start);
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
                    : "Tap a camera to open playback for that camera only."
                : "Cameras are not available right now."}
        </p>
        {proxyError && (
          <div className="error" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
            {friendlyCamError(proxyError)}
          </div>
        )}
      </div>

      {cloudProxyReady && activeChannels.length > 0 && (
        <div className="warehouse-cam-grid">
          {activeChannels.map((ch) => (
            <button
              key={ch.id}
              type="button"
              className="warehouse-cam-tile warehouse-cam-tile-btn"
              onClick={() => openViewer(ch)}
              title={`Open ${ch.label}`}
            >
              <div className="warehouse-cam-tile-label">
                {ch.label}
                <span className="warehouse-cam-tile-hint">Open →</span>
              </div>
              <div className="warehouse-cam-tile-img-wrap">
                {tileUrls[ch.id] ? (
                  <img src={tileUrls[ch.id]} alt={ch.label} className="warehouse-cam-tile-img" />
                ) : (
                  <div className="warehouse-cam-tile-err">
                    {tileErr[ch.id] ||
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

            {/* Date + time only — loads a 2.5-minute clip (faster) */}
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
                <span>Time</span>
                <input
                  type="time"
                  step={150}
                  value={pickTime}
                  onChange={(e) => setPickTime(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn primary"
                disabled={playBusy}
                onClick={loadPickedSlot}
              >
                {playBusy ? "Loading…" : "Go"}
              </button>
            </div>
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
              ) : tileUrls[viewerCh.id] ? (
                <img
                  src={tileUrls[viewerCh.id]}
                  alt={viewerCh.label}
                  className="warehouse-cam-video warehouse-cam-video-large warehouse-cam-video-still"
                />
              ) : (
                <div className="warehouse-cam-viewer-placeholder">
                  {playBusy ? "Loading recording…" : "Pick a date and time, then Go"}
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
