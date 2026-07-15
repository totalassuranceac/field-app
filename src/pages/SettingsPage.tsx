import { useTheme } from "../theme";
import { useAuth } from "../auth";

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { user } = useAuth();

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Display preferences and your account</p>
        </div>
      </div>

      <div className="grid two">
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

        <div className="card">
          <h2>Your account</h2>
          <dl className="settings-dl">
            <div>
              <dt>Name</dt>
              <dd>{user?.display_name || "—"}</dd>
            </div>
            <div>
              <dt>Username / email</dt>
              <dd>{user?.username || user?.email || "—"}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>
                <span className="badge info">{user?.role || "—"}</span>
              </dd>
            </div>
          </dl>
          <p className="muted" style={{ fontSize: "0.88rem", marginBottom: 0 }}>
            Forgot your password? Ask a fleet admin to reset it under{" "}
            <strong>Admin → Users</strong>.
          </p>
        </div>

        <div className="card">
          <h2>How this app is organized</h2>
          <ul className="help-list">
            <li>
              <strong>Fuel log</strong> — scan receipt, confirm gallons/$, enter odometer
            </li>
            <li>
              <strong>Live map</strong> — see OneStep &amp; Verizon GPS together
            </li>
            <li>
              <strong>Inspections</strong> — quick walk-around before problems grow
            </li>
            <li>
              <strong>Repairs</strong> — report issues; managers schedule work
            </li>
            <li>
              <strong>Yard walk</strong> — stickers, insurance dates, dash cams
            </li>
            <li>
              <strong>Downtime</strong> — how long units are out of service
            </li>
          </ul>
        </div>

        <div className="card">
          <h2>If something fails</h2>
          <ul className="help-list">
            <li>Check your signal / Wi‑Fi, then pull to refresh or tap Refresh</li>
            <li>Sign out and sign back in if pages keep erroring</li>
            <li>Fuel can still be saved if receipt scan fails — enter gallons manually</li>
            <li>GPS map needs server GPS secrets; other modules still work offline of map</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
