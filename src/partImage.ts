/**
 * Resolve part image for <img src>.
 * - Absolute https → as-is
 * - App-stored upload → /api/uploads/...
 * - ServiceTitan relative path (Images/Material/...) → media proxy
 *
 * v=2 busts browsers that cached broken image bodies (D1 blobs were once
 * returned as comma-separated text instead of binary PNG/JPEG).
 */
const IMG_CACHE_VER = "v=2";

function withCacheVer(url: string): string {
  if (!url || url.startsWith("blob:") || url.startsWith("data:") || /^https?:\/\//i.test(url)) {
    return url;
  }
  if (url.includes("v=2") || url.includes("v=1")) return url;
  return url.includes("?") ? `${url}&${IMG_CACHE_VER}` : `${url}?${IMG_CACHE_VER}`;
}

export function partImageSrc(raw?: string | null): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("blob:") || s.startsWith("data:")) return s;
  // Normalize stored absolute app paths
  if (s.startsWith("/api/uploads/")) return withCacheVer(s);
  if (s.startsWith("/api/")) return withCacheVer(s);
  // Strip accidental /api/uploads prefix leftovers
  if (s.startsWith("api/uploads/")) s = s.slice("api/uploads/".length);
  // ST relative path from pricebook Image1 column
  if (
    s.startsWith("Images/") ||
    s.startsWith("Pricebook/") ||
    s.includes("/Material/")
  ) {
    return withCacheVer(`/api/inventory/media?path=${encodeURIComponent(s)}`);
  }
  // Storage key → upload URL (do not over-encode slashes in path segments only)
  if (s.startsWith("parts/") || s.startsWith("part-images/") || s.startsWith("st-media/")) {
    return withCacheVer(
      `/api/uploads/${s
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/")}`
    );
  }
  // Bare filename with image extension
  if (/\.(png|jpe?g|webp|gif)$/i.test(s) && !s.includes("://")) {
    return withCacheVer(`/api/inventory/media?path=${encodeURIComponent(s)}`);
  }
  return s.startsWith("/") ? withCacheVer(s) : null;
}
