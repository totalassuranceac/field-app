import { FormEvent, useEffect, useState } from "react";
import { api, can } from "../api";
import { useTheme } from "../theme";
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
  const { theme, setTheme } = useTheme();
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
  const [shopPhone, setShopPhone] = useState("");
  const [mechanicPhone, setMechanicPhone] = useState("");
  const [officePhone, setOfficePhone] = useState("");
  const [rolePhonesBusy, setRolePhonesBusy] = useState(false);

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
    }
  }, [forced, user]);

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
        setOk("Shop SMS number saved — drivers can text this number from Settings.");
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

            <div className="card">
              <h2>Send a text</h2>
              {!smsConfigured ? (
                <p className="muted" style={{ marginTop: 0 }}>
                  SMS is not connected yet. An admin needs to add Twilio credentials on the server
                  (Account SID, Auth Token, From number). Until then, use Notifications in the app.
                </p>
              ) : !contacts.length ? (
                <p className="muted" style={{ marginTop: 0 }}>
                  No contacts with phone numbers yet. Drivers and shop staff need a phone saved
                  above with SMS consent.
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
