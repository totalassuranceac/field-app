export type Role = "admin" | "office" | "driver" | "mechanic" | "viewer";

export interface Env {
  DB: D1Database;
  RECEIPTS?: R2Bucket;
  ASSETS?: Fetcher;
  APP_NAME: string;
  WORKSPACE_DOMAIN: string;
  GOOGLE_ALLOWED_EXTRA: string;
  SESSION_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APP_BASE_URL?: string;
  /** OneStepGPS portal login (technicians) */
  ONESTEP_USER?: string;
  ONESTEP_PASS?: string;
  /** Verizon Connect Reveal login (mechanics / Verizon units) */
  VERIZON_USER?: string;
  VERIZON_PASS?: string;
}

export interface UserRow {
  id: number;
  email: string | null;
  username: string | null;
  display_name: string;
  password_hash: string | null;
  password_salt: string | null;
  role: Role;
  employee_id: number | null;
  auth_provider: "password" | "google" | "both";
  google_sub: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: number;
  email: string | null;
  username: string | null;
  display_name: string;
  role: Role;
  employee_id: number | null;
}

export interface EmployeeRow {
  id: number;
  name: string;
  active: number;
  phone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface VehicleRow {
  id: number;
  unit_number: string;
  plate: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  vin: string | null;
  status: "active" | "out_of_service" | "retired";
  current_odometer: number | null;
  assigned_driver: string | null;
  phone: string | null;
  insurance_card: string | null;
  dash_cam_status: "working" | "not_working" | "missing" | "unknown";
  cam_type: string | null;
  gps_tracker: string | null;
  registration_expires: string | null;
  inspection_expires: string | null;
  insurance_expires: string | null;
  emissions_expires: string | null;
  modifications: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface FuelEntryRow {
  id: number;
  employee_id: number;
  vehicle_id: number;
  odometer: number;
  gallons: number | null;
  total_cost: number | null;
  fuel_date: string;
  station_notes: string | null;
  receipt_key: string | null;
  entered_by_user_id: number;
  created_at: string;
  updated_at: string;
}

export interface MileageAlertRow {
  id: number;
  fuel_entry_id: number;
  vehicle_id: number;
  alert_type: "decrease" | "large_jump" | "no_baseline" | "duplicate_day";
  message: string;
  severity: "info" | "warning" | "critical";
  status: "open" | "acknowledged" | "dismissed";
  acknowledged_by_user_id: number | null;
  acknowledged_at: string | null;
  acknowledge_note: string | null;
  created_at: string;
}

export interface VehicleIssueRow {
  id: number;
  vehicle_id: number;
  reported_by_user_id: number;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string | null;
  status: "open" | "scheduled" | "in_progress" | "completed" | "cancelled";
  scheduled_date: string | null;
  schedule_notes: string | null;
  completed_at: string | null;
  completion_notes: string | null;
  photo_key: string | null;
  created_at: string;
  updated_at: string;
}

export type Variables = {
  user: PublicUser;
};
