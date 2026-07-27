import { useRef } from "react";

/**
 * Mobile-friendly photo picker with explicit actions.
 * compact: small secondary control for inline use (model/serial, drop-off).
 */
export function PhotoCapture({
  onPick,
  required,
  label = "Photo",
  hint,
  previewUrl,
  onClear,
  disabled,
  compact,
}: {
  onPick: (file: File | null) => void;
  required?: boolean;
  label?: string;
  hint?: string;
  previewUrl?: string | null;
  onClear?: () => void;
  disabled?: boolean;
  /** Inline small upload (secondary style — not the red primary CTA) */
  compact?: boolean;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  function handle(files: FileList | null) {
    const f = files?.[0] || null;
    onPick(f);
  }

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
              onClick={onClear}
              title="Remove photo"
            >
              ✕
            </button>
          ) : null}
        </div>
        {inputs}
        {previewUrl ? (
          <div className="photo-capture-preview photo-capture-preview-compact">
            <img src={previewUrl} alt="Selected preview" />
          </div>
        ) : null}
        {hint && !previewUrl ? (
          <span className="muted photo-capture-hint-compact">{hint}</span>
        ) : null}
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
          <button type="button" className="btn ghost" disabled={disabled} onClick={onClear}>
            Remove
          </button>
        ) : null}
      </div>
      {inputs}
      {previewUrl ? (
        <div className="photo-capture-preview">
          <img src={previewUrl} alt="Selected preview" />
        </div>
      ) : null}
    </div>
  );
}
