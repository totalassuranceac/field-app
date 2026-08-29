import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoginPage } from "./pages/LoginPage";
import { JoinPage } from "./pages/JoinPage";
import { DashboardPage } from "./pages/DashboardPage";

/** Lazy pages — home/login stay eager so phones paint fast */
const FuelPage = lazy(() =>
  import("./pages/FuelPage").then((m) => ({ default: m.FuelPage }))
);
const FuelReceiptReviewPage = lazy(() =>
  import("./pages/FuelReceiptReviewPage").then((m) => ({ default: m.FuelReceiptReviewPage }))
);
const AlertsPage = lazy(() =>
  import("./pages/AlertsPage").then((m) => ({ default: m.AlertsPage }))
);
const VehiclesPage = lazy(() =>
  import("./pages/VehiclesPage").then((m) => ({ default: m.VehiclesPage }))
);
const YardPage = lazy(() => import("./pages/YardPage").then((m) => ({ default: m.YardPage })));
const IssuesPage = lazy(() =>
  import("./pages/IssuesPage").then((m) => ({ default: m.IssuesPage }))
);
const ReportsPage = lazy(() =>
  import("./pages/ReportsPage").then((m) => ({ default: m.ReportsPage }))
);
const AdminPage = lazy(() =>
  import("./pages/AdminPage").then((m) => ({ default: m.AdminPage }))
);
const AuditPage = lazy(() =>
  import("./pages/AuditPage").then((m) => ({ default: m.AuditPage }))
);
const LiveMapPage = lazy(() =>
  import("./pages/LiveMapPage").then((m) => ({ default: m.LiveMapPage }))
);
const WarehouseCamerasPage = lazy(() =>
  import("./pages/WarehouseCamerasPage").then((m) => ({ default: m.WarehouseCamerasPage }))
);
const InspectionsPage = lazy(() =>
  import("./pages/InspectionsPage").then((m) => ({ default: m.InspectionsPage }))
);
const DowntimePage = lazy(() =>
  import("./pages/DowntimePage").then((m) => ({ default: m.DowntimePage }))
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const ServicePage = lazy(() =>
  import("./pages/ServicePage").then((m) => ({ default: m.ServicePage }))
);
const NotificationsPage = lazy(() =>
  import("./pages/NotificationsPage").then((m) => ({ default: m.NotificationsPage }))
);
const InventoryPage = lazy(() =>
  import("./pages/InventoryPage").then((m) => ({ default: m.InventoryPage }))
);
const AssetsPage = lazy(() =>
  import("./pages/AssetsPage").then((m) => ({ default: m.AssetsPage }))
);
const VendorRunsPage = lazy(() =>
  import("./pages/VendorRunsPage").then((m) => ({ default: m.VendorRunsPage }))
);
const PartsDropOffPage = lazy(() =>
  import("./pages/PartsDropOffPage").then((m) => ({ default: m.PartsDropOffPage }))
);
const TruckStockCountPage = lazy(() =>
  import("./pages/TruckStockCountPage").then((m) => ({ default: m.TruckStockCountPage }))
);
const WarrantiesPage = lazy(() =>
  import("./pages/WarrantiesPage").then((m) => ({ default: m.WarrantiesPage }))
);
const PartsPurchasesPage = lazy(() =>
  import("./pages/PartsPurchasesPage").then((m) => ({ default: m.PartsPurchasesPage }))
);
const DumpRunsPage = lazy(() =>
  import("./pages/DumpRunsPage").then((m) => ({ default: m.DumpRunsPage }))
);
const HandbookPage = lazy(() =>
  import("./pages/HandbookPage").then((m) => ({ default: m.HandbookPage }))
);
const OnboardingPage = lazy(() =>
  import("./pages/OnboardingPage").then((m) => ({ default: m.OnboardingPage }))
);
const TerminationPage = lazy(() =>
  import("./pages/TerminationPage").then((m) => ({ default: m.TerminationPage }))
);
const HowToPage = lazy(() =>
  import("./pages/HowToPage").then((m) => ({ default: m.HowToPage }))
);
const ReviewsPage = lazy(() =>
  import("./pages/ReviewsPage").then((m) => ({ default: m.ReviewsPage }))
);
const RolesPage = lazy(() =>
  import("./pages/RolesPage").then((m) => ({ default: m.RolesPage }))
);
const TimeOffPage = lazy(() =>
  import("./pages/TimeOffPage").then((m) => ({ default: m.TimeOffPage }))
);
const ToolLoanPage = lazy(() =>
  import("./pages/ToolLoanPage").then((m) => ({ default: m.ToolLoanPage }))
)
const ToolLoanLedgerPage = lazy(() =>
  import("./pages/ToolLoanLedgerPage").then((m) => ({ default: m.ToolLoanLedgerPage }))
);
const PartsOrderPage = lazy(() =>
  import("./pages/PartsOrderPage").then((m) => ({ default: m.PartsOrderPage }))
);
const PartsRunPage = lazy(() =>
  import("./pages/PartsRunPage").then((m) => ({ default: m.PartsRunPage }))
);
const TvBoardPage = lazy(() =>
  import("./pages/TvBoardPage").then((m) => ({ default: m.TvBoardPage }))
);
const StudioPage = lazy(() =>
  import("./pages/StudioPage").then((m) => ({ default: m.StudioPage }))
);
const FeedbackPage = lazy(() =>
  import("./pages/FeedbackPage").then((m) => ({ default: m.FeedbackPage }))
);

function PageFallback() {
  return (
    <div className="login-page" style={{ minHeight: "40vh" }}>
      <div className="muted">Loading…</div>
    </div>
  );
}

function LazyPage({
  title,
  Page,
}: {
  title: string;
  Page: ComponentType;
}) {
  return (
    <ErrorBoundary title={title}>
      <Suspense fallback={<PageFallback />}>
        <Page />
      </Suspense>
    </ErrorBoundary>
  );
}

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
                    <Route path="/live" element={<LazyPage title="Live map" Page={LiveMapPage} />} />
                    <Route
                      path="/warehouse-cameras"
                      element={
                        <LazyPage title="Security cameras" Page={WarehouseCamerasPage} />
                      }
                    />
                    <Route path="/fuel" element={<LazyPage title="Fuel log" Page={FuelPage} />} />
                    <Route
                      path="/fuel/receipt-review"
                      element={
                        <LazyPage title="Fuel receipt OCR review" Page={FuelReceiptReviewPage} />
                      }
                    />
                    <Route
                      path="/alerts"
                      element={<LazyPage title="Fuel alerts" Page={AlertsPage} />}
                    />
                    <Route
                      path="/inspections"
                      element={<LazyPage title="Inspections" Page={InspectionsPage} />}
                    />
                    <Route
                      path="/vehicles"
                      element={<LazyPage title="Vehicles" Page={VehiclesPage} />}
                    />
                    <Route path="/yard" element={<LazyPage title="Yard" Page={YardPage} />} />
                    <Route
                      path="/issues"
                      element={<LazyPage title="Shop board" Page={IssuesPage} />}
                    />
                    <Route
                      path="/service"
                      element={<LazyPage title="Oil changes" Page={ServicePage} />}
                    />
                    <Route
                      path="/notifications"
                      element={<LazyPage title="Inbox" Page={NotificationsPage} />}
                    />
                    <Route path="/messages" element={<Navigate to="/notifications" replace />} />
                    <Route
                      path="/part-pickup"
                      element={<LazyPage title="Part pickup request" Page={VendorRunsPage} />}
                    />
                    <Route path="/vendor-runs" element={<Navigate to="/part-pickup" replace />} />
                    <Route
                      path="/parts-dropoff"
                      element={<LazyPage title="Brought to shop" Page={PartsDropOffPage} />}
                    />
                    <Route
                      path="/truck-stock"
                      element={<LazyPage title="Count truck stock" Page={TruckStockCountPage} />}
                    />
                    <Route
                      path="/warranties"
                      element={<LazyPage title="Warranties" Page={WarrantiesPage} />}
                    />
                    <Route
                      path="/parts-receipts"
                      element={<LazyPage title="Bought parts" Page={PartsPurchasesPage} />}
                    />
                    <Route
                      path="/dump-runs"
                      element={<LazyPage title="Dump runs" Page={DumpRunsPage} />}
                    />
                    <Route
                      path="/downtime"
                      element={<LazyPage title="Downtime" Page={DowntimePage} />}
                    />
                    <Route
                      path="/reports"
                      element={<LazyPage title="Reports" Page={ReportsPage} />}
                    />
                    <Route
                      path="/inventory"
                      element={<LazyPage title="Inventory" Page={InventoryPage} />}
                    />
                    <Route
                      path="/assets"
                      element={<LazyPage title="Company assets" Page={AssetsPage} />}
                    />
                    <Route
                      path="/handbook"
                      element={<LazyPage title="Employee handbook" Page={HandbookPage} />}
                    />
                    <Route
                      path="/onboarding"
                      element={<LazyPage title="New hire packet" Page={OnboardingPage} />}
                    />
                    <Route
                      path="/termination"
                      element={
                        <LazyPage title="Separation notice" Page={TerminationPage} />
                      }
                    />
                    <Route
                      path="/howto"
                      element={<LazyPage title="How-to guides" Page={HowToPage} />}
                    />
                    <Route
                      path="/feedback"
                      element={<LazyPage title="App feedback" Page={FeedbackPage} />}
                    />
                    <Route
                      path="/time-off"
                      element={<LazyPage title="Time off request" Page={TimeOffPage} />}
                    />
                    <Route
                      path="/tool-loans"
                      element={<LazyPage title="Tool loan request" Page={ToolLoanPage} />}
                    />
                    <Route
                      path="/tool-loan-ledger"
                      element={
                        <LazyPage title="Tool loan payroll" Page={ToolLoanLedgerPage} />
                      }
                    />
                    <Route
                      path="/parts-orders"
                      element={<LazyPage title="Order for shop" Page={PartsOrderPage} />}
                    />
                    <Route
                      path="/parts-runs"
                      element={
                        <LazyPage title="Warehouse delivery request" Page={PartsRunPage} />
                      }
                    />
                    <Route
                      path="/reviews"
                      element={<LazyPage title="Our reviews" Page={ReviewsPage} />}
                    />
                    <Route
                      path="/tv"
                      element={<LazyPage title="TV board" Page={TvBoardPage} />}
                    />
                    <Route
                      path="/studio"
                      element={<LazyPage title="Studio" Page={StudioPage} />}
                    />
                    <Route
                      path="/roles"
                      element={<LazyPage title="Preview roles" Page={RolesPage} />}
                    />
                    <Route
                      path="/settings"
                      element={<LazyPage title="Settings" Page={SettingsPage} />}
                    />
                    <Route path="/admin" element={<LazyPage title="People" Page={AdminPage} />} />
                    <Route path="/audit" element={<LazyPage title="Change history" Page={AuditPage} />} />
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
