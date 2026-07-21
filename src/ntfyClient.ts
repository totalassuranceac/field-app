/**
 * Publish to ntfy from the browser/phone network.
 *
 * Cloudflare Workers often cannot reach ntfy.sh (522 / timeouts).
 * Phones and PCs can — so emergencies publish the push from the client.
 * Everyone subscribed to the same topic still receives it.
 *
 * Test pushes always worked because Settings used a simple client publish.
 * Emergencies used to go server-only (failed) or depended only on server
 * client_push after a slow API call. This module matches the reliable test path
 * and tries several publish styles for flaky mobile networks.
 */

export type ClientPushPayload = {
  server?: string;
  topic: string;
  title: string;
  message: string;
  priority?: number;
  tags?: string[];
};

export const DEFAULT_NTFY_TOPIC = "totalassurance";
/** Quiet Settings tests only — does not notify the fleet/mechanic. */
export const NTFY_ADMIN_TEST_TOPIC = "totalassurance-admin";
export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

function asciiHeader(s: string, max = 120): string {
  return (
    (s || "Fleet alert")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max) || "Fleet alert"
  );
}

function normalizeServer(server?: string): string {
  let s = (server || DEFAULT_NTFY_SERVER).trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s || DEFAULT_NTFY_SERVER;
}

/** Build the same style of payload the Settings test uses (proven on phones). */
export function buildIssuePush(opts: {
  unitNumber: string;
  title: string;
  description?: string | null;
  reporterName?: string;
  emergency: boolean;
  topic?: string;
  server?: string;
}): ClientPushPayload {
  const unit = opts.unitNumber || "?";
  const label = opts.title || "Issue";
  return {
    server: normalizeServer(opts.server),
    topic: (opts.topic || DEFAULT_NTFY_TOPIC).trim() || DEFAULT_NTFY_TOPIC,
    title: opts.emergency
      ? `EMERGENCY Unit ${unit}: ${label}`
      : `Repair Unit ${unit}: ${label}`,
    message: [
      opts.reporterName ? `From: ${opts.reporterName}` : null,
      (opts.description || "").trim().slice(0, 120) ||
        (opts.emergency ? "Needs help now — open the fleet app." : "New shop request."),
      opts.emergency
        ? "Open Notifications / Repairs in Field App ASAP."
        : "Open Repairs & shop board.",
    ]
      .filter(Boolean)
      .join("\n"),
    // Keep tags simple — same family as working test pushes
    priority: opts.emergency ? 5 : 4,
    tags: opts.emergency ? ["rotating_light", "warning"] : ["wrench", "warning"],
  };
}

/**
 * Publish via multiple methods (JSON first — no custom headers / fewer CORS issues,
 * then classic Title headers, then plain body). Retries between methods.
 */
export async function publishNtfyFromClient(
  payload: ClientPushPayload
): Promise<{ ok: boolean; detail: string }> {
  const topic = (payload.topic || DEFAULT_NTFY_TOPIC).trim() || DEFAULT_NTFY_TOPIC;
  const server = normalizeServer(payload.server);
  const title = asciiHeader(payload.title, 200);
  const message = (payload.message || "Open the fleet app.").slice(0, 3900);
  const priority = payload.priority ?? 5;
  const tags = payload.tags?.length ? payload.tags : ["warning"];
  const errors: string[] = [];

  // 1) JSON API (what many ntfy web clients use — reliable from browsers)
  try {
    const res = await fetch(`${server}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        title,
        message,
        priority,
        tags,
      }),
    });
    if (res.ok) return { ok: true, detail: `client ntfy json ok → ${topic}` };
    const t = await res.text().catch(() => "");
    errors.push(`json ${res.status}: ${t.slice(0, 60)}`);
  } catch (e) {
    errors.push(`json err: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) Classic /topic + Title headers (same as successful PC/tests)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: {
          Title: title,
          Priority: String(priority),
          Tags: tags.join(","),
        },
        body: message,
      });
      if (res.ok) {
        return {
          ok: true,
          detail:
            attempt > 1
              ? `client ntfy classic ok (try ${attempt}) → ${topic}`
              : `client ntfy classic ok → ${topic}`,
        };
      }
      const t = await res.text().catch(() => "");
      errors.push(`classic ${res.status}: ${t.slice(0, 60)}`);
    } catch (e) {
      errors.push(`classic err: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
  }

  // 3) Bare body (no custom headers) — always delivers message text
  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      body: `${title}\n\n${message}`,
    });
    if (res.ok) return { ok: true, detail: `client ntfy plain ok → ${topic}` };
    const t = await res.text().catch(() => "");
    errors.push(`plain ${res.status}: ${t.slice(0, 60)}`);
  } catch (e) {
    errors.push(`plain err: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { ok: false, detail: errors.join(" | ") || "client ntfy failed" };
}

/** Best-effort log result back to the worker (for Settings diagnostics). */
export async function reportClientPushResult(
  apiFn: (path: string, opts?: RequestInit) => Promise<unknown>,
  result: { ok: boolean; detail: string }
): Promise<void> {
  try {
    await apiFn("/alerts/client-push-result", {
      method: "POST",
      body: JSON.stringify({ ok: result.ok, detail: result.detail }),
    });
  } catch {
    /* non-fatal */
  }
}
