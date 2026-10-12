export type Role =
  | "admin"
  | "office"
  | "driver"
  | "mechanic"
  | "viewer"
  | "warehouse"
  | "supervisor";

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
  /** Twilio SMS (optional — enables text alerts to drivers / shop) */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** Legacy / fallback sender. Prefer TWILIO_MESSAGING_SERVICE_SID for A2P 10DLC. */
  TWILIO_FROM_NUMBER?: string;
  /** A2P Messaging Service (MG…) — preferred; Twilio picks an approved From from the sender pool */
  TWILIO_MESSAGING_SERVICE_SID?: string;
  /** LTS / Hikvision NVR for in-app warehouse camera snapshots (use Cloudflare Tunnel URL) */
  WAREHOUSE_NVR_URL?: string;
  WAREHOUSE_NVR_USER?: string;
  WAREHOUSE_NVR_PASS?: string;
  /** ServiceTitan API v2 (pricebook photos + future sync) */
  ST_TENANT_ID?: string;
  ST_CLIENT_ID?: string;
  ST_CLIENT_SECRET?: string;
  ST_APP_KEY?: string;
    /**
   * Clock→ST Phase 2 gate (appointment status only; never payroll/money).
   * unset/0/false/off = off (D1 queue only)
   * dry/dry-run = log intended PATCH; leave queued
   * 1/true/live/on = live PATCH /jpm/v2/.../appointments/{id} status
   */
  CLOCK_ST_WRITE?: string;
  /**
   * Miller Install quick-add Book Job gate.
   * unset / dry / dry-run / off = dry (payload only; NO ST Create Job)
   * live / 1 / true / on = live POST /jpm/v2/.../jobs
   * Soft default dry. Require READY + Chris Y before live.
   */
  MILLER_BOOK_JOB?: string;
  /**
   * Day Board pending service (No Cool) → ST link gate.
   * unset / dry = no ST Create Job (chip fails with dry hint)
   * live / 1 / true / on = live POST /jpm/v2/.../jobs (notificationsEnabled false)
   */
  DAY_BOARD_PENDING_ST?: string;

  /** Required for POST /api/st/assignment-sms. Unset = route disabled. */
  ST_ASSIGNMENT_WEBHOOK_SECRET?: string;
  /** Agent SMS key. wrangler secret only. Unset = agent-send disabled. */
  AGENT_SMS_KEY?: string;
  /**
   * Clock-in nudge kill switch / override.
   * unset = follow settings clockin_nudge_enabled (default off).
   * off/false/0 = force off.
   * dry = log texts, do not call Twilio.
   * live/on/true/1 = send. Do not set this until Chris says Y.
   */
  CLOCKIN_NUDGE_ENABLED?: string;
  /**
   * Review-text kill switch.
   * unset = follow settings review_text_mode (default off).
   * off/false/0/no = force off. Not set in this build.
   */
  REVIEW_TEXT_ENABLED?: string;
  /**
   * Review-text live send flag. Must be the string "on" before test or live can send.
   * Not set in this build. Do not put this in wrangler.toml [vars].
   */
  REVIEW_TEXT_LIVE_SEND?: string;
  /**
   * Review-text test allowlist (comma, semicolon, or newline). US numbers only.
   * In test mode a real text goes only to these numbers. Not set in this build.
   * No phone number belongs in source.
   */
  REVIEW_TEXT_TEST_NUMBER?: string;
  /**
   * Install-crew board-mismatch nudge kill switch.
   * unset = follow settings onsite_nudge_mode (default off).
   * off/false/0 = force off.
   */
  ONSITE_NUDGE_ENABLED?: string;
  /** Shared with ta-ads worker — signs Field App → Studio handoff tokens */
  STUDIO_SSO_SECRET?: string;
  /** Override live Studio URL (default https://ta-ads.totalassurance.workers.dev) */
  STUDIO_URL?: string;
  /**
   * Atlas ping on new warranty drop-off (POST /warranties 201 only).
   * URL is required. AUTH and HEADER are optional. A missing URL skips the ping;
   * the drop-off still succeeds.
   */
  ATLAS_WARRANTY_WEBHOOK_URL?: string;
  /**
   * OPTIONAL. Key/token value. If it has no space and the header is Authorization,
   * it is sent as `Bearer <value>`. If it already starts with `Bearer `/`Basic `/etc.,
   * it is sent verbatim.
   */
  ATLAS_WARRANTY_WEBHOOK_AUTH?: string;
  /**
   * OPTIONAL header name for the key (default Authorization; e.g. X-Api-Key, X-Webhook-Secret).
   * Must match /^[A-Za-z0-9-]{1,40}$/ else fall back to Authorization.
   */
  ATLAS_WARRANTY_WEBHOOK_HEADER?: string;
  /**
   * Optional one-shot Atlas wake when Eric Gonzalez (361-446-0930) texts inbound.
   * `wrangler secret put ATLAS_ERIC_SMS_WEBHOOK_URL` / `ATLAS_ERIC_SMS_WEBHOOK_AUTH`.
   * Missing either = skip quietly; Twilio inbound still 200.
   */
  ATLAS_ERIC_SMS_WEBHOOK_URL?: string;
  /** Full Authorization header value as Atlas expects. */
  ATLAS_ERIC_SMS_WEBHOOK_AUTH?: string;
  /**
   * Optional Atlas wake after fuel receipt photo is saved (verify photo vs OCR).
   * `wrangler secret put ATLAS_FUEL_RECEIPT_WEBHOOK_URL` / `_AUTH`.
   * Missing either = skip quietly; /fuel still succeeds.
   */
  ATLAS_FUEL_RECEIPT_WEBHOOK_URL?: string;
  /** Full Authorization header value as Atlas expects. */
  ATLAS_FUEL_RECEIPT_WEBHOOK_AUTH?: string;
  /**
   * Optional Workers AI. Not bound in this build. Done-today split stays on rules
   * until Chris adds the binding and sets done_today_ai=1.
   */
  AI?: {
    run: (model: string, input: { prompt: string }) => Promise<unknown>;
  };
}

export interface UserRow {
  id: number;
  email: string | null;
  username: string | null;
  display_name: string;
  password_hash: string | null;
  password_salt: string | null;
  role: Role;
  /** 1 = warehouse staff (role stored as office in DB due to CHECK constraint) */
  is_warehouse?: number;
  employee_id: number | null;
  phone: string | null;
  /** ServiceTitan technician id for Zero-charge counts */
  st_technician_id?: number | null;
  must_change_password: number;
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
  /** True when account is warehouse (may also have office base role in DB) */
  is_warehouse?: boolean;
  employee_id: number | null;
  phone: string | null;
  st_technician_id?: number | null;
  must_change_password: boolean;
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
  tank_capacity_gallons: number | null;
  status: "active" | "out_of_service" | "retired";
  current_odometer: number | null;
  assigned_driver: string | null;
  phone: string | null;
  insurance_card: string | null;
  dash_cam_status: "working" | "not_working" | "missing" | "n/a";
  cam_type: string | null;
  gps_tracker: string | null;
  gps_status: "working" | "not_working" | "missing" | "n/a" | null;
  registration_expires: string | null;
  inspection_expires: string | null;
  insurance_expires: string | null;
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
  fuel_time: string | null;
  store_number: string | null;
  card_last4: string | null;
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
  /** pending | confirmed | declined when status is scheduled */
  tech_confirm_status: string | null;
  tech_confirmed_at: string | null;
  tech_confirmed_by_user_id: number | null;
  tech_confirm_note: string | null;
  completed_at: string | null;
  completion_notes: string | null;
  photo_key: string | null;
  /** driver = tech reported; shop = mechanic logged work themselves */
  origin: string | null;
  created_at: string;
  updated_at: string;
}

export type Variables = {
  user: PublicUser;
  /** Real logged-in account (admin) even while view-as is active */
  realUser: PublicUser;
  viewAsUserId: number | null;
};
