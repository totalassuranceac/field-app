/**
 * One-shot: verify Messaging Service sender pool + A2P campaign link.
 * Reads .dev.vars locally; prints no full secrets.
 */
import fs from "node:fs";

const raw = fs.readFileSync(".dev.vars", "utf8");
const env = {};
for (const line of raw.split(/\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  env[m[1]] = v;
}

const sid = env.TWILIO_ACCOUNT_SID;
const token = env.TWILIO_AUTH_TOKEN;
if (!sid || !token) {
  console.error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in .dev.vars");
  process.exit(1);
}

const mgLocal = (env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
const fromLocal = (env.TWILIO_FROM_NUMBER || "").trim();
const wantMg = "MG88e9c097fbaf5b638d4db74c770c4b77";
const wantCm = "CM3700899ea0f3826c3d97051b83ee0ebc";
const auth = Buffer.from(`${sid}:${token}`).toString("base64");
const headers = { Authorization: `Basic ${auth}` };

const digits = (p) => String(p || "").replace(/\D/g, "");

const out = {
  local_mg_matches_expected: mgLocal === wantMg,
  local_mg_masked: mgLocal
    ? `${mgLocal.slice(0, 4)}…${mgLocal.slice(-4)}`
    : null,
  local_from_ends_6925: digits(fromLocal).endsWith("6925"),
  local_from_ends_3688: digits(fromLocal).endsWith("3688"),
};

const svcRes = await fetch(`https://messaging.twilio.com/v1/Services/${wantMg}`, {
  headers,
});
const svc = await svcRes.json();
out.service_http = svcRes.status;
out.service_sid = svc.sid || null;
out.service_friendly = svc.friendly_name || null;
out.service_error = svc.message || null;

const pnRes = await fetch(
  `https://messaging.twilio.com/v1/Services/${wantMg}/PhoneNumbers?PageSize=50`,
  { headers }
);
const pn = await pnRes.json();
const numbers = pn.phone_numbers || [];
out.sender_pool_last4 = numbers.map((p) => digits(p.phone_number).slice(-4));
out.has_6925_in_pool = numbers.some((p) =>
  digits(p.phone_number).endsWith("6925")
);
out.has_3688_in_pool = numbers.some((p) =>
  digits(p.phone_number).endsWith("3688")
);
out.pool_count = numbers.length;

const cmRes = await fetch(
  `https://messaging.twilio.com/v1/Services/${wantMg}/UsAppToPerson/${wantCm}`,
  { headers }
);
const cm = await cmRes.json();
out.campaign_http = cmRes.status;
out.campaign_sid = cm.sid || null;
out.campaign_status = cm.campaign_status || cm.status || null;
out.campaign_match = cm.sid === wantCm;
out.campaign_error = cm.message || null;
out.campaign_has_numbers = Array.isArray(cm.message_samples)
  ? undefined
  : undefined;
// phone numbers on campaign if present
if (Array.isArray(cm.phone_numbers)) {
  out.campaign_phone_last4 = cm.phone_numbers.map((p) =>
    digits(typeof p === "string" ? p : p.phone_number || p).slice(-4)
  );
}

console.log(JSON.stringify(out, null, 2));
