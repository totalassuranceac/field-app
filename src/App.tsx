import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoginPage } from "./pages/LoginPage";
import { JoinPage } from "./pages/JoinPage";
import { DashboardPage } from "./pages/DashboardPage";
import { FuelPage } from "./pages/FuelPage";
import { FuelReceiptReviewPage } from "./pages/FuelReceiptReviewPage";
import { AlertsPage } from "./pages/AlertsPage";
import { VehiclesPage } from "./pages/VehiclesPage";
import { YardPage } from "./pages/YardPage";
import { IssuesPage } from "./pages/IssuesPage";
import { ReportsPage } from "./pages/ReportsPage";
import { AdminPage } from "./pages/AdminPage";
import { AuditPage } from "./pages/AuditPage";
import { LiveMapPage } from "./pages/LiveMapPage";
import { InspectionsPage } from "./pages/InspectionsPage";
import { DowntimePage } from "./pages/DowntimePage";
import { SettingsPage } from "./pages/SettingsPage";
import { ServicePage } from "./pages/ServicePage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { InventoryPage } from "./pages/InventoryPage";
import { AssetsPage } from "./pages/AssetsPage";

import { VendorRunsPage } from "./pages/VendorRunsPage";
import { PartsDropOffPage } from "./pages/PartsDropOffPage";
import { TruckStockCountPage } from "./pages/TruckStockCountPage";
import { WarrantiesPage } from "./pages/WarrantiesPage";
import { PartsPurchasesPage } from "./pages/PartsPurchasesPage";
import { HandbookPage } from "./pages/HandbookPage";
import { HowToPage } from "./pages/HowToPage";
import { ReviewsPage } from "./pages/ReviewsPage";
import { RolesPage } from "./pages/RolesPage";

function Protected({ children }: { children: ReactNode }) {
  const { user, loading, refresh } = useAuth();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), 2500);
    return () => window.clearTimeout(t);
  }, [loading]);

  if (loading && !user) {
    return (
      <div className="login-page">
        <div style={{ textAlign: "center", maxWidth: "18rem" }}>
          <div className="muted">Loading…</div>
          {slow && (
            <div style={{ marginTop: "0.85rem" }}>
              <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.65rem" }}>
                Taking longer than usual — weak signal or server wake-up.
              </p>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void refresh();
                }}
              >
                Retry
              </button>
              <button
                type="button"
                className="btn secondary btn-sm"
                style={{ marginLeft: "0.4rem" }}
                onClick={() => window.location.assign(`/?reload=${Date.now()}`)}
              >
                Reload app
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** After admin creates/resets password, force user into Settings to pick their own. */
function PasswordGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user?.must_change_password && location.pathname !== "/settings") {
    return <Navigate to="/settings" replace />;
  }
  return <>{children}</>;
}

function LoginRoute() {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  if (!loading && user) {
    const next = params.get("next");
    const dest = next && next.startsWith("/") ? next : "/";
    return <Navigate to={dest} replace />;
  }
  return <LoginPage />;
}

function Page({ children, title }: { children: ReactNode; title: string }) {
  return <ErrorBoundary title={title}>{children}</ErrorBoundary>;
}

export default function App() {
  return (
    <ErrorBoundary title="App error">
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/join/:token" element={<JoinPage />} />
        <Route
          path="/*"
          element={
            <Protected>
              <PasswordGate>
              <Layout>
                <Routes>
                  <Route
                    path="/"
                    element={
                      <Page title="Home">
                        <DashboardPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/live"
                    element={
                      <Page title="Live map">
                        <LiveMapPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/fuel"
                    element={
                      <Page title="Fuel log">
                        <FuelPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/fuel/receipt-review"
                    element={
                      <Page title="Fuel receipt OCR review">
                        <FuelReceiptReviewPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/alerts"
                    element={
                      <Page title="Mileage flags">
                        <AlertsPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/inspections"
                    element={
                      <Page title="Inspections">
                        <InspectionsPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/vehicles"
                    element={
                      <Page title="Vehicles">
                        <VehiclesPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/yard"
                    element={
                      <Page title="Yard walk">
                        <YardPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/issues"
                    element={
                      <Page title="Repairs">
                        <IssuesPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/service"
                    element={
                      <Page title="Oil changes">
                        <ServicePage />
                      </Page>
                    }
                  />
                  <Route
                    path="/notifications"
                    element={
                      <Page title="Notifications">
                        <NotificationsPage />
                      </Page>
                    }
                  />
                  {/* Messaging removed — keep old links from landing on a dead page */}
                  <Route path="/messages" element={<Navigate to="/notifications" replace />} />
                  <Route
                    path="/part-pickup"
                    element={
                      <Page title="Part pickup">
                        <VendorRunsPage />
                      </Page>
                    }
                  />
                  <Route path="/vendor-runs" element={<Navigate to="/part-pickup" replace />} />
                  <Route
                    path="/parts-dropoff"
                    element={
                      <Page title="Parts drop-off">
                        <PartsDropOffPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/truck-stock"
                    element={
                      <Page title="Truck stock count">
                        <TruckStockCountPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/warranties"
                    element={
                      <Page title="Warranties">
                        <WarrantiesPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/parts-receipts"
                    element={
                      <Page title="Parts receipts">
                        <PartsPurchasesPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/downtime"
                    element={
                      <Page title="Downtime">
                        <DowntimePage />
                      </Page>
                    }
                  />
                  <Route
                    path="/reports"
                    element={
                      <Page title="Reports">
                        <ReportsPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/inventory"
                    element={
                      <Page title="Inventory">
                        <InventoryPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/assets"
                    element={
                      <Page title="Company assets">
                        <AssetsPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/handbook"
                    element={
                      <Page title="Employee handbook">
                        <HandbookPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/howto"
                    element={
                      <Page title="How-to">
                        <HowToPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/reviews"
                    element={
                      <Page title="Our reviews">
                        <ReviewsPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/roles"
                    element={
                      <Page title="Role simulator">
                        <RolesPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/settings"
                    element={
                      <Page title="Settings">
                        <SettingsPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/admin"
                    element={
                      <Page title="Admin">
                        <AdminPage />
                      </Page>
                    }
                  />
                  <Route
                    path="/audit"
                    element={
                      <Page title="Audit">
                        <AuditPage />
                      </Page>
                    }
                  />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Layout>
              </PasswordGate>
            </Protected>
          }
        />
      </Routes>
    </ErrorBoundary>
  );
}
