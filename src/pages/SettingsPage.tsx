import { FormEvent, useEffect, useState } from "react";
import { api, can } from "../api";
import { TEXT_SIZE_OPTIONS, useTheme } from "../theme";
import { useAuth } from "../auth";
import { PasswordField } from "../components/PasswordField";

/** Public legal pages — used for SMS opt-in (Twilio A2P) */
const PRIVACY_URL = "https://www.totalassuranceac.com/privacy-policy/";
const TERMS_URL = "https://www.totalassuranceac.com/terms-of-service/";

interface SmsContact {
  user_id: number | null;
  name: string;
  phone: string;
  role: string;
  unit_number?: string | null;
}

export function SettingsPage() {
  const { theme, setTheme, textSize, setTextSize } = useTheme();
  const { user, refresh, logout } = useAuth();
  const [phone, setPhone] = useState(user?.phone || "");
  /** Explicit SMS consent (required when saving a mobile number) */
  const [smsConsent, setSmsConsent] = useState(Boolean(user?.phone?.trim()));
  const [phoneBusy, setPhoneBusy] = useState(false);
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
  const [smsTestBusy, setSmsTestBusy] = useState(false);
  const [shopPhone, setShopPhone] = useState("");
  const [mechanicPhone, setMechanicPhone] = useState("");
  const [officePhone, setOfficePhone] = useState("");
  const [rolePhonesBusy, setRolePhonesBusy] = useState(false);
  const [smsLog, setSmsLog] = useState<
    Array<{
      id: number;
      to_phone: string;
      status: string;
      error: string | null;
      context: string | null;
      created_at: string;
      body: string;
      provider_sid?: string | null;
    }>
  >([]);
  const [smsFromMasked, setSmsFromMasked] = useState<string | null>(null);
  const [smsRefreshBusy, setSmsRefreshBusy] = useState(false);

  useEffect(() => {
    setPhone(user?.phone || "");
    // Existing number on file = already opted in previously
    if (user?.phone?.trim()) setSmsConsent(true);
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
      }>("/sms/status")
        .then((s) => {
          setShopPhone(s.shop_phone || "");
          setMechanicPhone(s.mechanic_phone || "");
          setOfficePhone(s.office_phone || "");
        })
        .catch(() => {});
      void loadSmsLog(false);
    }
  }, [forced, user]);

  async function loadSmsLog(refreshTwilio: boolean) {
    try {
      const d = await api<{
        from_masked?: string | null;
        log: Array<{
          id: number;
          to_phone: string;
          status: string;
          error: string | null;
          context: string | null;
          created_at: string;
          body: string;
          provider_sid?: string | null;
        }>;
      }>(`/sms/log?limit=25${refreshTwilio ? "&refresh=1" : ""}`);
      setSmsLog(d.log || []);
      setSmsFromMasked(d.from_masked || null);
    } catch {
      if (!refreshTwilio) setSmsLog([]);
    }
  }

  async function sendTestToMe() {
    setError("");
    setOk("");
    setSmsTestBusy(true);
    try {
      const res = await api<{ ok: boolean; to_phone?: string; sid?: string; error?: string }>(
        "/sms/test",
        { method: "POST", body: "{}" }
      );
      // Twilio may accept the API call, then carriers reject (e.g. 30034). Refresh delivery.
      if (can(user, "manageIssues") || user?.role === "admin" || user?.role === "office") {
        await loadSmsLog(true);
        try {
          const latest = await api<{
            log: Array<{ context?: string | null; status?: string; error?: string | null }>;
          }>("/sms/log?limit=5&refresh=1");
          const testRow = (latest.log || []).find((r) => r.context === "sms_test");
          const st = String(testRow?.status || "").toLowerCase();
          if (testRow && (st === "undelivered" || st === "failed" || testRow.error)) {
            setError(
              testRow.error ||
                `Twilio accepted the message but it was not delivered (status: ${testRow.status}). Often error 30034 — A2P campaign / Messaging Service not fully approved.`
            );
            setOk("");
            return;
          }
        } catch {
          /* keep success message below */
        }
      }
      setOk(
        `Test text sent to ${res.to_phone || "your phone"}. Check your messages — it should say “TA Fleet test”.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "SMS test failed");
      if (can(user, "manageIssues") || user?.role === "admin" || user?.role === "office") {
        await loadSmsLog(true);
      }
    } finally {
      setSmsTestBusy(false);
    }
  }

  async function refreshSmsDelivery() {
    setError("");
    setOk("");
    setSmsRefreshBusy(true);
    try {
      await loadSmsLog(true);
      setOk(
        "Checked Twilio delivery status for recent texts. Look at Status / Detail in the log below."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh Twilio status");
    } finally {
      setSmsRefreshBusy(false);
    }
  }

  async function savePhone(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    const trimmed = phone.trim();
    if (trimmed && !smsConsent) {
      setError("Check the SMS consent box to save your number and receive texts.");
      return;
    }
    setPhoneBusy(true);
    try {
      await api("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ phone: trimmed || null }),
      });
      await refresh();
      setOk(
        trimmed
          ? "Phone saved — you opted in to Total Assurance account notification SMS."
          : "Phone cleared — you will not receive SMS from Field App."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save phone");
    } finally {
      setPhoneBusy(false);
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
        setOk("Shop SMS number saved — used for automatic alerts when Twilio is on.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save phone numbers");
    } finally {
      setRolePhonesBusy(false);
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
              <PasswordField
                label="Current password"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                autoComplete="current-password"
                required
              />
            )}
            <PasswordField
              label="New password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
            />
            <PasswordField
              label="Confirm new password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
            />
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
            {/* Primary SMS opt-in — designed so one screenshot shows full consent for Twilio A2P */}
            <div className="card sms-optin-card" style={{ gridColumn: "1 / -1" }}>
              <h2>SMS account notifications</h2>
              <p style={{ marginTop: 0, fontSize: "0.95rem", lineHeight: 1.45 }}>
                <strong>Total Assurance AC &amp; Heating</strong> may send operational text messages
                to employees about shop appointments, repair status, parts readiness, warranty
                updates, and other work-related Field App alerts. This is not marketing.
              </p>

              <form className="form" onSubmit={savePhone}>
                <label>
                  Mobile phone number
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="(361) 555-0100"
                    inputMode="tel"
                    autoComplete="tel"
                  />
                </label>

                <div className="sms-consent-box">
                  <label className="sms-consent-label">
                    <input
                      type="checkbox"
                      checked={smsConsent}
                      onChange={(e) => setSmsConsent(e.target.checked)}
                    />
                    <span>
                      I agree to receive recurring <strong>account notification</strong> text
                      messages from <strong>Total Assurance AC &amp; Heating</strong> about repairs,
                      appointments, parts, and shop communications related to my job. Message
                      frequency varies. Message and data rates may apply. Reply{" "}
                      <strong>STOP</strong> to opt out, <strong>HELP</strong> for help. Mobile
                      numbers are not shared with third parties or affiliates for marketing or
                      promotional purposes.{" "}
                      <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                        Privacy Policy
                      </a>
                      {" · "}
                      <a href={TERMS_URL} target="_blank" rel="noreferrer">
                        Terms of Service
                      </a>
                    </span>
                  </label>
                </div>

                <p className="muted" style={{ margin: "0.35rem 0 0.75rem", fontSize: "0.85rem" }}>
                  Saving your number with the box checked is your consent. Clear the number and save
                  to stop SMS, or reply STOP to any message. In-app notifications still work without
                  SMS.
                </p>

                <div className="toolbar" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                  <button className="btn" type="submit" disabled={phoneBusy}>
                    {phoneBusy ? "Saving…" : phone.trim() ? "Save & enable SMS" : "Clear phone"}
                  </button>
                  {phone.trim() && (
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={phoneBusy}
                      onClick={() => {
                        setPhone("");
                        setSmsConsent(false);
                      }}
                    >
                      Clear number
                    </button>
                  )}
                  {smsConfigured && phone.trim() && (
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={smsTestBusy || phoneBusy}
                      onClick={() => void sendTestToMe()}
                    >
                      {smsTestBusy ? "Sending test…" : "Send test text to my phone"}
                    </button>
                  )}
                </div>
              </form>

              <p className="muted" style={{ margin: "0.85rem 0 0", fontSize: "0.8rem" }}>
                Privacy:{" "}
                <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                  {PRIVACY_URL}
                </a>
                <br />
                Terms:{" "}
                <a href={TERMS_URL} target="_blank" rel="noreferrer">
                  {TERMS_URL}
                </a>
              </p>
            </div>

            {user?.role === "admin" && (
              <div className="card">
                <h2>Send a text</h2>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
                  Admin only — text a staff phone on file. Everyone else uses Notifications in the
                  app; automatic shop alerts still send when Twilio is on.
                </p>
                {!smsConfigured ? (
                  <p className="muted" style={{ marginTop: 0 }}>
                    SMS is not connected yet. Add Twilio credentials on the server (Account SID, Auth
                    Token, From number / Messaging Service).
                  </p>
                ) : !contacts.length ? (
                  <p className="muted" style={{ marginTop: 0 }}>
                    No contacts with phone numbers yet. Staff need a phone saved above with SMS
                    consent.
                  </p>
                ) : (
                  <form className="form" onSubmit={sendText}>
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
            )}

            {(can(user, "manageIssues") ||
              user?.role === "admin" ||
              user?.role === "office" ||
              user?.role === "supervisor") && (
              <div className="card" style={{ gridColumn: "1 / -1" }}>
                <h2>Recent SMS log</h2>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
                  App “sent” only means Twilio accepted the API call. Tap{" "}
                  <strong>Check delivery from Twilio</strong> to see if the carrier actually
                  delivered it (delivered / undelivered / failed + error code).
                  {smsFromMasked ? (
                    <>
                      {" "}
                      Sending as <code>{smsFromMasked}</code>.
                    </>
                  ) : null}
                </p>
                <div className="toolbar" style={{ marginBottom: "0.75rem" }}>
                  <button
                    type="button"
                    className="btn secondary btn-sm"
                    disabled={smsRefreshBusy}
                    onClick={() => void refreshSmsDelivery()}
                  >
                    {smsRefreshBusy ? "Checking Twilio…" : "Check delivery from Twilio"}
                  </button>
                </div>
                {!smsLog.length ? (
                  <p className="muted">No SMS attempts logged yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>To</th>
                          <th>Status</th>
                          <th>Context</th>
                          <th>Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {smsLog.map((row) => {
                          const st = String(row.status || "").toLowerCase();
                          const okish = st === "delivered" || st === "sent";
                          const bad =
                            st === "failed" || st === "undelivered" || Boolean(row.error);
                          return (
                            <tr key={row.id}>
                              <td style={{ whiteSpace: "nowrap" }}>
                                {String(row.created_at || "")
                                  .replace("T", " ")
                                  .slice(0, 16)}
                              </td>
                              <td>{row.to_phone}</td>
                              <td>
                                <strong
                                  style={{
                                    color: bad
                                      ? "#b91c1c"
                                      : okish
                                        ? "var(--ok, #15803d)"
                                        : undefined,
                                  }}
                                >
                                  {row.status}
                                </strong>
                              </td>
                              <td className="muted" style={{ fontSize: "0.85rem" }}>
                                {row.context || "—"}
                              </td>
                              <td style={{ fontSize: "0.85rem", maxWidth: "20rem" }}>
                                {row.error
                                  ? row.error
                                  : st === "delivered"
                                    ? "Delivered to handset"
                                    : (row.body || "").slice(0, 80) +
                                      ((row.body || "").length > 80 ? "…" : "")}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {(can(user, "manageSettings") || can(user, "manageIssues")) && (
              <div className="card">
                <h2>Role phone numbers</h2>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
                  {user?.role === "admin"
                    ? "Set the shop line, mechanic cell, and office line. Used for automatic alerts when Twilio is on. Manual “Send a text” is admin-only."
                    : "Shop line for automatic alerts. Admin can set mechanic and office numbers too."}
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
                Choose how the app looks on <strong>this phone or computer</strong>. Each person can
                pick their own size — it does not change anyone else’s screen.
              </p>
              <h3 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Text size</h3>
              <div className="text-size-picker" role="group" aria-label="Text size">
                {TEXT_SIZE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`text-size-option ${textSize === opt.id ? "active" : ""}`}
                    onClick={() => setTextSize(opt.id)}
                    aria-pressed={textSize === opt.id}
                  >
                    <span className="text-size-option-label" data-preview={opt.id}>
                      {opt.label}
                    </span>
                    <span className="muted text-size-option-hint">{opt.hint}</span>
                  </button>
                ))}
              </div>
              <p className="text-size-preview" aria-live="polite">
                Preview: menus, buttons, and forms use this size. Tap a size above to try it.
              </p>
              <h3 style={{ fontSize: "1rem", margin: "1.15rem 0 0.5rem" }}>Color</h3>
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
