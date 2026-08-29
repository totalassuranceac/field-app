/**
 * Field App → Studio trusted handoff.
 * Short-lived HMAC token; Studio verifies with the same STUDIO_SSO_SECRET.
 * Does not share fleet_session cookies across origins.
 */

import type { Env, PublicUser } from "./types";

export const STUDIO_LIVE_URL = "https://ta-ads.totalassurance.workers.dev";

const STUDIO_NAME_HINTS = [
  "chris marroquin",
  "kelsie",
  "bianca",
  "eric",
  "adam bosquez",
  "chris miller",
];

function normStudioName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.,'"_/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mirror of src/api.ts canOpenStudio — keep in sync. */
export function canOpenStudioServer(user: PublicUser | null | undefined): boolean {
  if (!user) return false;
  if (user.role === "warehouse" || user.is_warehouse) return false;
  if (user.role === "admin" || user.role === "office") return true;
  const n = normStudioName(user.display_name || "");
  if (!n) return false;
  return STUDIO_NAME_HINTS.some((hint) => {
    if (n === hint) return true;
    if (!hint.includes(" ") && n.split(" ")[0] === hint) return true;
    if (hint.includes(" ") && (n === hint || n.startsWith(hint + " ") || n.endsWith(" " + hint))) {
      return true;
    }
    return false;
  });
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlFromText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(sig);
}

/**
 * Build a one-time Studio open URL (valid ~2 minutes).
 * Returns null if SSO secret is not configured.
 */
export async function buildStudioHandoffUrl(
  env: Env,
  user: PublicUser
): Promise<{ url: string } | { error: string; status: number }> {
  const secret = (env.STUDIO_SSO_SECRET || "").trim();
  if (!secret) {
    return {
      error: "Studio SSO is not configured on the server",
      status: 503,
    };
  }
  if (!canOpenStudioServer(user)) {
    return { error: "Forbidden", status: 403 };
  }
  const studioBase = (env.STUDIO_URL || STUDIO_LIVE_URL).replace(/\/+$/, "");
  const payload = {
    v: 1,
    exp: Date.now() + 2 * 60 * 1000,
    uid: user.id,
    name: user.display_name || "",
    role: user.role,
  };
  const body = b64urlFromText(JSON.stringify(payload));
  const sig = await hmacSha256(secret, body);
  const token = `${body}.${sig}`;
  return { url: `${studioBase}/api/sso?t=${encodeURIComponent(token)}` };
}
