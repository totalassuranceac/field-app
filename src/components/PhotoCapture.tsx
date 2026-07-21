import { useRef } from "react";

/**
 * Mobile-friendly photo picker with explicit actions.
 * Many browsers only show "Upload file" for a bare <input type=file>;
 * separate Take photo (capture) vs Choose from gallery buttons fix that.
 */
export function PhotoCapture({
  onPick,
  required,
  label = "Photo",
  hint,
  previewUrl,
  onClear,
  disabled,
}: {
  onPick: (file: File | null) => void;
  required?: boolean;
  label?: string;
  hint?: string;
  previewUrl?: string | null;
  onClear?: () => void;
  disabled?: boolean;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  function handle(files: FileList | null) {
    const f = files?.[0] || null;
    onPick(f);
  }

  return (
    <div className="photo-capture">
      <div className="photo-capture-label">
        <strong>
          {label}
          {required ? " *" : ""}
        </strong>
        {hint ? (
          <p className="muted photo-capture-hint">{hint}</p>
        ) : null}
      </div>
      <div className="photo-capture-btns">
        <button
          type="button"
          className="btn"
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
          <button type="button" className="btn secondary" disabled={disabled} onClick={onClear}>
            Remove
          </button>
        ) : null}
      </div>
      {/* capture → prefers device camera on phones */}
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
      {/* no capture → gallery / file picker */}
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
      {previewUrl ? (
        <div className="photo-capture-preview">
          <img src={previewUrl} alt="Selected preview" />
        </div>
      ) : null}
    </div>
  );
}
