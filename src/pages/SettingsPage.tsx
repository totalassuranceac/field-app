import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, can, canOpenStudio } from "../api";
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
  const [onCallPhone, setOnCallPhone] = useState("");
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
  const [stockTechs, setStockTechs] = useState(false);
  const [bookLive, setBookLive] = useState(false);
  const [bookNc, setBookNc] = useState(false);
  const [bookFlagBusy, setBookFlagBusy] = useState(false);
  const [stockBusy, setStockBusy] = useState(false);
  const [deliveriesSms, setDeliveriesSms] = useState(false);
  const [deliveriesSmsBusy, setDeliveriesSmsBusy] = useState(false);
  const [handoffReady, setHandoffReady] = useState(false);
  const [handoffWarranty, setHandoffWarranty] = useState(true);
  const [handoffArrival, setHandoffArrival] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [doneAi, setDoneAi] = useState(false);
  const [doneAiBusy, setDoneAiBusy] = useState(false);
  const [techAssist, setTechAssist] = useState(true);
  const [techAi, setTechAi] = useState(false);
  const [solderIds, setSolderIds] = useState("339591774,336193175");
  const [optionsAge, setOptionsAge] = useState("12");
  const [techBusy, setTechBusy] = useState(false);
  const [onsiteMode, setOnsiteMode] = useState<"off" | "dry" | "live">("off");
  const [onsiteGeo, setOnsiteGeo] = useState<"off" | "census">("off");
  const [onsiteBusy, setOnsiteBusy] = useState(false);
  const [partFinderOn, setPartFinderOn] = useState(true);
  const [partFinderBusy, setPartFinderBusy] = useState(false);
  const [rncCustomer, setRncCustomer] = useState("266637796");
  const [rncTypeId, setRncTypeId] = useState("");
  const [rncStatusId, setRncStatusId] = useState("");
  const [rncBu, setRncBu] = useState("");
  const [rncPm, setRncPm] = useState("");
  const [rncTag, setRncTag] = useState("");
  const [rncPayroll, setRncPayroll] = useState("");
  const [rncSingle, setRncSingle] = useState("");
  const [rncTwo, setRncTwo] = useState("");
  const [rncFlag, setRncFlag] = useState(false);
  const [rncNote, setRncNote] = useState("");
  const [rncBusy, setRncBusy] = useState(false);

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
    if (user?.role === "admin") {
      api<{ nc_enabled?: boolean; live_setting?: boolean }>("/day-board/miller-book/meta")
        .then((d) => {
          setBookLive(Boolean(d.live_setting));
          setBookNc(Boolean(d.nc_enabled));
        })
        .catch(() => {
          setBookLive(false);
          setBookNc(false);
        });
      api<{ techs_enabled?: boolean }>("/inventory/stock-check/access")
        .then((d) => setStockTechs(Boolean(d.techs_enabled)))
        .catch(() => setStockTechs(false));
      api<{ sms_enabled: boolean }>("/deliveries/flag")
        .then((d) => setDeliveriesSms(Boolean(d.sms_enabled)))
        .catch(() => setDeliveriesSms(false));
      api<{ ready: boolean; proof_required_warranty: boolean; proof_required_arrival_return: boolean }>("/handoffs/settings")
        .then((d) => {
          setHandoffReady(Boolean(d.ready));
          setHandoffWarranty(d.proof_required_warranty !== false);
          setHandoffArrival(Boolean(d.proof_required_arrival_return));
        })
        .catch(() => setHandoffReady(false));
      api<{ ai_setting?: boolean }>("/done-today/config")
        .then((d) => setDoneAi(Boolean(d.ai_setting)))
        .catch(() => setDoneAi(false));
      api<{
        tech_assist?: boolean;
        tech_assist_ai?: boolean;
        job_rule_solder_type_ids?: string;
        job_rule_options_age_years?: string;
      }>("/tech/settings")
        .then((d) => {
          setTechAssist(d.tech_assist !== false);
          setTechAi(Boolean(d.tech_assist_ai));
          if (d.job_rule_solder_type_ids) setSolderIds(d.job_rule_solder_type_ids);
          if (d.job_rule_options_age_years) setOptionsAge(String(d.job_rule_options_age_years));
        })
        .catch(() => {
          setTechAssist(true);
          setTechAi(false);
        });
      api<{ mode?: string; geocoder?: string }>("/onsite-nudges/report?days=1")
        .then((d) => {
          setOnsiteMode(d.mode === "dry" || d.mode === "live" ? d.mode : "off");
          setOnsiteGeo(d.geocoder === "census" ? "census" : "off");
        })
        .catch(() => {
          setOnsiteMode("off");
          setOnsiteGeo("off");
        });
      api<{ flag_enabled?: boolean }>("/part-finder/access")
        .then((d) => setPartFinderOn(d.flag_enabled !== false))
        .catch(() => setPartFinderOn(true));
      api<{
        flag_on?: boolean;
        customer_id?: string;
        project_type_id?: string;
        status_id?: string;
        business_unit_id?: string;
        project_manager_id?: string;
        tag_id?: string;
        payroll_id?: string;
        single_template?: string;
        two_template?: string;
      }>("/new-construction/access")
        .then((d) => {
          setRncFlag(Boolean(d.flag_on));
          setRncCustomer(d.customer_id || "266637796");
          setRncTypeId(d.project_type_id || "");
          setRncStatusId(d.status_id || "");
          setRncBu(d.business_unit_id || "");
          setRncPm(d.project_manager_id || "");
          setRncTag(d.tag_id || "");
          setRncPayroll(d.payroll_id || "");
          setRncSingle(d.single_template || "");
          setRncTwo(d.two_template || "");
        })
        .catch(() => setRncFlag(false));
    }
    if (can(user, "manageIssues") || user?.role === "admin" || user?.role === "office") {
      api<{
        shop_phone?: string;
        mechanic_phone?: string;
        office_phone?: string;
        on_call_phone?: string;
      }>("/sms/status")
        .then((s) => {
          setShopPhone(s.shop_phone || "");
          setMechanicPhone(s.mechanic_phone || "");
          setOfficePhone(s.office_phone || "");
          setOnCallPhone(s.on_call_phone || "");
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
        `Test text sent to ${res.to_phone || "your phone"}. Check your messages — it should say “SMS test for …”.`
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
            on_call_phone: onCallPhone.trim(),
          }),
        });
        setOk("Shop, mechanic, office, and on-call phone numbers saved.");
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
          <p>Password, your phone, and display</p>
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
          {canOpenStudio(user) ? (
            <p style={{ marginTop: "0.85rem" }}>
              <Link to="/studio">Studio handoff</Link>
            </p>
          ) : null}
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

            {user?.role === "admin" ? (
              <div className="card settings-fold" style={{ gridColumn: "1 / -1" }}>
                <details>
                  <summary>Shop switches</summary>
                  <p className="muted" style={{ marginTop: "0.65rem" }}>
                    Install book, part in stock, delivery texts, vendor proof, job notes, and new
                    construction ids. Open this when you need to change one.
                  </p>
              {user?.role === "admin" ? (
                <div className="form" style={{ marginBottom: "1rem" }}>
                  <h2 style={{ fontSize: "1.05rem" }}>Install Book</h2>
                  <label className="check-row">
                    <input type="checkbox" checked={bookLive} onChange={(e) => setBookLive(e.target.checked)} />
                    <span>Install Book live ST create (also needs MILLER_BOOK_JOB=live)</span>
                  </label>
                  <label className="check-row">
                    <input type="checkbox" checked={bookNc} onChange={(e) => setBookNc(e.target.checked)} />
                    <span>NC booking in Install Book (Rough / Final / Trim Out) - keep OFF until add-appointment is built</span>
                  </label>
                  <p className="muted">Both off. Live create also needs the existing booking switch. NC types stay hidden until the second box is on.</p>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={bookFlagBusy}
                    onClick={() => {
                      setBookFlagBusy(true);
                      setError("");
                      setOk("");
                      void Promise.all([
                        api("/day-board/miller-book/live-flag", {
                          method: "PUT",
                          body: JSON.stringify({ enabled: bookLive }),
                        }),
                        api("/day-board/miller-book/nc-flag", {
                          method: "PUT",
                          body: JSON.stringify({ enabled: bookNc }),
                        }),
                      ])
                        .then(() => setOk("Install Book settings saved."))
                        .catch((err) => setError(err instanceof Error ? err.message : "Could not save"))
                        .finally(() => setBookFlagBusy(false));
                    }}
                  >
                    {bookFlagBusy ? "Saving..." : "Save Install Book"}
                  </button>
                </div>
              ) : null}

              {user?.role === "admin" ? (
                <form
                  className="form"
                  style={{ marginBottom: "1rem" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setStockBusy(true);
                    setError("");
                    setOk("");
                    void api("/inventory/stock-check/techs", {
                      method: "PUT",
                      body: JSON.stringify({ enabled: stockTechs }),
                    })
                      .then(() => setOk(stockTechs ? "Technicians can open Part in stock." : "Part in stock stays admin-only."))
                      .catch((err) => setError(err instanceof Error ? err.message : "Could not save"))
                      .finally(() => setStockBusy(false));
                  }}
                >
                  <h2 style={{ fontSize: "1.05rem" }}>Part in stock</h2>
                  <label>
                    <input
                      type="checkbox"
                      checked={stockTechs}
                      onChange={(e) => setStockTechs(e.target.checked)}
                    />{" "}
                    Show Part in stock to technicians
                  </label>
                  <p className="muted">Default off. Techs do not see the door until this is on.</p>
                  <button className="btn btn-sm" type="submit" disabled={stockBusy}>
                    {stockBusy ? "Saving..." : "Save stock check"}
                  </button>
                </form>
              ) : null}

              {user?.role === "admin" ? (
                <form
                  className="form"
                  style={{ marginBottom: "1rem" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setDeliveriesSmsBusy(true);
                    setError("");
                    setOk("");
                    void api("/deliveries/flag", {
                      method: "PUT",
                      body: JSON.stringify({ sms_enabled: deliveriesSms }),
                    })
                      .then(() => setOk(deliveriesSms ? "Deliveries texts are on." : "Deliveries texts stay off."))
                      .catch((err) => setError(err instanceof Error ? err.message : "Could not save"))
                      .finally(() => setDeliveriesSmsBusy(false));
                  }}
                >
                  <h2 style={{ fontSize: "1.05rem" }}>Deliveries texts</h2>
                  <label>
                    <input
                      type="checkbox"
                      checked={deliveriesSms}
                      onChange={(e) => setDeliveriesSms(e.target.checked)}
                    />{" "}
                    Text Bianca and Kelsie when job parts are received
                  </label>
                  <p className="muted">
                    Default off. The bell always goes to the office and admins. Texts use the normal 6-hour no-repeat
                    rule and stop at 8 per person per day. Stock deliveries never text.
                  </p>
                  <button className="btn btn-sm" type="submit" disabled={deliveriesSmsBusy}>
                    {deliveriesSmsBusy ? "Saving..." : "Save deliveries texts"}
                  </button>
                </form>
              ) : null}

              {user?.role === "admin" && handoffReady ? (
                <form
                  className="form"
                  style={{ marginBottom: "1rem" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setHandoffBusy(true);
                    setError("");
                    setOk("");
                    void api("/handoffs/settings", {
                      method: "PUT",
                      body: JSON.stringify({
                        proof_required_warranty: handoffWarranty,
                        proof_required_arrival_return: handoffArrival,
                      }),
                    })
                      .then(() => setOk("Vendor hand-off proof saved."))
                      .catch((err) => setError(err instanceof Error ? err.message : "Could not save"))
                      .finally(() => setHandoffBusy(false));
                  }}
                >
                  <h2 style={{ fontSize: "1.05rem" }}>Vendor hand-off proof</h2>
                  <label>
                    <input type="checkbox" checked={handoffWarranty} onChange={(e) => setHandoffWarranty(e.target.checked)} />{" "}
                    Require vendor signature before a card leaves the Return pile
                  </label>
                  <label>
                    <input type="checkbox" checked={handoffArrival} onChange={(e) => setHandoffArrival(e.target.checked)} />{" "}
                    Require signature for Order-for-shop returns
                  </label>
                  <p className="muted">Photo is always required. Order-for-shop returns stay off until you turn that box on.</p>
                  <button className="btn btn-sm" type="submit" disabled={handoffBusy}>
                    {handoffBusy ? "Saving..." : "Save hand-off proof"}
                  </button>
                </form>
              ) : null}

              {user?.role === "admin" ? (
                <form
                  className="form"
                  style={{ marginBottom: "1rem" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setTechBusy(true);
                    setError("");
                    setOk("");
                    void api("/tech/settings", {
                      method: "PUT",
                      body: JSON.stringify({
                        tech_assist: techAssist,
                        tech_assist_ai: techAi,
                        job_rule_solder_type_ids: solderIds,
                        job_rule_options_age_years: optionsAge,
                      }),
                    })
                      .then(() => setOk(techAssist ? "Tech assist is on. AI stays off until a binding is added and that box is checked." : "Tech assist notes are hidden."))
                      .catch((err) => setError(err instanceof Error ? err.message : "Could not save"))
                      .finally(() => setTechBusy(false));
                  }}
                >
                  <h2 style={{ fontSize: "1.05rem" }}>Tech assist</h2>
                  <label>
                    <input type="checkbox" checked={techAssist} onChange={(e) => setTechAssist(e.target.checked)} />{" "}
                    Show job notes, brief, equipment, and wrap-up
                  </label>
                  <label>
                    <input type="checkbox" checked={techAi} onChange={(e) => setTechAi(e.target.checked)} />{" "}
                    Short spoken brief and wrap-up split with AI
                  </label>
                  <label>
                    Solder job type ids
                    <input value={solderIds} onChange={(e) => setSolderIds(e.target.value)} />
                  </label>
                  <label>
                    Offer-options age (years)
                    <input value={optionsAge} onChange={(e) => setOptionsAge(e.target.value)} inputMode="numeric" />
                  </label>
                  <p className="muted">Default on for the notes. AI stays off until the Workers AI binding is added. Nothing is written to ServiceTitan.</p>
                  <button className="btn btn-sm" type="submit" disabled={techBusy}>
                    {techBusy ? "Saving..." : "Save tech assist"}
                  </button>
                </form>
              ) : null}

              {user?.role === "admin" ? (
                <form
                  className="form"
                  style={{ marginBottom: "1rem" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setDoneAiBusy(true);
                    setError("");
                    setOk("");
                    void api("/done-today/settings", {
                      method: "PUT",
                      body: JSON.stringify({ done_today_ai: doneAi }),
                    })
                      .then(() => setOk(doneAi ? "Done today AI split is requested. It stays off until an AI binding exists." : "Done today AI split stays off."))
                      .catch((err) => setError(err instanceof Error ? err.message : "Could not save"))
                      .finally(() => setDoneAiBusy(false));
                  }}
                >
                  <h2 style={{ fontSize: "1.05rem" }}>Done today</h2>
                  <label>
                    <input type="checkbox" checked={doneAi} onChange={(e) => setDoneAi(e.target.checked)} />{" "}
                    Split extra lines with AI
                  </label>
                  <p className="muted">Default off. Rules split is used until an AI binding is added. This switch does not turn texts on.</p>
                  <button className="btn btn-sm" type="submit" disabled={doneAiBusy}>
                    {doneAiBusy ? "Saving..." : "Save done today"}
                  </button>
                </form>
              ) : null}

              {user?.role === "admin" ? (
                <form
                  className="form"
                  style={{ marginBottom: "1rem" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setOnsiteBusy(true);
                    setError("");
                    setOk("");
                    void Promise.all([
                      api("/onsite-nudges/mode", {
                        method: "PUT",
                        body: JSON.stringify({ mode: onsiteMode }),
                      }),
                      api("/onsite-nudges/geocoder", {
                        method: "PUT",
                        body: JSON.stringify({ geocoder: onsiteGeo }),
                      }),
                    ])
                      .then(() => setOk("Board-mismatch nudge saved."))
                      .catch((err) => setError(err instanceof Error ? err.message : "Could not save"))
                      .finally(() => setOnsiteBusy(false));
                  }}
                >
                  <h2 style={{ fontSize: "1.05rem" }}>Board-mismatch nudge (install crews only)</h2>
                  <label>
                    Mode{" "}
                    <select
                      value={onsiteMode}
                      onChange={(e) => setOnsiteMode(e.target.value as "off" | "dry" | "live")}
                    >
                      <option value="off">Off</option>
                      <option value="dry">Dry run (log only)</option>
                      <option value="live">Live</option>
                    </select>
                  </label>
                  <label>
                    Geocoder for van-at-job check{" "}
                    <select
                      value={onsiteGeo}
                      onChange={(e) => setOnsiteGeo(e.target.value as "off" | "census")}
                    >
                      <option value="off">Off</option>
                      <option value="census">US Census</option>
                    </select>
                  </label>
                  <p className="muted">
                    Default Off. D4: Census stays off until you say yes. The van-at-job check cannot run while the
                    geocoder is Off.
                  </p>
                  <p className="muted">
                    <a href="/api/onsite-nudges/report">Open the report</a>
                  </p>
                  <button className="btn btn-sm" type="submit" disabled={onsiteBusy}>
                    {onsiteBusy ? "Saving..." : "Save board-mismatch nudge"}
                  </button>
                </form>
              ) : null}

              {user?.role === "admin" ? (
                <div className="form" style={{ marginBottom: "1rem" }}>
                  <h2 style={{ fontSize: "1.05rem" }}>Repair part finder (serial)</h2>
                  <p className="muted">Repair part lookup from a serial. Vendor catalogs are not connected yet.</p>
                  <label>
                    <input
                      type="checkbox"
                      checked={partFinderOn}
                      onChange={(e) => setPartFinderOn(e.target.checked)}
                    />{" "}
                    Enable Repair part (serial) for techs
                  </label>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={partFinderBusy}
                    onClick={() => {
                      setPartFinderBusy(true);
                      setError("");
                      setOk("");
                      void api("/part-finder/flag", {
                        method: "PUT",
                        body: JSON.stringify({ enabled: partFinderOn }),
                      })
                        .then(() =>
                          setOk(partFinderOn ? "Repair part finder on." : "Repair part finder off.")
                        )
                        .catch((e) => setError(e instanceof Error ? e.message : "Save failed"))
                        .finally(() => setPartFinderBusy(false));
                    }}
                  >
                    {partFinderBusy ? "Saving..." : "Save repair finder"}
                  </button>
                </div>
              ) : null}

              {user?.role === "admin" ? (
                <div className="form" style={{ marginBottom: "1rem" }}>
                  <h2 style={{ fontSize: "1.05rem" }}>New construction</h2>
                  <p className="muted">
                    Azali Homes customer 266637796. Read project 10565 for type, business unit, manager, tag, and status. Empty ids mean the read failed. Do not guess.
                  </p>
                  <label className="check-row">
                    <input type="checkbox" checked={rncFlag} onChange={(e) => setRncFlag(e.target.checked)} />
                    <span>Allow Create in ServiceTitan (off by default)</span>
                  </label>
                  <label>
                    Customer id
                    <input value={rncCustomer} onChange={(e) => setRncCustomer(e.target.value)} />
                  </label>
                  <label>
                    Project type id
                    <input value={rncTypeId} onChange={(e) => setRncTypeId(e.target.value)} />
                  </label>
                  <label>
                    Business unit id
                    <input value={rncBu} onChange={(e) => setRncBu(e.target.value)} />
                  </label>
                  <label>
                    Project manager id
                    <input value={rncPm} onChange={(e) => setRncPm(e.target.value)} />
                  </label>
                  <label>
                    Construction tag id
                    <input value={rncTag} onChange={(e) => setRncTag(e.target.value)} />
                  </label>
                  <label>
                    Status id
                    <input value={rncStatusId} onChange={(e) => setRncStatusId(e.target.value)} />
                  </label>
                  <label>
                    Prevailing wage payroll id
                    <input value={rncPayroll} onChange={(e) => setRncPayroll(e.target.value)} />
                  </label>
                  <label>
                    Single story template
                    <textarea rows={4} value={rncSingle} onChange={(e) => setRncSingle(e.target.value)} />
                  </label>
                  <label>
                    Two story template
                    <textarea rows={4} value={rncTwo} onChange={(e) => setRncTwo(e.target.value)} />
                  </label>
                  {rncNote ? <p className="muted">{rncNote}</p> : null}
                  <div className="toolbar">
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={rncBusy}
                      onClick={() => {
                        setRncBusy(true);
                        setRncNote("");
                        void api<{
                          ok?: boolean;
                          error?: string;
                          project_number?: string;
                          ids?: {
                            customer_id?: string;
                            project_type_id?: string;
                            status_id?: string;
                            business_unit_id?: string;
                            project_manager_id?: string;
                            tag_id?: string;
                          };
                        }>("/new-construction/ids/read", { method: "POST", body: "{}" })
                          .then((d) => {
                            const ids = d.ids || {};
                            if (ids.project_type_id) setRncTypeId(ids.project_type_id);
                            if (ids.status_id) setRncStatusId(ids.status_id);
                            if (ids.business_unit_id) setRncBu(ids.business_unit_id);
                            if (ids.project_manager_id) setRncPm(ids.project_manager_id);
                            if (ids.tag_id) setRncTag(ids.tag_id);
                            if (ids.customer_id) setRncCustomer(ids.customer_id);
                            setRncNote(d.error || `Read project ${d.project_number || "10565"}`);
                          })
                          .catch((e) => setError(e instanceof Error ? e.message : "Read failed"))
                          .finally(() => setRncBusy(false));
                      }}
                    >
                      {rncBusy ? "Reading..." : "Read from ServiceTitan"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={rncBusy}
                      onClick={() => {
                        setRncBusy(true);
                        setError("");
                        void api("/new-construction/settings", {
                          method: "PUT",
                          body: JSON.stringify({
                            customer_id: rncCustomer,
                            project_type_id: rncTypeId,
                            status_id: rncStatusId,
                            business_unit_id: rncBu,
                            project_manager_id: rncPm,
                            tag_id: rncTag,
                            payroll_id: rncPayroll,
                            single_template: rncSingle,
                            two_template: rncTwo,
                          }),
                        })
                          .then(() =>
                            api("/new-construction/flag", {
                              method: "PUT",
                              body: JSON.stringify({ enabled: rncFlag }),
                            })
                          )
                          .then(() => setOk(rncFlag ? "New construction templates saved. Create is on." : "New construction templates saved. Create stays off."))
                          .catch((e) => setError(e instanceof Error ? e.message : "Save failed"))
                          .finally(() => setRncBusy(false));
                      }}
                    >
                      Save new construction
                    </button>
                  </div>
                </div>
              ) : null}
                </details>
              </div>
            ) : null}


            {user?.role === "admin" && (
              <div className="card settings-fold">
                <details>
                  <summary>Send a text</summary>
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
                </details>
              </div>
            )}

            {(can(user, "manageIssues") ||
              user?.role === "admin" ||
              user?.role === "office" ||
              user?.role === "supervisor") && (
              <div className="card settings-fold" style={{ gridColumn: "1 / -1" }}>
                <details>
                  <summary>Recent SMS log</summary>
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
                {user?.role === "admin" ? (
                  <p className="muted" style={{ marginTop: 0, fontSize: "0.82rem" }}>
                    Eric Jeff reply push uses <code>ATLAS_ERIC_SMS_WEBHOOK_*</code> secrets
                    (one-shot wake on inbound from Eric’s mobile — no polling).
                  </p>
                ) : null}
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
                </details>
              </div>
            )}

            {(can(user, "manageSettings") || can(user, "manageIssues")) && (
              <div className="card settings-fold">
                <details>
                  <summary>Role phone numbers</summary>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
                  {user?.role === "admin"
                    ? "Set the shop line, mechanic cell, office line, and optional on-call tech. Used for automatic alerts and customer EMERGENCY inbound texts. Manual “Send a text” is admin-only."
                    : "Shop line for automatic alerts. Admin can set mechanic, office, and on-call numbers too."}
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
                      <label>
                        On-call tech phone
                        <input
                          value={onCallPhone}
                          onChange={(e) => setOnCallPhone(e.target.value)}
                          placeholder="(361) 555-0142"
                          inputMode="tel"
                        />
                      </label>
                      <p className="muted" style={{ margin: "0.15rem 0 0", fontSize: "0.8rem" }}>
                        Optional. Customer EMERGENCY texts to the shop line also SMS this number
                        (plus Adam &amp; Chris).
                      </p>
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
                </details>
              </div>
            )}

          </>
        )}
      </div>
    </div>
  );
}
