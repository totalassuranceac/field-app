import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { FuelPage } from "./pages/FuelPage";
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
import { MessagesPage } from "./pages/MessagesPage";
import { WarrantiesPage } from "./pages/WarrantiesPage";
import { HandbookPage } from "./pages/HandbookPage";
import { RolesPage } from "./pages/RolesPage";

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="login-page">
        <div className="muted">Loading…</div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** After admin creates/resets password, force user into Settings to pick their own. */
function PasswordGate({ children }: { children: React.ReactNode }) {
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

function Page({ children, title }: { children: React.ReactNode; title: string }) {
  return <ErrorBoundary title={title}>{children}</ErrorBoundary>;
}

export default function App() {
  return (
    <ErrorBoundary title="App error">
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
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
                  <Route
                    path="/messages"
                    element={
                      <Page title="Messages">
                        <MessagesPage />
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
