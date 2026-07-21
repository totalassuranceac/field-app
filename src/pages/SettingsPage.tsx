import { FormEvent, useEffect, useState } from "react";
import { api, can } from "../api";
import { useTheme } from "../theme";
import { useAuth } from "../auth";
import { NtfySetupBanner } from "../components/NtfySetupBanner";
import {
  DEFAULT_NTFY_TOPIC,
  NTFY_ADMIN_TEST_TOPIC,
  publishNtfyFromClient,
  reportClientPushResult,
  type ClientPushPayload,
} from "../ntfyClient";

interface SmsContact {
  user_id: number | null;
  name: string;
  phone: string;
  role: string;
  unit_number?: string | null;
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { user, refresh, logout } = useAuth();
  const [phone, setPhone] = useState(user?.phone || "");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const forced = Boolean(user?.must_change_password);

  const [smsConfigured, setSmsConfigured] = useState(false);
  const [contacts, setContacts] = useState<SmsContact[]>([]);
  const [smsTo, setSmsTo] = useState("");
  const [smsMsg, setSmsMsg] = useState("");
  const [smsBusy, setSmsBusy] = useState(false);
  const [shopPhone, setShopPhone] = useState("");
  const [mechanicPhone, setMechanicPhone] = useState("");
  const [officePhone, setOfficePhone] = useState("");
  const [rolePhonesBusy, setRolePhonesBusy] = useState(false);
  const [ntfyTopic, setNtfyTopic] = useState("");
  const [ntfyServer, setNtfyServer] = useState("https://ntfy.sh");
  const [discordUrl, setDiscordUrl] = useState("");
  const [freeNtfyOn, setFreeNtfyOn] = useState(false);
  const [freeDiscordOn, setFreeDiscordOn] = useState(false);
  const [lastNtfyStatus, setLastNtfyStatus] = useState("");
  const [testBusy, setTestBusy] = useState(false);

  useEffect(() => {
    setPhone(user?.phone || "");
  }, [user?.phone]);

  useEffect(() => {
    if (forced) return;
    api<{ configured: boolean; contacts: SmsContact[] }>("/sms/contacts")
      .then((d) => {
        setSmsConfigured(d.configured);
        setContacts(d.contacts || []);
        if (d.contacts?.length === 1) {
          const c = d.contacts[0];
          setSmsTo(c.user_id ? `u:${c.user_id}` : `p:${c.phone}`);
        }
      })
      .catch(() => {
        setSmsConfigured(false);
        setContacts([]);
      });
    if (can(user, "manageIssues") || user?.role === "admin" || user?.role === "office") {
      api<{
        shop_phone?: string;
        mechanic_phone?: string;
        office_phone?: string;
        free_alerts?: {
          ntfy: boolean;
          ntfy_topic?: string;
          ntfy_server?: string;
          discord: boolean;
          last_ntfy_status?: string;
        };
      }>("/sms/status")
        .then((s) => {
          setShopPhone(s.shop_phone || "");
          setMechanicPhone(s.mechanic_phone || "");
          setOfficePhone(s.office_phone || "");
          setFreeNtfyOn(Boolean(s.free_alerts?.ntfy));
          setFreeDiscordOn(Boolean(s.free_alerts?.discord));
          setNtfyTopic(s.free_alerts?.ntfy_topic || "totalassurance");
          setNtfyServer(s.free_alerts?.ntfy_server || "https://ntfy.sh");
          setLastNtfyStatus(s.free_alerts?.last_ntfy_status || "");
        })
        .catch(() => {});
    }
  }, [forced, user]);

  async function savePhone(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    try {
      await api("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ phone: phone.trim() || null }),
      });
      await refresh();
      setOk("Phone saved — used for SMS and repair reminders.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save phone");
    }
  }

  async function saveRolePhones(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    setRolePhonesBusy(true);
    try {
      if (user?.role === "admin") {
        await api("/sms/role-phones", {
          method: "PUT",
          body: JSON.stringify({
            shop_phone: shopPhone.trim(),
            mechanic_phone: mechanicPhone.trim(),
            office_phone: officePhone.trim(),
          }),
        });
        setOk("Shop, mechanic, and office phone numbers saved.");
      } else {
        await api("/sms/shop-phone", {
          method: "PUT",
          body: JSON.stringify({ phone: shopPhone.trim() }),
        });
        setOk("Shop SMS number saved — drivers can text this number from Settings.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save phone numbers");
    } finally {
      setRolePhonesBusy(false);
    }
  }

  async function saveFreeAlerts(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    try {
      const topic = (ntfyTopic.trim() || "totalassurance").toLowerCase();
      setNtfyTopic(topic);
      await api("/alerts/channels", {
        method: "PUT",
        body: JSON.stringify({
          ntfy_topic: topic,
          ntfy_server: ntfyServer.trim() || "https://ntfy.sh",
          discord_webhook_url: discordUrl.trim(),
        }),
      });
      setFreeNtfyOn(true);
      setFreeDiscordOn(Boolean(discordUrl.trim()));
      setOk(`Saved. Tell the team: install ntfy and join “${topic}”.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save free alerts");
    }
  }

  /** Quiet admin channel only — does not notify mechanic on fleet topic. */
  async function testFreeAlert() {
    setTestBusy(true);
    setError("");
    setOk("");
    try {
      const fleetTopic = (ntfyTopic.trim() || DEFAULT_NTFY_TOPIC).toLowerCase();
      setNtfyTopic(fleetTopic);
      await api("/alerts/channels", {
        method: "PUT",
        body: JSON.stringify({
          ntfy_topic: fleetTopic,
          ntfy_server: ntfyServer.trim() || "https://ntfy.sh",
        }),
      });
      const r = await api<{
        ok: boolean;
        ntfy: boolean;
        discord: boolean;
        details: string[];
        hint?: string;
        test_topic?: string;
        fleet_topic?: string;
        client_push?: ClientPushPayload;
      }>("/alerts/test", { method: "POST", body: JSON.stringify({}) });

      const topic = r.test_topic || r.client_push?.topic || NTFY_ADMIN_TEST_TOPIC;
      const fleet = r.fleet_topic || fleetTopic;

      const payload: ClientPushPayload = r.client_push || {
        server: ntfyServer.trim() || "https://ntfy.sh",
        topic,
        title: "TA Fleet admin test",
        message: `Admin test from ${user?.display_name || "fleet"}. Topic: ${topic}.`,
        priority: 5,
        tags: ["rotating_light", "warning"],
      };
      const push = await publishNtfyFromClient({ ...payload, topic, priority: 5 });
      void reportClientPushResult(api, push);

      setLastNtfyStatus(
        [
          push.ok ? `test → ${topic}: ${push.detail}` : `test failed: ${push.detail}`,
          r.ntfy ? "server backup: ok" : `server backup: ${(r.details || []).join("; ") || "failed"}`,
        ].join(" · ")
      );

      if (push.ok || r.ntfy) {
        setOk(
          `Test sent only to “${topic}”. Fleet “${fleet}” was not notified — mechanic stays quiet. Subscribe to “${topic}” in ntfy if you didn’t get it.`
        );
      } else {
        setError(
          `Test failed: ${push.detail || "unknown"}. In ntfy, Subscribe to “${topic}” (admin tests only).`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTestBusy(false);
    }
  }

  async function sendText(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    if (!smsMsg.trim()) {
      setError("Type a message first.");
      return;
    }
    if (!smsTo) {
      setError("Choose who to text.");
      return;
    }
    setSmsBusy(true);
    try {
      const payload: { message: string; to_user_id?: number; to_phone?: string; context?: string } = {
        message: smsMsg.trim(),
        context: "settings_sms",
      };
      if (smsTo.startsWith("u:")) payload.to_user_id = Number(smsTo.slice(2));
      else if (smsTo.startsWith("p:")) payload.to_phone = smsTo.slice(2);
      await api("/sms/send", { method: "POST", body: JSON.stringify(payload) });
      setSmsMsg("");
      setOk("Text message sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "SMS failed");
    } finally {
      setSmsBusy(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    if (newPw.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPw !== confirmPw) {
      setError("New passwords do not match.");
      return;
    }
    try {
      await api("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          current_password: forced ? undefined : currentPw,
          new_password: newPw,
        }),
      });
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      await refresh();
      setOk("Password updated. Use it next time you sign in.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change password");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Account, texts, and display</p>
        </div>
      </div>

      {forced && (
        <div className="error" style={{ marginBottom: "1rem" }}>
          <strong>Choose your own password</strong> before using the rest of the app. Your admin set a
          temporary password — replace it below.
        </div>
      )}
      {error && (
        <div className="error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}
      {ok && (
        <div className="success" style={{ marginBottom: "1rem" }}>
          {ok}
        </div>
      )}

      <div className="grid two">
        <div className="card">
          <h2>{forced ? "Set your password" : "Change password"}</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Your login username is <strong>{user?.username || "—"}</strong>. Pick a password only you
            know (at least 8 characters).
          </p>
          <form className="form" onSubmit={changePassword}>
            {!forced && (
              <label>
                Current password
                <input
                  type="password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
            )}
            <label>
              New password
              <input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
              />
            </label>
            <label>
              Confirm new password
              <input
                type="password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
              />
            </label>
            <button className="btn" type="submit">
              {forced ? "Save my password" : "Update password"}
            </button>
          </form>
        </div>

        <div className="card">
          <h2>Your account</h2>
          <dl className="settings-dl">
            <div>
              <dt>Name</dt>
              <dd>{user?.display_name || "—"}</dd>
            </div>
            <div>
              <dt>Username (login)</dt>
              <dd>{user?.username || "—"}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>
                <span className="badge info">{user?.role || "—"}</span>
              </dd>
            </div>
          </dl>
          <form className="form" onSubmit={savePhone} style={{ marginTop: "0.75rem" }}>
            <label>
              Your cell phone (for SMS)
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(361) 555-0100"
                inputMode="tel"
              />
            </label>
            <button className="btn secondary" type="submit">
              Save phone
            </button>
          </form>
          <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.75rem" }}>
            Shop can text this number about repairs. Keep it current.
          </p>
          <button
            className="btn secondary"
            type="button"
            style={{ marginTop: "1rem", width: "100%" }}
            onClick={() => logout()}
          >
            Sign out
          </button>
        </div>

        {!forced && (
          <>
            {/* Collapsed by default — phone alert checklist lives here, not on Home */}
            <div className="settings-ntfy-wrap">
              <NtfySetupBanner variant="compact" defaultOpen={false} />
            </div>

            <div className="card">
              <h2>Text messages (SMS)</h2>
              {!smsConfigured ? (
                <p className="muted" style={{ marginTop: 0 }}>
                  SMS is not connected yet. An admin needs to add Twilio credentials on the server
                  (Account SID, Auth Token, From number). Until then, use Notifications in the app.
                </p>
              ) : !contacts.length ? (
                <p className="muted" style={{ marginTop: 0 }}>
                  No contacts with phone numbers yet. Drivers and shop staff need a phone saved on
                  their account.
                </p>
              ) : (
                <form className="form" onSubmit={sendText}>
                  <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
                    {user?.role === "driver"
                      ? "Text the shop or a mechanic when you need help."
                      : "Text a driver — uses the number on their profile."}
                  </p>
                  <label>
                    To
                    <select value={smsTo} onChange={(e) => setSmsTo(e.target.value)} required>
                      <option value="">Select…</option>
                      {contacts.map((c, i) => (
                        <option
                          key={`${c.user_id ?? c.phone}-${i}`}
                          value={c.user_id ? `u:${c.user_id}` : `p:${c.phone}`}
                        >
                          {c.name}
                          {c.unit_number ? ` · unit ${c.unit_number}` : ""}
                          {c.role === "shop" ? " (shop line)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Message
                    <textarea
                      value={smsMsg}
                      onChange={(e) => setSmsMsg(e.target.value)}
                      required
                      placeholder="Short text — they see it as a normal SMS"
                      maxLength={1400}
                    />
                  </label>
                  <button className="btn" type="submit" disabled={smsBusy}>
                    {smsBusy ? "Sending…" : "Send text"}
                  </button>
                </form>
              )}
            </div>

            {(can(user, "manageSettings") || can(user, "manageIssues")) && (
              <div className="card">
                <h2>Phone alerts — free</h2>
                <p style={{ marginTop: 0, fontSize: "0.95rem" }}>
                  Tell mechanics and office:{" "}
                  <strong>install ntfy and join “{ntfyTopic || "totalassurance"}”</strong>
                </p>

                <div
                  className="info-banner"
                  style={{ marginBottom: "0.85rem", fontSize: "0.95rem", lineHeight: 1.45 }}
                >
                  <strong>Instructions for the team (copy these):</strong>
                  <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
                    <li>
                      Download the free app named <strong>ntfy</strong> (n-t-f-y) on your phone
                    </li>
                    <li>
                      Open it → tap <strong>+</strong> or <strong>Subscribe</strong>
                    </li>
                    <li>
                      Type exactly:{" "}
                      <code
                        style={{
                          fontSize: "1.05rem",
                          fontWeight: 700,
                          letterSpacing: "0.02em",
                          padding: "0.1rem 0.35rem",
                          background: "var(--bg)",
                          borderRadius: "6px",
                        }}
                      >
                        {ntfyTopic || "totalassurance"}
                      </code>
                    </li>
                    <li>Allow notifications when the phone asks</li>
                    <li>Done — you’ll get a buzz when someone reports a repair or flat</li>
                  </ol>
                </div>

                <p className="muted" style={{ fontSize: "0.88rem", marginTop: 0 }}>
                  Flat tires also alert the <strong>3 closest drivers</strong> in the app (Live map).
                </p>

                <form className="form" onSubmit={saveFreeAlerts}>
                  <label>
                    Alert word (everyone types this in ntfy — keep it simple)
                    <input
                      value={ntfyTopic}
                      onChange={(e) =>
                        setNtfyTopic(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))
                      }
                      placeholder="totalassurance"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <div className="toolbar">
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => setNtfyTopic("totalassurance")}
                    >
                      Use totalassurance
                    </button>
                    <button className="btn" type="submit">
                      Save
                    </button>
                  </div>
                  <div className="toolbar" style={{ marginTop: "0.65rem" }}>
                    <button
                      className="btn"
                      type="button"
                      disabled={testBusy}
                      title={`Quiet test on ${NTFY_ADMIN_TEST_TOPIC} — mechanic on fleet channel is not notified`}
                      onClick={() => {
                        if (!ntfyTopic.trim()) setNtfyTopic(DEFAULT_NTFY_TOPIC);
                        void testFreeAlert();
                      }}
                    >
                      {testBusy
                        ? "Sending…"
                        : `Send test (${NTFY_ADMIN_TEST_TOPIC})`}
                    </button>
                  </div>
                </form>
                <p className="muted" style={{ margin: "0.55rem 0 0", fontSize: "0.82rem" }}>
                  <strong>Tests</strong> → <code>{NTFY_ADMIN_TEST_TOPIC}</code> (you only, if
                  subscribed). <strong>Real emergencies</strong> →{" "}
                  <code>{ntfyTopic || DEFAULT_NTFY_TOPIC}</code> (you + mechanic + team). Your cell
                  number is for SMS, not ntfy.
                </p>
                {lastNtfyStatus && (
                  <p
                    className="muted"
                    style={{
                      margin: "0.65rem 0 0",
                      fontSize: "0.78rem",
                      wordBreak: "break-word",
                    }}
                  >
                    Last push status: {lastNtfyStatus}
                  </p>
                )}
                <p className="muted" style={{ marginBottom: 0, fontSize: "0.8rem" }}>
                  App links:{" "}
                  <a href="https://ntfy.sh" target="_blank" rel="noreferrer">
                    ntfy.sh
                  </a>
                  {" · "}
                  <a
                    href="https://play.google.com/store/apps/details?id=io.heckel.ntfy"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Android
                  </a>
                  {" · "}
                  <a
                    href="https://apps.apple.com/app/ntfy/id1625396347"
                    target="_blank"
                    rel="noreferrer"
                  >
                    iPhone
                  </a>
                  {freeDiscordOn ? " · Discord also on" : ""}
                  {smsConfigured ? " · Twilio SMS also on" : ""}
                </p>
              </div>
            )}

            {(can(user, "manageSettings") || can(user, "manageIssues")) && (
              <div className="card">
                <h2>Role phone numbers</h2>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
                  {user?.role === "admin"
                    ? "Set the shop line, mechanic cell, and office line (default for everyone else). Techs can text these; emergencies can SMS them when Twilio is on."
                    : "Shop line drivers can text. Admin can set mechanic and office numbers too."}
                </p>
                <form className="form" onSubmit={saveRolePhones}>
                  <label>
                    Shop phone
                    <input
                      value={shopPhone}
                      onChange={(e) => setShopPhone(e.target.value)}
                      placeholder="(361) 555-0199"
                      inputMode="tel"
                    />
                  </label>
                  {user?.role === "admin" && (
                    <>
                      <label>
                        Mechanic phone
                        <input
                          value={mechanicPhone}
                          onChange={(e) => setMechanicPhone(e.target.value)}
                          placeholder="(361) 555-0101"
                          inputMode="tel"
                        />
                      </label>
                      <label>
                        Office phone (default for everyone else)
                        <input
                          value={officePhone}
                          onChange={(e) => setOfficePhone(e.target.value)}
                          placeholder="(361) 555-0100"
                          inputMode="tel"
                        />
                      </label>
                    </>
                  )}
                  <button className="btn secondary" type="submit" disabled={rolePhonesBusy}>
                    {rolePhonesBusy
                      ? "Saving…"
                      : user?.role === "admin"
                        ? "Save role phones"
                        : "Save shop number"}
                  </button>
                </form>
              </div>
            )}

            <div className="card">
              <h2>Appearance</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                Choose how the app looks. Saved on this device.
              </p>
              <div className="theme-picker" role="group" aria-label="Color theme">
                <button
                  type="button"
                  className={`theme-option ${theme === "light" ? "active" : ""}`}
                  onClick={() => setTheme("light")}
                >
                  <span className="theme-swatch theme-swatch-light" aria-hidden />
                  <span>
                    <strong>Light</strong>
                    <div className="muted">Best outdoors in daylight</div>
                  </span>
                </button>
                <button
                  type="button"
                  className={`theme-option ${theme === "dark" ? "active" : ""}`}
                  onClick={() => setTheme("dark")}
                >
                  <span className="theme-swatch theme-swatch-dark" aria-hidden />
                  <span>
                    <strong>Dark</strong>
                    <div className="muted">Easier at night / in the shop</div>
                  </span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
