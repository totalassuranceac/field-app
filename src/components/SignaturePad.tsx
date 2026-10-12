import { forwardRef, useEffect, useImperativeHandle, useRef, type PointerEvent } from "react";

export type SignaturePadHandle = {
  clear: () => void;
  toPngBlob: () => Promise<Blob | null>;
  isEmpty: () => boolean;
};

type Pt = { x: number; y: number };

function inkBox(strokes: Pt[][]): { w: number; h: number; n: number } {
  let n = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const p of stroke) {
      n += 1;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!n) return { w: 0, h: 0, n: 0 };
  return { w: maxX - minX, h: maxY - minY, n };
}

export const SignaturePad = forwardRef<
  SignaturePadHandle,
  { onChange?: (hasInk: boolean) => void; disabled?: boolean; caption?: string }
>(function SignaturePad({ onChange, disabled, caption = "Vendor rep signs here" }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Pt[][]>([]);
  const current = useRef<Pt[] | null>(null);
  const empty = useRef(true);

  function hasInk() {
    const box = inkBox(strokes.current);
    return box.n >= 10 && box.w >= 30 && box.h >= 12;
  }

  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = "#5a6b7d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(16, h / dpr - 36);
    ctx.lineTo(w / dpr - 16, h / dpr - 36);
    ctx.stroke();
    ctx.fillStyle = "#5a6b7d";
    ctx.font = "14px sans-serif";
    ctx.fillText(caption, 16, h / dpr - 16);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes.current) drawStroke(ctx, stroke);
    if (current.current) drawStroke(ctx, current.current);
  }

  function drawStroke(ctx: CanvasRenderingContext2D, stroke: Pt[]) {
    if (!stroke.length) return;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    if (stroke.length === 1) {
      ctx.lineTo(stroke[0].x + 0.1, stroke[0].y);
    } else {
      for (let i = 1; i < stroke.length - 1; i++) {
        const midX = (stroke[i].x + stroke[i + 1].x) / 2;
        const midY = (stroke[i].y + stroke[i + 1].y) / 2;
        ctx.quadraticCurveTo(stroke[i].x, stroke[i].y, midX, midY);
      }
      const last = stroke[stroke.length - 1];
      ctx.lineTo(last.x, last.y);
    }
    ctx.stroke();
  }

  function fit() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    paint();
  }

  useEffect(() => {
    fit();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      if (empty.current) fit();
    });
    obs.observe(canvas);
    return () => obs.disconnect();
  }, []);

  function point(ev: PointerEvent<HTMLCanvasElement>): Pt {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  useImperativeHandle(ref, () => ({
    clear() {
      strokes.current = [];
      current.current = null;
      empty.current = true;
      paint();
      onChange?.(false);
    },
    isEmpty() {
      return !hasInk();
    },
    async toPngBlob() {
      if (!hasInk()) return null;
      const src = canvasRef.current;
      if (!src) return null;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const cssW = src.width / dpr;
      const cssH = src.height / dpr;
      const out = document.createElement("canvas");
      const scale = Math.min(1, 1000 / cssW);
      out.width = Math.max(1, Math.round(cssW * scale));
      out.height = Math.max(1, Math.round(cssH * scale));
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 2.5 * scale;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      for (const stroke of strokes.current) drawStroke(ctx, stroke);
      const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
      return blob;
    },
  }));

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="vho-pad"
        aria-label="Signature pad"
        style={{ touchAction: "none" }}
        onPointerDown={(ev) => {
          if (disabled) return;
          ev.currentTarget.setPointerCapture(ev.pointerId);
          current.current = [point(ev)];
          empty.current = false;
          paint();
        }}
        onPointerMove={(ev) => {
          if (!current.current) return;
          current.current.push(point(ev));
          paint();
        }}
        onPointerUp={(ev) => {
          if (!current.current) return;
          current.current.push(point(ev));
          strokes.current.push(current.current);
          current.current = null;
          paint();
          onChange?.(hasInk());
        }}
        onPointerCancel={() => {
          current.current = null;
          paint();
        }}
      />
      <p className="vho-meta">Use your finger. Clear to start over.</p>
      <button
        type="button"
        className="btn secondary btn-sm"
        disabled={disabled}
        onClick={() => {
          strokes.current = [];
          current.current = null;
          empty.current = true;
          paint();
          onChange?.(false);
        }}
      >
        Clear
      </button>
    </div>
  );
});
