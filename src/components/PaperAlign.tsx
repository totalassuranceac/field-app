import { useEffect, useRef, useState } from "react";
import {
  analyzeBitmap,
  classifySheet,
  fileFromWarp,
  paperLabel,
  type PaperKind,
  type Pt,
} from "../lib/paperAlign";

type Props = {
  file: File;
  /** Invoices and packing slips snap only to a standard sheet, not a long receipt. */
  sheetOnly?: boolean;
  onApply: (file: File) => void;
  onKeepOriginal: (file: File) => void;
};

export function PaperAlign({ file, sheetOnly, onApply, onKeepOriginal }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [corners, setCorners] = useState<Pt[] | null>(null);
  const [kind, setKind] = useState<PaperKind>("unknown");
  const [note, setNote] = useState("Looking at the paper…");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const autoSent = useRef(false);
  const drag = useRef<number | null>(null);
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let stop = false;
    autoSent.current = false;
    setError("");
    setNote("Looking at the paper…");
    const run = async () => {
      const bitmap = await createImageBitmap(file);
      if (stop) {
        bitmap.close?.();
        return;
      }
      bitmapRef.current?.close?.();
      bitmapRef.current = bitmap;
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not read the photo");
      ctx.drawImage(bitmap, 0, 0);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.9));
      if (!blob) throw new Error("Could not read the photo");
      const nextUrl = URL.createObjectURL(blob);
      urlRef.current = nextUrl;
      const found = await analyzeBitmap(bitmap, !!sheetOnly);
      if (stop) {
        URL.revokeObjectURL(nextUrl);
        bitmap.close?.();
        return;
      }
      setUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return nextUrl;
      });
      setSize({ w: bitmap.width, h: bitmap.height });
      setCorners(found.corners);
      setKind(found.kind);
      setNote(
        found.confident
          ? `${paperLabel(found.kind)}. Straightened to the paper.`
          : found.kind === "unknown"
            ? "Drag each corner onto a corner of the paper."
            : `${paperLabel(found.kind)}. Drag a corner if an edge is off, then update.`
      );
      if (found.confident && !autoSent.current) {
        autoSent.current = true;
        const aligned = await fileFromWarp(bitmap, bitmap.width, bitmap.height, found.corners, found.kind);
        if (!stop) onApplyRef.current(aligned);
      }
    };
    void run().catch((e) => {
      if (!stop) setError(e instanceof Error ? e.message : "Could not read the photo");
    });
    return () => {
      stop = true;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      bitmapRef.current?.close?.();
      bitmapRef.current = null;
    };
  }, [file, sheetOnly]);

  function moveCorner(index: number, clientX: number, clientY: number, el: SVGSVGElement) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.min(size.w, Math.max(0, ((clientX - rect.left) / rect.width) * size.w));
    const y = Math.min(size.h, Math.max(0, ((clientY - rect.top) / rect.height) * size.h));
    setCorners((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      next[index] = { x, y };
      setKind(classifySheet(next));
      return next;
    });
  }

  async function update() {
    const bitmap = bitmapRef.current;
    if (!bitmap || !corners) return;
    setBusy(true);
    setError("");
    try {
      const useKind = classifySheet(corners);
      setKind(useKind);
      const aligned = await fileFromWarp(bitmap, bitmap.width, bitmap.height, corners, useKind);
      setNote(
        useKind === "unknown"
          ? "Cropped to the corners you set."
          : `${paperLabel(useKind)}. Straightened to the paper.`
      );
      onApply(aligned);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not straighten the photo");
    } finally {
      setBusy(false);
    }
  }

  const handleR = Math.max(size.w, size.h) * 0.018;

  return (
    <div className="paper-align">
      <div className="paper-align-head">
        <strong>Line up the paper</strong>
        {kind !== "unknown" ? <p className="muted">{paperLabel(kind)}</p> : null}
        <p className="muted">{note}</p>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {url && corners ? (
        <div className="paper-align-stage" style={{ aspectRatio: `${size.w} / ${size.h}` }}>
          <img src={url} alt="Paper to line up" draggable={false} />
          <svg
            className="paper-align-svg"
            viewBox={`0 0 ${size.w} ${size.h}`}
            onPointerMove={(e) => {
              if (drag.current == null) return;
              moveCorner(drag.current, e.clientX, e.clientY, e.currentTarget);
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerLeave={() => {
              drag.current = null;
            }}
          >
            <polygon
              points={corners.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="rgba(37, 99, 235, 0.18)"
              stroke="#2563eb"
              strokeWidth={Math.max(size.w, size.h) * 0.004}
            />
            {corners.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={handleR}
                fill="#fff"
                stroke="#1d4ed8"
                strokeWidth={Math.max(2, handleR * 0.18)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  drag.current = i;
                  e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
                }}
              />
            ))}
          </svg>
        </div>
      ) : (
        <p className="muted">Reading the photo…</p>
      )}
      <div className="toolbar">
        <button type="button" className="btn btn-sm" disabled={busy || !corners} onClick={() => void update()}>
          {busy ? "Straightening…" : "Update alignment"}
        </button>
        <button type="button" className="btn secondary btn-sm" disabled={busy} onClick={() => onKeepOriginal(file)}>
          Keep original photo
        </button>
      </div>
    </div>
  );
}
