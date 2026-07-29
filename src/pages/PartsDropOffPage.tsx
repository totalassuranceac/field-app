import { PartsDropOffPanel } from "../components/PartsDropOffPanel";

/** Employees log parts they brought from a vendor to the shop; warehouse receives them. */
export function PartsDropOffPage() {
  return (
    <div className="msg-page">
      <PartsDropOffPanel />
    </div>
  );
}
