import { useCallback, useEffect, useRef, useState } from "react";

type Detected = { rawValue: string; format?: string };

/**
 * Camera barcode / QR scan for phones.
 * Uses BarcodeDetector when available (Chrome/Android/Edge); otherwise
 * "Take photo of code" still opens the camera so a human can read it into the field.
 */
export function BarcodeScanButton({
  onCode,
  disabled,
  label = "Scan with camera",
}: {
  onCode: (code: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const photoRef = useRef<HTMLInputElement>(null);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => () => stop(), [stop]);

  async function startLive() {
    setError("");
    setBusy(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const BD = (window as any).BarcodeDetector;
      if (!BD || !navigator.mediaDevices?.getUserMedia) {
        // Fall back: open camera via file capture
        photoRef.current?.click();
        setBusy(false);
        return;
      }

      setOpen(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("Camera view not ready");
      video.srcObject = stream;
      await video.play();

      const detector = new BD({
        formats: [
          "qr_code",
          "ean_13",
          "ean_8",
          "code_128",
          "code_39",
          "upc_a",
          "upc_e",
          "itf",
          "codabar",
        ],
      });

      const tick = async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) {
          rafRef.current = requestAnimationFrame(() => void tick());
          return;
        }
        try {
          const codes: Detected[] = await detector.detect(videoRef.current);
          if (codes?.length && codes[0].rawValue) {
            const val = String(codes[0].rawValue).trim();
            if (val) {
              onCode(val);
              stop();
              setOpen(false);
              setBusy(false);
              return;
            }
          }
        } catch {
          /* keep scanning */
        }
        rafRef.current = requestAnimationFrame(() => void tick());
      };
      rafRef.current = requestAnimationFrame(() => void tick());
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open camera");
      stop();
      setOpen(false);
      setBusy(false);
      // Last resort: capture file
      photoRef.current?.click();
    }
  }

  async function onPhoto(file: File | null) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const BD = (window as any).BarcodeDetector;
      if (BD) {
        const detector = new BD();
        const bmp = await createImageBitmap(file);
        const codes: Detected[] = await detector.detect(bmp);
        bmp.close?.();
        if (codes?.length && codes[0].rawValue) {
          onCode(String(codes[0].rawValue).trim());
          setBusy(false);
          return;
        }
        setError("No barcode found in photo — type the part # or try again.");
      } else {
        setError(
          "This phone browser can’t auto-read barcodes. Use a USB/Bluetooth scanner, type the part #, or try Chrome on Android."
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="barcode-scan">
      <button
        type="button"
        className="btn secondary barcode-scan-btn"
        disabled={disabled || busy}
        onClick={() => void startLive()}
      >
        {busy ? "Opening camera…" : label}
      </button>
      <input
        ref={photoRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="photo-capture-input"
        tabIndex={-1}
        onChange={(e) => {
          void onPhoto(e.target.files?.[0] || null);
          e.target.value = "";
        }}
      />
      {error ? <p className="error barcode-scan-err">{error}</p> : null}
      {open && (
        <div className="barcode-scan-overlay" role="dialog" aria-label="Scan barcode">
          <div className="barcode-scan-panel">
            <p className="barcode-scan-title">Point at barcode or QR</p>
            <video ref={videoRef} className="barcode-scan-video" playsInline muted />
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                stop();
                setOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
