import { VendorRunPanel } from "../components/VendorRunPanel";

/** Team-wide entry: office + techs log will-calls; warehouse runs by vendor. */
export function VendorRunsPage() {
  return (
    <div className="msg-page">
      <VendorRunPanel />
    </div>
  );
}
