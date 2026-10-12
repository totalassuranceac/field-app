export type GpsStatus = "ok" | "denied" | "unavailable" | "timeout" | "unsupported" | "skipped";

export type GpsResult = {
  status: GpsStatus;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
};

export function newClientUuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function fmtCt(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (!Number.isFinite(ms)) return iso;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
  return `${text} CT`;
}

/** Capture once. result() never throws and resolves with whatever is known. */
export function startGps(): { result: () => Promise<GpsResult> } {
  let settled: GpsResult = {
    status: "skipped",
    lat: null,
    lng: null,
    accuracy_m: null,
  };
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    settled = { status: "unsupported", lat: null, lng: null, accuracy_m: null };
    return { result: async () => settled };
  }
  let done = false;
  const pending = new Promise<GpsResult>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        done = true;
        settled = {
          status: "ok",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        };
        resolve(settled);
      },
      (err) => {
        done = true;
        const code = err?.code;
        const status: GpsStatus = code === 1 ? "denied" : code === 2 ? "unavailable" : code === 3 ? "timeout" : "skipped";
        settled = { status, lat: null, lng: null, accuracy_m: null };
        resolve(settled);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });
  return {
    result: async () => {
      if (done) return settled;
      return Promise.race([
        pending,
        new Promise<GpsResult>((resolve) => {
          window.setTimeout(() => resolve(settled.status === "ok" ? settled : { ...settled, status: settled.status === "skipped" && !done ? "skipped" : settled.status }), 0);
        }),
      ]);
    },
  };
}

export function buildHandoffForm(
  fields: Record<string, string | number | null | undefined>,
  signatureBlob: Blob,
  photoFile: File
): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    fd.set(key, String(value));
  }
  fd.set("signature", new File([signatureBlob], "signature.png", { type: "image/png" }));
  fd.set("photo", new File([photoFile], "handoff.jpg", { type: photoFile.type || "image/jpeg" }));
  return fd;
}

export function openReceipt(id: number, print = true): void {
  const q = print ? "?print=1" : "";
  window.open(`/api/handoffs/${id}/receipt${q}`, "_blank", "noopener");
}
