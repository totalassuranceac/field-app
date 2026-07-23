/**
 * Soft messenger-style chime (Web Audio — no asset file).
 * Safe to call from user-gesture or after prior unlock; fails silently if blocked.
 */

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Call once from a click/tap so later automatic plays work on mobile. */
export function unlockMessageSound(): void {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => null);
  }
}

export function playMessageSound(): void {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    const play = () => {
      const now = ctx.currentTime;
      // Two soft rising beeps (Messenger-ish)
      for (const [i, freq] of [
        [0, 880],
        [0.09, 1175],
      ] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i);
        gain.gain.exponentialRampToValueAtTime(0.12, now + i + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i + 0.14);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i);
        osc.stop(now + i + 0.16);
      }
    };
    if (ctx.state === "suspended") {
      void ctx.resume().then(play).catch(() => null);
    } else {
      play();
    }
  } catch {
    /* ignore autoplay blocks */
  }
}
