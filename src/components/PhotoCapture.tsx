import { useRef, useState } from "react";
import { PaperAlign } from "./PaperAlign";

/**
 * Mobile-friendly photo picker with explicit actions.
 * compact: small secondary control for inline use (model/serial, drop-off).
 */
/** Short tips that improve OCR / warehouse photo quality */
export const PHOTO_TIPS = {
  receipt:
    "Fill the frame · flat lighting · no glare on shiny paper · hold still until it snaps.",
  nameplate:
    "Equipment nameplate · fill frame with M/N & S/N · avoid metal glare.",
  dropoff: "Show the shelf or spot clearly so warehouse can find the box.",
} as const;

export function PhotoCapture({
  onPick,
  required,
  label = "Photo",
  hint,
  tip,
  previewUrl,
  onClear,
  disabled,
  compact,
  alignPaper,
  sheetOnly,
}: {
  onPick: (file: File | null) => void;
  required?: boolean;
  label?: string;
  hint?: string;
  /** OCR / quality tip under the control */
  tip?: string;
  previewUrl?: string | null;
  onClear?: () => void;
  disabled?: boolean;
  /** Inline small upload (secondary style — not the red primary CTA) */
  compact?: boolean;
  /** Straighten invoices, packing slips, and receipts before the photo is saved. */
  alignPaper?: boolean;
  /** Invoices and packing slips use a standard sheet. Receipts may be a long strip. */
  sheetOnly?: boolean;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [alignFile, setAlignFile] = useState<File | null>(null);

  function handle(files: FileList | null) {
    const f = files?.[0] || null;
    if (alignPaper && f) {
      setAlignFile(f);
      return;
    }
    setAlignFile(null);
    onPick(f);
  }

  function clearPhoto() {
    setAlignFile(null);
    onClear?.();
  }

  const aligner = alignPaper && alignFile ? (
    <PaperAlign
      file={alignFile}
      sheetOnly={sheetOnly}
      onApply={(f) => onPick(f)}
      onKeepOriginal={(f) => onPick(f)}
    />
  ) : null;

  const inputs = (
    <>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="photo-capture-input"
        tabIndex={-1}
        onChange={(e) => {
          handle(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        className="photo-capture-input"
        tabIndex={-1}
        onChange={(e) => {
          handle(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );

  if (compact) {
    return (
      <div className={`photo-capture photo-capture-compact${previewUrl ? " has-preview" : ""}`}>
        <div className="photo-capture-compact-btns">
          <button
            type="button"
            className="btn secondary btn-sm photo-upload-compact"
            disabled={disabled}
            onClick={() => cameraRef.current?.click()}
            title={label}
          >
            📷 {previewUrl ? "Retake" : "Photo"}
          </button>
          <button
            type="button"
            className="btn ghost btn-sm photo-upload-compact"
            disabled={disabled}
            onClick={() => galleryRef.current?.click()}
            title="Choose from gallery"
          >
            Gallery
          </button>
          {previewUrl && onClear ? (
            <button
              type="button"
              className="btn ghost btn-sm"
              disabled={disabled}
              onClick={clearPhoto}
              title="Remove photo"
            >
              ✕
            </button>
          ) : null}
        </div>
        {inputs}
        {aligner}
        {previewUrl && !aligner ? (
          <div className="photo-capture-preview photo-capture-preview-compact">
            <img src={previewUrl} alt="Selected preview" />
          </div>
        ) : null}
        {hint && !previewUrl ? (
          <span className="muted photo-capture-hint-compact">{hint}</span>
        ) : null}
        {tip ? <p className="muted photo-capture-tip">{tip}</p> : null}
      </div>
    );
  }

  return (
    <div className="photo-capture">
      <div className="photo-capture-label">
        <strong>
          {label}
          {required ? " *" : ""}
        </strong>
        {hint ? <p className="muted photo-capture-hint">{hint}</p> : null}
        {tip ? <p className="muted photo-capture-tip">{tip}</p> : null}
      </div>
      <div className="photo-capture-btns">
        <button
          type="button"
          className="btn secondary"
          disabled={disabled}
          onClick={() => cameraRef.current?.click()}
        >
          Take photo
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={disabled}
          onClick={() => galleryRef.current?.click()}
        >
          Choose from gallery
        </button>
        {previewUrl && onClear ? (
          <button type="button" className="btn ghost" disabled={disabled} onClick={clearPhoto}>
            Remove
          </button>
        ) : null}
      </div>
      {inputs}
      {aligner}
      {previewUrl && !aligner ? (
        <div className="photo-capture-preview">
          <img src={previewUrl} alt="Selected preview" />
        </div>
      ) : null}
    </div>
  );
}
