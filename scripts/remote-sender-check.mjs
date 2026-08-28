/**
 * Runs Twilio Messaging Service checks using credentials from env
 * (set by caller). Prints no secrets.
 *
 * Expected env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * optional TWILIO_MESSAGING_SERVICE_SID
 */
const accountSid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const token = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const mg = (
  process.env.TWILIO_MESSAGING_SERVICE_SID ||
  "MG88e9c097fbaf5b638d4db74c770c4b77"
).trim();
const expectCm = "CM3700899ea0f3826c3d97051b83ee0ebc";

if (!accountSid || !token) {
  console.log(JSON.stringify({ ok: false, error: "missing Twilio env" }));
  process.exit(2);
}

const auth = Buffer.from(`${accountSid}:${token}`).toString("base64");
const headers = { Authorization: `Basic ${auth}` };
const digits = (p) => String(p || "").replace(/\D/g, "");

const svcRes = await fetch(`https://messaging.twilio.com/v1/Services/${mg}`, {
  headers,
});
const svc = await svcRes.json();

const pnRes = await fetch(
  `https://messaging.twilio.com/v1/Services/${mg}/PhoneNumbers?PageSize=50`,
  { headers }
);
const pn = await pnRes.json();
const pool = pn.phone_numbers || [];

const cmRes = await fetch(
  `https://messaging.twilio.com/v1/Services/${mg}/UsAppToPerson/${expectCm}`,
  { headers }
);
const cm = await cmRes.json();

console.log(
  JSON.stringify(
    {
      ok:
        svcRes.ok &&
        pool.some((p) => digits(p.phone_number).endsWith("6925")) &&
        cm.sid === expectCm,
      mg_masked: `${mg.slice(0, 4)}…${mg.slice(-4)}`,
      service_http: svcRes.status,
      service_sid: svc.sid || null,
      pool_last4: pool.map((p) => digits(p.phone_number).slice(-4)),
      has_6925: pool.some((p) => digits(p.phone_number).endsWith("6925")),
      has_3688: pool.some((p) => digits(p.phone_number).endsWith("3688")),
      campaign_http: cmRes.status,
      campaign_sid: cm.sid || null,
      campaign_status: cm.campaign_status || cm.status || null,
      campaign_linked: cm.sid === expectCm,
      campaign_error: cm.message || null,
    },
    null,
    2
  )
);
