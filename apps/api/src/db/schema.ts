import { randomInt } from "node:crypto";
import type { NotificationLink } from "@crewdesk/shared";
import {
  boolean,
  primaryKey,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const companyId = () =>
  uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" });
/** Unambiguous characters (no 0/O, 1/I/L) so a code can be typed in by hand if a label is damaged. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newAssetCode() {
  return Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const companies = pgTable("companies", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/Chicago"),
  /** "csv" exports timesheets only; "check" pushes to the Check payroll API. */
  payrollProvider: text("payroll_provider").notNull().default("csv"),
  payrollProviderCompanyId: text("payroll_provider_company_id"),
  weeklyOvertimeThreshold: doublePrecision("weekly_overtime_threshold").notNull().default(40),
  /** Texts cost money per message, so the owner turns them on for the company. */
  smsEnabled: boolean("sms_enabled").notNull().default(false),
  /** Lowest role that must use two-factor sign-in ("owner", "admin", "manager", "employee"), or "none". */
  twoFactorRequiredFor: text("two_factor_required_for").notNull().default("admin"),
  /** Employer details printed on tax forms. */
  legalName: text("legal_name"),
  ein: text("ein"),
  address: text("address"),
  /** Collect W-4, I-9 and direct deposit in Crewdesk (off when a payroll provider collects them). */
  taxFormsInCrewdesk: boolean("tax_forms_in_crewdesk").notNull().default(true),
  /** Lowest role that can create wiki pages ("employee" = everyone). */
  wikiCreateMin: text("wiki_create_min").notNull().default("admin"),
  /** Location rule for clocking in / out: optional | required | geofence_flag | geofence_block */
  clockInLocation: text("clock_in_location").notNull().default("optional"),
  clockOutLocation: text("clock_out_location").notNull().default("optional"),
  createdAt: createdAt(),
});

export const employees = pgTable(
  "employees",
  {
    id: id(),
    companyId: companyId(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull().unique(),
    phone: text("phone"),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("employee"),
    title: text("title"),
    department: text("department"),
    managerId: uuid("manager_id"),
    employmentType: text("employment_type").notNull().default("full_time"),
    payType: text("pay_type").notNull().default("hourly"),
    payRateCents: integer("pay_rate_cents").notNull().default(0),
    startDate: date("start_date"),
    status: text("status").notNull().default("active"),
    payrollProviderEmployeeId: text("payroll_provider_employee_id"),
    /** When the person agreed to receive texts; null means no texts. */
    smsOptInAt: timestamp("sms_opt_in_at", { withTimezone: true }),
    /** When the latest invite email was sent; null if they were never invited. */
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    /** Bumped to sign the person out of every device; sessions carry the version they were issued with. */
    tokenVersion: integer("token_version").notNull().default(0),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** Authenticator-app secret, encrypted (see lib/crypto). Set once two-factor is turned on. */
    totpSecret: text("totp_secret"),
    /** Secret shown during setup, kept until the first code confirms it. */
    totpPendingSecret: text("totp_pending_secret"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    /** Last accepted 30-second time step, so a code can't be replayed. */
    totpLastStep: integer("totp_last_step"),
    createdAt: createdAt(),
  },
  (t) => [index("employees_company_idx").on(t.companyId)],
);

export const documents = pgTable("documents", {
  id: id(),
  companyId: companyId(),
  /** Null for company-wide documents such as the handbook. */
  employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "cascade" }),
  /** Set when the document belongs to an asset (registration, insurance card, manual). */
  assetId: uuid("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category").notNull().default("general"),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  requiresSignature: boolean("requires_signature").notNull().default(false),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  signedName: text("signed_name"),
  signedIp: text("signed_ip"),
  uploadedById: uuid("uploaded_by_id").references(() => employees.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const timeEntries = pgTable(
  "time_entries",
  {
    id: id(),
    companyId: companyId(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    clockIn: timestamp("clock_in", { withTimezone: true }).notNull(),
    clockOut: timestamp("clock_out", { withTimezone: true }),
    clockInLat: doublePrecision("clock_in_lat"),
    clockInLng: doublePrecision("clock_in_lng"),
    clockOutLat: doublePrecision("clock_out_lat"),
    clockOutLng: doublePrecision("clock_out_lng"),
    /** Reported GPS accuracy (m), the nearest job site, its distance (m), and a flag if the punch broke the rules. */
    clockInAccuracy: doublePrecision("clock_in_accuracy"),
    clockOutAccuracy: doublePrecision("clock_out_accuracy"),
    clockInSiteId: uuid("clock_in_site_id"),
    clockOutSiteId: uuid("clock_out_site_id"),
    clockInDistance: doublePrecision("clock_in_distance"),
    clockOutDistance: doublePrecision("clock_out_distance"),
    /** "off_site" when a geofence_flag punch was away from every job site. */
    clockInFlag: text("clock_in_flag"),
    clockOutFlag: text("clock_out_flag"),
    note: text("note"),
    approvedById: uuid("approved_by_id").references(() => employees.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("time_entries_employee_idx").on(t.employeeId, t.clockIn)],
);

export const ptoPolicies = pgTable("pto_policies", {
  id: id(),
  companyId: companyId(),
  name: text("name").notNull(),
  accrualRate: doublePrecision("accrual_rate").notNull().default(0),
  annualGrantHours: doublePrecision("annual_grant_hours").notNull().default(0),
  maxBalanceHours: doublePrecision("max_balance_hours"),
  createdAt: createdAt(),
});

/** Append-only ledger; an employee's balance is the sum of their rows. */
export const ptoLedger = pgTable("pto_ledger", {
  id: id(),
  companyId: companyId(),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "cascade" }),
  policyId: uuid("policy_id")
    .notNull()
    .references(() => ptoPolicies.id, { onDelete: "cascade" }),
  hours: doublePrecision("hours").notNull(),
  reason: text("reason").notNull(),
  requestId: uuid("request_id"),
  createdAt: createdAt(),
});

export const ptoRequests = pgTable("pto_requests", {
  id: id(),
  companyId: companyId(),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "cascade" }),
  policyId: uuid("policy_id")
    .notNull()
    .references(() => ptoPolicies.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  hours: doublePrecision("hours").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("pending"),
  decidedById: uuid("decided_by_id").references(() => employees.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  createdAt: createdAt(),
});

export const jobs = pgTable("jobs", {
  id: id(),
  companyId: companyId(),
  title: text("title").notNull(),
  department: text("department"),
  location: text("location"),
  description: text("description").notNull().default(""),
  payRange: text("pay_range"),
  status: text("status").notNull().default("open"),
  createdAt: createdAt(),
});

export const applicants = pgTable("applicants", {
  id: id(),
  companyId: companyId(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  notes: text("notes"),
  stage: text("stage").notNull().default("applied"),
  hiredEmployeeId: uuid("hired_employee_id").references(() => employees.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export interface OnboardingTaskTemplate {
  title: string;
  description?: string;
  assignee: "employee" | "manager" | "admin";
  dueInDays: number;
  /** "none" | "upload" | "sign". Templates saved before this existed use requiresDocument. */
  action?: "none" | "upload" | "sign" | "form";
  /** For "sign": the company document to sign. */
  documentId?: string | null;
  /** For "form": "w4" | "i9" | "direct_deposit" | "i9_section2" */
  formType?: string | null;
  requiresDocument?: boolean;
}

export const onboardingTemplates = pgTable("onboarding_templates", {
  id: id(),
  companyId: companyId(),
  name: text("name").notNull(),
  tasks: jsonb("tasks").$type<OnboardingTaskTemplate[]>().notNull(),
  createdAt: createdAt(),
});

export const onboardingTasks = pgTable("onboarding_tasks", {
  id: id(),
  companyId: companyId(),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  assignee: text("assignee").notNull().default("employee"),
  requiresDocument: boolean("requires_document").notNull().default(false),
  /** "none" (check off), "upload" (done when they upload), "sign" (done when they sign documentId). */
  action: text("action").notNull().default("none"),
  /** The uploaded file, or the document to sign. */
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  /** For "form" tasks: which tax form finishes it. */
  formType: text("form_type"),
  dueDate: date("due_date"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedById: uuid("completed_by_id").references(() => employees.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const assets = pgTable(
  "assets",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    make: text("make"),
    model: text("model"),
    year: integer("year"),
    vin: text("vin"),
    serialNumber: text("serial_number"),
    licensePlate: text("license_plate"),
    odometer: doublePrecision("odometer").notNull().default(0),
    engineHours: doublePrecision("engine_hours").notNull().default(0),
    status: text("status").notNull().default("active"),
    assignedEmployeeId: uuid("assigned_employee_id").references(() => employees.id, { onDelete: "set null" }),
    registrationExpires: date("registration_expires"),
    insuranceExpires: date("insurance_expires"),
    /** Printed on the asset's QR label. Regenerating it retires old labels. */
    qrCode: text("qr_code").unique().$defaultFn(newAssetCode),
    createdAt: createdAt(),
  },
  (t) => [index("assets_company_idx").on(t.companyId)],
);

export const meterReadings = pgTable("meter_readings", {
  id: id(),
  companyId: companyId(),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => assets.id, { onDelete: "cascade" }),
  odometer: doublePrecision("odometer"),
  engineHours: doublePrecision("engine_hours"),
  recordedById: uuid("recorded_by_id").references(() => employees.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const maintenanceSchedules = pgTable("maintenance_schedules", {
  id: id(),
  companyId: companyId(),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => assets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  intervalMiles: doublePrecision("interval_miles"),
  intervalHours: doublePrecision("interval_hours"),
  intervalDays: integer("interval_days"),
  lastServiceDate: date("last_service_date"),
  lastServiceOdometer: doublePrecision("last_service_odometer"),
  lastServiceHours: doublePrecision("last_service_hours"),
  createdAt: createdAt(),
});

export const workOrders = pgTable("work_orders", {
  id: id(),
  companyId: companyId(),
  number: integer("number").notNull(),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => assets.id, { onDelete: "cascade" }),
  scheduleId: uuid("schedule_id").references(() => maintenanceSchedules.id, { onDelete: "set null" }),
  inspectionId: uuid("inspection_id"),
  title: text("title").notNull(),
  description: text("description"),
  priority: text("priority").notNull().default("medium"),
  status: text("status").notNull().default("open"),
  assignedToId: uuid("assigned_to_id").references(() => employees.id, { onDelete: "set null" }),
  reportedById: uuid("reported_by_id").references(() => employees.id, { onDelete: "set null" }),
  dueDate: date("due_date"),
  laborHours: doublePrecision("labor_hours"),
  partsCostCents: integer("parts_cost_cents").notNull().default(0),
  laborCostCents: integer("labor_cost_cents").notNull().default(0),
  vendor: text("vendor"),
  resolutionNotes: text("resolution_notes"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export interface InspectionItem {
  item: string;
  ok: boolean;
  note?: string;
}

export const inspections = pgTable("inspections", {
  id: id(),
  companyId: companyId(),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => assets.id, { onDelete: "cascade" }),
  inspectorId: uuid("inspector_id").references(() => employees.id, { onDelete: "set null" }),
  odometer: doublePrecision("odometer"),
  engineHours: doublePrecision("engine_hours"),
  items: jsonb("items").$type<InspectionItem[]>().notNull(),
  passed: boolean("passed").notNull(),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const payrollRuns = pgTable("payroll_runs", {
  id: id(),
  companyId: companyId(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  providerReference: text("provider_reference"),
  totals: jsonb("totals").$type<Record<string, number>>(),
  createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/** Expo push tokens, one row per device. A device moves with whoever last signed in on it. */
export const pushTokens = pgTable(
  "push_tokens",
  {
    id: id(),
    companyId: companyId(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    platform: text("platform").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("push_tokens_employee_idx").on(t.employeeId)],
);

/** In-app inbox. Every push is also stored here so web users see the same alerts. */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    companyId: companyId(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: jsonb("link").$type<NotificationLink>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_employee_idx").on(t.employeeId, t.createdAt)],
);

/** Dedupe keys for scheduled alerts so "oil change overdue" is sent once, not every hour. */
export const notificationLog = pgTable("notification_log", {
  key: text("key").primaryKey(),
  companyId: companyId(),
  createdAt: createdAt(),
});

export const shifts = pgTable(
  "shifts",
  {
    id: id(),
    companyId: companyId(),
    /** Null means an open shift any employee can claim. */
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    position: text("position"),
    location: text("location"),
    /** Vehicle or equipment the employee takes on this shift. */
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    notes: text("notes"),
    /** Drafts are visible to managers only until the week is published. */
    status: text("status").notNull().default("draft"),
    dropRequestedAt: timestamp("drop_requested_at", { withTimezone: true }),
    dropReason: text("drop_reason"),
    createdAt: createdAt(),
  },
  (t) => [index("shifts_company_time_idx").on(t.companyId, t.startsAt), index("shifts_employee_idx").on(t.employeeId, t.startsAt)],
);

/** Per-person, per-category delivery choices. Missing rows mean the defaults. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    companyId: companyId(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    app: boolean("app").notNull().default(true),
    email: text("email").notNull().default("no_app"),
    sms: text("sms").notNull().default("never"),
  },
  (t) => [primaryKey({ columns: [t.employeeId, t.category] })],
);

/** Recurring times someone can't work (see AvailabilityRule in @crewdesk/shared). */
export const availability = pgTable(
  "availability",
  {
    id: id(),
    companyId: companyId(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** 0 = Sunday … 6 = Saturday */
    weekday: integer("weekday").notNull(),
    startTime: text("start_time"),
    endTime: text("end_time"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("availability_employee_idx").on(t.employeeId)],
);

/** Saved shift presets, e.g. "Morning crew 7:00–15:30, Driver, Truck 12". */
export const shiftTemplates = pgTable("shift_templates", {
  id: id(),
  companyId: companyId(),
  name: text("name").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  position: text("position"),
  location: text("location"),
  assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: createdAt(),
});

/** One-time backup codes for two-factor sign-in, stored as SHA-256 hashes. */
export const recoveryCodes = pgTable("recovery_codes", {
  id: id(),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Emailed one-time links: password resets and new-hire invites. Only a hash of the token is stored. */
export const passwordResets = pgTable("password_resets", {
  id: id(),
  /** "reset" or "invite" */
  purpose: text("purpose").notNull().default("reset"),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * W-4, I-9 and direct deposit forms filled out in Crewdesk. The answers (which
 * include Social Security and bank account numbers) are encrypted; only the
 * employee and admins can open them, and every view is logged.
 * A newer form of the same type supersedes the old one; old ones are kept for
 * record retention (W-4: 4 years; I-9: 3 years after hire or 1 year after
 * leaving, whichever is later).
 */
export const taxForms = pgTable(
  "tax_forms",
  {
    id: id(),
    companyId: companyId(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** "submitted"; an I-9 becomes "completed" once an admin finishes Section 2. */
    status: text("status").notNull().default("submitted"),
    data: text("data").notNull(),
    /** Last 4 of SSN / account, for lists without decrypting. */
    summary: text("summary"),
    signedName: text("signed_name").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    signedIp: text("signed_ip"),
    signedUserAgent: text("signed_user_agent"),
    /** I-9 Section 2 (employer), encrypted. */
    employerData: text("employer_data"),
    employerSignedName: text("employer_signed_name"),
    employerSignedAt: timestamp("employer_signed_at", { withTimezone: true }),
    employerSignedById: uuid("employer_signed_by_id").references(() => employees.id, { onDelete: "set null" }),
    /** When an admin entered it into payroll (for manual payroll). */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processedById: uuid("processed_by_id").references(() => employees.id, { onDelete: "set null" }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("tax_forms_employee_idx").on(t.employeeId, t.type)],
);

/** Who opened which sensitive record, and when. */
export const sensitiveAccessLog = pgTable("sensitive_access_log", {
  id: id(),
  companyId: companyId(),
  viewerId: uuid("viewer_id").references(() => employees.id, { onDelete: "set null" }),
  employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "cascade" }),
  taxFormId: uuid("tax_form_id").references(() => taxForms.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  ip: text("ip"),
  createdAt: createdAt(),
});

/**
 * Company wiki. viewMin/editMin are the lowest role that can see/edit the
 * page ("employee" = everyone). Deleted pages are kept (deletedAt) so they
 * can be recovered.
 */
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: id(),
    companyId: companyId(),
    parentId: uuid("parent_id"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    viewMin: text("view_min").notNull().default("employee"),
    editMin: text("edit_min").notNull().default("admin"),
    pinned: boolean("pinned").notNull().default(false),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedById: uuid("updated_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("wiki_pages_company_idx").on(t.companyId, t.parentId)],
);

/** Every saved version of a wiki page. */
export const wikiRevisions = pgTable(
  "wiki_revisions",
  {
    id: id(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    note: text("note"),
    editedById: uuid("edited_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("wiki_revisions_page_idx").on(t.pageId, t.createdAt)],
);

/** Places people may clock in/out: the yard, the shop, client properties. */
export const jobSites = pgTable("job_sites", {
  id: id(),
  companyId: companyId(),
  name: text("name").notNull(),
  address: text("address"),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  radiusMeters: integer("radius_meters").notNull().default(150),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

/** Spray tank mix sheets (e.g. "Truck Mix" at 87.12 gal/acre). See computeMix in @crewdesk/shared. */
export const mixSheets = pgTable("mix_sheets", {
  id: id(),
  companyId: companyId(),
  name: text("name").notNull(),
  gallonsPerAcre: doublePrecision("gallons_per_acre").notNull(),
  defaultTankGallons: doublePrecision("default_tank_gallons").notNull(),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedById: uuid("updated_by_id").references(() => employees.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

export const mixProducts = pgTable("mix_products", {
  id: id(),
  sheetId: uuid("sheet_id")
    .notNull()
    .references(() => mixSheets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  ratePerAcre: doublePrecision("rate_per_acre").notNull(),
  unit: text("unit").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** Employees chosen by an admin to edit mix sheets (admins can always edit). */
export const mixEditors = pgTable(
  "mix_editors",
  {
    companyId: companyId(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.employeeId] })],
);

/** Who changed what on a mix sheet: rates are doses, so every change is kept. */
export const mixChanges = pgTable(
  "mix_changes",
  {
    id: id(),
    companyId: companyId(),
    sheetId: uuid("sheet_id"),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    summary: text("summary").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("mix_changes_sheet_idx").on(t.sheetId, t.createdAt)],
);
