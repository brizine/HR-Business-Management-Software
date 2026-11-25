import { randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AutomationStep, CustomValues, LateFeeRule, SendSchedule, TodoRule, BillingSettings, Bracket, Tier, ActiveIngredient, AccountingSettings, AttendanceRules, HolidayRule, HolidayRules, NotificationLink, PtoTier, QuizQuestion, RoleAccess, FleetSettings, ReviewProgram, MeasureShape, MeasureImagerySettings, WeatherSettings, ChemicalNoticeSettings, TemplateDefaults } from "@crewdesk/shared";
import {
  type AnyPgColumn,
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
  uniqueIndex,
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
  /** Stripe connection (Settings → Integrations): publishable key, test or live, the webhook Crewdesk made. */
  stripe: jsonb("stripe").$type<{ publishableKey: string; mode: "test" | "live"; webhookEndpointId?: string | null; accountName?: string | null; connectedAt?: string; webhookEvents?: number }>(),
  /** Stripe secret key and webhook signing secret, encrypted. */
  stripeSecret: text("stripe_secret"),
  stripeWebhookSecret: text("stripe_webhook_secret"),
  /** Invoice numbering, terms and the printed footer (Settings → Billing); defaults apply when unset. */
  billing: jsonb("billing").$type<Partial<BillingSettings>>(),
  /** Which template goes out with invoices, estimates and receipts (Marketing → Templates), and the review link. */
  templateDefaults: jsonb("template_defaults").$type<Partial<TemplateDefaults>>(),
  /** Weather on chemical applications: automatic, manual or off. */
  weather: jsonb("weather").$type<WeatherSettings>(),
  /** Chemical application records: the company's pesticide license number (on every record). */
  pesticideLicenseNo: text("pesticide_license_no"),
  /** Set on a test company: the real company it's a sandbox for (sample customers, test mode payments). */
  testOfCompanyId: uuid("test_of_company_id").references((): AnyPgColumn => companies.id, { onDelete: "cascade" }),
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
  /** Bigcapital connection (see accounting.ts in @crewdesk/shared); the API key is kept encrypted, apart. */
  accounting: jsonb("accounting").$type<AccountingSettings>(),
  accountingKey: text("accounting_key"),
  /** Texting customers from the company's own number (Talkroute); the API key is encrypted in textingKey. */
  /** After-application customer notices (Chemical Tracking): on or off, and the wording. */
  chemicalNotices: jsonb("chemical_notices").$type<Partial<ChemicalNoticeSettings>>(),
  texting: jsonb("texting").$type<{ provider: "talkroute"; fromNumber: string; connectedAt: string; accountName?: string | null; inboundSince?: string | null }>(),
  textingKey: text("texting_key"),
  /** Grace periods, alerts and points for attendance (see attendance.ts in @crewdesk/shared). */
  attendanceRules: jsonb("attendance_rules").$type<AttendanceRules>(),
  /** The company's own edited copy of the user manual (Markdown); null = the standard docs/help-guide.md. */
  helpGuide: text("help_guide"),
  /** A fingerprint of the standard manual when the copy was last saved, to tell when the standard one changes. */
  helpGuideBase: text("help_guide_base"),
  /** Review program: when performance reviews are due, and reminders (see shared/reviewProgram). */
  reviewProgram: jsonb("review_program").$type<ReviewProgram>(),
  /** Maintenance reminder defaults (how far ahead, repeat while overdue). */
  fleetSettings: jsonb("fleet_settings").$type<FleetSettings>(),
  /** Who gets paid holidays and what working one pays (see HolidayRules in @crewdesk/shared). */
  holidayRules: jsonb("holiday_rules").$type<HolidayRules>(),
  /** Measure page: admins' own aerial photo sources, and when each automatically found photo appeared. */
  measureImagery: jsonb("measure_imagery").$type<MeasureImagerySettings>(),
  /** Access by area for each role (Settings → Layout Editor): { manager: { payroll: "admin" }, … }. */
  roleAccess: jsonb("role_access").$type<RoleAccess>().notNull().default({}),
  /** The business address on one line (printed on tax forms), kept in step with the boxes below. */
  address: text("address"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  /** Company logo in encrypted storage (see lib/storage); shown in the sidebar for everyone. */
  logoKey: text("logo_key"),
  logoUpdatedAt: timestamp("logo_updated_at", { withTimezone: true }),
  /** Contact details shown on Settings → Company info. */
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  /** Collect W-4, I-9 and direct deposit in Crewdesk (off when a payroll provider collects them). */
  taxFormsInCrewdesk: boolean("tax_forms_in_crewdesk").notNull().default(true),
  /** Lowest role that can create wiki pages ("employee" = everyone). */
  wikiCreateMin: text("wiki_create_min").notNull().default("admin"),
  /** Location rule for clocking in / out: optional | required | geofence_flag | geofence_block */
  clockInLocation: text("clock_in_location").notNull().default("optional"),
  clockOutLocation: text("clock_out_location").notNull().default("optional"),
  /** Pay schedule (see payPeriods in @crewdesk/shared); null frequency = not set up. */
  payFrequency: text("pay_frequency"),
  payPeriodAnchor: date("pay_period_anchor"),
  paydayOffsetDays: integer("payday_offset_days").notNull().default(5),
  /** Page layouts from the owner's layout editor (see pageLayoutsUpdateSchema). */
  pageLayouts: jsonb("page_layouts").$type<Record<string, Record<string, string[]>>>().notNull().default({}),
  /** Choices for the Job title and Department menus, set by the owner (in their order). */
  jobTitles: jsonb("job_titles").$type<string[]>().notNull().default([]),
  departments: jsonb("departments").$type<string[]>().notNull().default([]),
  /** Other editable drop-down lists (see STORED_LISTS); a missing key means the default list. */
  menuLists: jsonb("menu_lists").$type<Record<string, string[]>>().notNull().default({}),
  /** New wording for fixed choices: { menu: { value: label } } (see LABEL_MENUS). */
  menuLabels: jsonb("menu_labels").$type<Record<string, Record<string, string>>>().notNull().default({}),
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
    /** Profile photo in encrypted storage (see lib/storage); everyone in the company can see it. */
    photoKey: text("photo_key"),
    photoUpdatedAt: timestamp("photo_updated_at", { withTimezone: true }),
    /** Date of birth, home address and emergency contact: managers and up, and the person themselves, only. */
    dateOfBirth: date("date_of_birth"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    state: text("state"),
    zip: text("zip"),
    emergencyName: text("emergency_name"),
    emergencyRelationship: text("emergency_relationship"),
    emergencyPhone: text("emergency_phone"),
    /** Why someone was made inactive or terminated (managers and up only). Cleared when they're made active again. */
    statusReason: text("status_reason"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    statusChangedById: uuid("status_changed_by_id"),
    payrollProviderEmployeeId: text("payroll_provider_employee_id"),
    /** When the person agreed to receive texts; null means no texts. */
    smsOptInAt: timestamp("sms_opt_in_at", { withTimezone: true }),
    /** Secret for their calendar subscription link (phone app → Subscribe in Calendar); null until made. */
    calendarToken: text("calendar_token").unique(),
    /** When the latest invite email was sent; null if they were never invited. */
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    /** Bumped to sign the person out of every device; sessions carry the version they were issued with. */
    tokenVersion: integer("token_version").notNull().default(0),
    /** In a test company: the real person this sign-in belongs to (reached by switching, never by password). */
    linkedEmployeeId: uuid("linked_employee_id").references((): AnyPgColumn => employees.id, { onDelete: "cascade" }),
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

/** Where someone was while clocked in: the phone app records a point every few minutes. */
export const locationPings = pgTable(
  "location_pings",
  {
    id: id(),
    companyId: companyId(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    timeEntryId: uuid("time_entry_id").notNull().references(() => timeEntries.id, { onDelete: "cascade" }),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    accuracy: doublePrecision("accuracy"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("location_pings_employee_idx").on(t.employeeId, t.recordedAt)],
);

export const ptoPolicies = pgTable("pto_policies", {
  id: id(),
  companyId: companyId(),
  name: text("name").notNull(),
  /** Hours earned per hour worked (0 = none). */
  accrualRate: doublePrecision("accrual_rate").notNull().default(0),
  /** Hours given on each award date (see grantSchedule). */
  annualGrantHours: doublePrecision("annual_grant_hours").notNull().default(0),
  /** none | yearly_date | anniversary | monthly (see ptoAccrual in @crewdesk/shared). */
  grantSchedule: text("grant_schedule").notNull().default("none"),
  grantDate: text("grant_date"),
  grantDayOfMonth: integer("grant_day_of_month"),
  maxBalanceHours: doublePrecision("max_balance_hours"),
  /** Carryover limit: hours above this are removed when the policy year resets (null = no limit). */
  carryoverLimitHours: doublePrecision("carryover_limit_hours"),
  /** yearly_date (on carryoverDate, "MM-DD") | anniversary */
  carryoverReset: text("carryover_reset").notNull().default("yearly_date"),
  carryoverDate: text("carryover_date").notNull().default("01-01"),
  /** When the award / carryover settings last changed; dates before these are never applied retroactively. */
  grantRulesSince: timestamp("grant_rules_since", { withTimezone: true }).notNull().defaultNow(),
  carryoverRulesSince: timestamp("carryover_rules_since", { withTimezone: true }).notNull().defaultNow(),
  /** Higher accrual or awards after N years of service. */
  tiers: jsonb("tiers").$type<PtoTier[]>().notNull().default([]),
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
    /** For total cost of ownership. */
    purchasePriceCents: integer("purchase_price_cents"),
    purchaseDate: date("purchase_date"),
    purchaseOdometer: doublePrecision("purchase_odometer"),
    purchaseHours: doublePrecision("purchase_hours"),
    /** Printed on the asset's QR label. Regenerating it retires old labels. */
    qrCode: text("qr_code").unique().$defaultFn(newAssetCode),
    /** Custom field values (custom_fields), by field id. */
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
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

/** Fuel log: one row per fill-up (gas, diesel, CNG, propane, DEF…). */
export const fuelEntries = pgTable(
  "fuel_entries",
  {
    id: id(),
    companyId: companyId(),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    fuelType: text("fuel_type").notNull(),
    /** Gallons (GGE for CNG). */
    quantity: doublePrecision("quantity").notNull(),
    totalCostCents: integer("total_cost_cents").notNull(),
    odometer: doublePrecision("odometer"),
    hours: doublePrecision("hours"),
    fullTank: boolean("full_tank").notNull().default(true),
    vendor: text("vendor"),
    notes: text("notes"),
    /** Receipt photo or PDF in storage. */
    receiptKey: text("receipt_key"),
    receiptMime: text("receipt_mime"),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("fuel_entries_asset_idx").on(t.assetId, t.date)],
);

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
  /** Who looks after this service: gets its reminders, and repair orders made from it are assigned to them. */
  assignedToId: uuid("assigned_to_id").references(() => employees.id, { onDelete: "set null" }),
  /** Send the "due soon" reminder this far ahead (null = the company default, else 10% of the interval). */
  remindMilesBefore: doublePrecision("remind_miles_before"),
  remindHoursBefore: doublePrecision("remind_hours_before"),
  remindDaysBefore: integer("remind_days_before"),
  /** Notes for whoever does the service: parts, specs, where to take it… */
  notes: text("notes"),
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
  /** Due when the asset's odometer / engine hours reach these (whichever comes first, with the date). */
  dueOdometer: doublePrecision("due_odometer"),
  dueHours: doublePrecision("due_hours"),
  laborHours: doublePrecision("labor_hours"),
  partsCostCents: integer("parts_cost_cents").notNull().default(0),
  laborCostCents: integer("labor_cost_cents").notNull().default(0),
  vendor: text("vendor"),
  resolutionNotes: text("resolution_notes"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** The asset's odometer / engine hours when it was completed (maintenance history). */
  completedOdometer: doublePrecision("completed_odometer"),
  completedHours: doublePrecision("completed_hours"),
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

/**
 * Access levels by area that differ from a person's role (see permissions in @crewdesk/shared).
 * The "permissions" area holds "admin" for people allowed to manage everyone else's access.
 */
export const employeePermissions = pgTable(
  "employee_permissions",
  {
    companyId: companyId(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    area: text("area").notNull(),
    level: text("level").notNull(),
  },
  (t) => [primaryKey({ columns: [t.employeeId, t.area] })],
);

/** Who is asked to approve each pay period once it ends. */
export const payPeriodApprovers = pgTable(
  "pay_period_approvers",
  {
    companyId: companyId(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.employeeId] })],
);

/** A pay period that has ended, created by the scheduler, and its approval. */
export const payPeriods = pgTable(
  "pay_periods",
  {
    id: id(),
    companyId: companyId(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    payday: date("payday").notNull(),
    /** pending | approved */
    status: text("status").notNull().default("pending"),
    approvedById: uuid("approved_by_id").references(() => employees.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalNote: text("approval_note"),
    /** The payroll figures as they were when approved, so later changes (a raise, a corrected rate) don't alter them. */
    approvedLines: jsonb("approved_lines").$type<unknown[]>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("pay_periods_company_start_idx").on(t.companyId, t.periodStart)],
);

/** One-off pay on top of hours (bonus, commission, reimbursement, other), in the pay period its date falls in. */
export const extraPay = pgTable("extra_pay", {
  id: id(),
  companyId: companyId(),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  kind: text("kind").notNull(),
  amountCents: integer("amount_cents").notNull(),
  note: text("note"),
  createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/** Pay rate history: each raise or pay change, from the date it takes effect. employees.payRateCents mirrors today's rate. */
export const payRates = pgTable(
  "pay_rates",
  {
    id: id(),
    companyId: companyId(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    effectiveDate: date("effective_date").notNull(),
    payType: text("pay_type").notNull(),
    payRateCents: integer("pay_rate_cents").notNull(),
    note: text("note"),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("pay_rates_employee_date_idx").on(t.employeeId, t.effectiveDate)],
);

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
/** What was sent to Bigcapital (one per pay period / repair order), so nothing is posted twice. */
export const accountingPostings = pgTable(
  "accounting_postings",
  {
    id: id(),
    companyId: companyId(),
    /** payroll | work_order | invoice | payment | customer */
    kind: text("kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    /** posted | failed | skipped (e.g. a sample customer outside the test company) */
    status: text("status").notNull(),
    /** Bigcapital's id for the journal / expense. */
    externalId: text("external_id"),
    amountCents: integer("amount_cents").notNull().default(0),
    error: text("error"),
    postedById: uuid("posted_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("accounting_postings_source_idx").on(t.companyId, t.kind, t.sourceId)],
);

/** Training courses (see training.ts in @crewdesk/shared). */
export const courses = pgTable("courses", {
  id: id(),
  companyId: companyId(),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category"),
  published: boolean("published").notNull().default(false),
  passingScore: integer("passing_score").notNull().default(80),
  validityMonths: integer("validity_months"),
  dueDays: integer("due_days"),
  /** none | everyone | titles | departments */
  autoAssign: text("auto_assign").notNull().default("none"),
  autoAssignTo: jsonb("auto_assign_to").$type<string[]>().notNull().default([]),
  selfEnroll: boolean("self_enroll").notNull().default(true),
  createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const courseLessons = pgTable(
  "course_lessons",
  {
    id: id(),
    companyId: companyId(),
    courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    chapter: text("chapter"),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    videoUrl: text("video_url"),
    quiz: jsonb("quiz").$type<QuizQuestion[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("course_lessons_course_idx").on(t.courseId, t.position)],
);

/** Someone taking a course. A new one is made each time they're assigned it again (e.g. yearly). */
export const courseEnrollments = pgTable(
  "course_enrollments",
  {
    id: id(),
    companyId: companyId(),
    courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    assignedById: uuid("assigned_by_id").references(() => employees.id, { onDelete: "set null" }),
    /** manager | auto | self */
    source: text("source").notNull().default("manager"),
    dueDate: date("due_date"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Completion lasts until this day (course validity). */
    expiresAt: date("expires_at"),
  },
  (t) => [index("course_enrollments_employee_idx").on(t.employeeId), index("course_enrollments_course_idx").on(t.courseId)],
);

export const lessonProgress = pgTable(
  "lesson_progress",
  {
    id: id(),
    enrollmentId: uuid("enrollment_id").notNull().references(() => courseEnrollments.id, { onDelete: "cascade" }),
    lessonId: uuid("lesson_id").notNull().references(() => courseLessons.id, { onDelete: "cascade" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    quizScore: integer("quiz_score"),
    attempts: integer("attempts").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("lesson_progress_enrollment_lesson_idx").on(t.enrollmentId, t.lessonId)],
);

/** Days an owner/admin set by hand on the attendance calendar (e.g. called in sick, excused). */
export const attendanceOverrides = pgTable(
  "attendance_overrides",
  {
    id: id(),
    companyId: companyId(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    /** on_time | tardy | early_leave | no_show | sick | excused */
    status: text("status").notNull(),
    note: text("note"),
    /** Points for this day instead of the usual amount. */
    points: doublePrecision("points"),
    setById: uuid("set_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("attendance_overrides_employee_date_idx").on(t.employeeId, t.date)],
);

/**
 * Performance reviews and disciplinary actions (Reviews & discipline). Drafts are managers-only;
 * shared ones the employee can see and acknowledge. See reviews.ts in @crewdesk/shared.
 */
export const employeeRecords = pgTable(
  "employee_records",
  {
    id: id(),
    companyId: companyId(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => employees.id, { onDelete: "set null" }),
    /** review | discipline */
    kind: text("kind").notNull(),
    /** Review type (annual, probation…) or disciplinary step (verbal_warning, written_warning…). */
    type: text("type").notNull(),
    date: date("date").notNull(),
    /** Reviews */
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    rating: integer("rating"),
    strengths: text("strengths"),
    improvements: text("improvements"),
    goals: text("goals"),
    /** Discipline */
    reason: text("reason"),
    incidentDate: date("incident_date"),
    expectations: text("expectations"),
    followUpDate: date("follow_up_date"),
    /** Review summary, or what happened. */
    summary: text("summary").notNull(),
    /** draft | shared | acknowledged */
    status: text("status").notNull().default("draft"),
    sharedAt: timestamp("shared_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    employeeComment: text("employee_comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("employee_records_employee_idx").on(t.employeeId)],
);

/** Paid holidays (Time off page). The rule gives each year's date; see holidays.ts in @crewdesk/shared. */
export const holidays = pgTable("holidays", {
  id: id(),
  companyId: companyId(),
  name: text("name").notNull(),
  rule: jsonb("rule").$type<HolidayRule>().notNull(),
  hours: doublePrecision("hours").notNull().default(8),
  /** nearest (weekend → Friday/Monday) | none */
  observe: text("observe").notNull().default("nearest"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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

/** Spray Mix Calculator sheets (e.g. "Truck 2gal/1000ft" at 87.12 gal/acre). See computeMix in @crewdesk/shared. */
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

/** Products: chemicals and fertilizers, each listed once, for budgeting and chemical records. */
export const products = pgTable(
  "products",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    manufacturer: text("manufacturer"),
    productType: text("product_type").notNull().default("other"),
    formulation: text("formulation"),
    activeIngredients: jsonb("active_ingredients").$type<ActiveIngredient[]>().notNull().default([]),
    epaRegNo: text("epa_reg_no"),
    restrictedUse: boolean("restricted_use").notNull().default(false),
    signalWord: text("signal_word").notNull().default("none"),
    reiHours: doublePrecision("rei_hours"),
    targets: text("targets"),
    /** Rates, costs and amounts used are kept in this unit (one of MIX_UNITS). */
    useUnit: text("use_unit").notNull(),
    purchaseUnitName: text("purchase_unit_name"),
    /** How many use units one purchase unit holds. */
    purchaseUnitSize: doublePrecision("purchase_unit_size"),
    labelMaxPer1000: doublePrecision("label_max_per_1000"),
    labelMaxPerYearPer1000: doublePrecision("label_max_per_year_per_1000"),
    labelInstructions: text("label_instructions"),
    customerNote: text("customer_note"),
    incomeAccountCode: text("income_account_code"),
    cogsAccountCode: text("cogs_account_code"),
    taxable: boolean("taxable").notNull().default(false),
    trackRecords: boolean("track_records").notNull().default(true),
    /** When the label requires a specific adjuvant or drift agent (ODAFF items 13–14), its name. */
    requiredAdjuvant: text("required_adjuvant"),
    requiredDriftAgent: text("required_drift_agent"),
    active: boolean("active").notNull().default(true),
    updatedById: uuid("updated_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("products_company_idx").on(t.companyId, t.name)],
);

/** Named application rates of a product (Low / Med / High, Round 1 …), per 1,000 sq ft in its use unit. */
export const productRates = pgTable(
  "product_rates",
  {
    id: id(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    amountPer1000: doublePrecision("amount_per_1000").notNull(),
    method: text("method").notNull().default("truck_spray"),
    carrierGalPer1000: doublePrecision("carrier_gal_per_1000"),
    /** The application method this rate is for (Chemical Tracking); its spray volume is the carrier. */
    applicationMethodId: uuid("application_method_id").references(() => applicationMethods.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("product_rates_product_idx").on(t.productId)],
);

/** What a product costs, from a date on; the latest on or before a day is the cost that day. */
export const productCosts = pgTable(
  "product_costs",
  {
    id: id(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    costPerPurchaseUnitCents: integer("cost_per_purchase_unit_cents").notNull(),
    vendor: text("vendor"),
    effectiveFrom: date("effective_from").notNull(),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("product_costs_product_idx").on(t.productId, t.effectiveFrom)],
);

/** Products a service applies, at one of their rates; budgets material and, on completion, what a visit used. */
export const serviceProducts = pgTable(
  "service_products",
  {
    id: id(),
    serviceTypeId: uuid("service_type_id").notNull().references(() => serviceTypes.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    productRateId: uuid("product_rate_id").notNull().references(() => productRates.id, { onDelete: "restrict" }),
    startDate: date("start_date"),
    endDate: date("end_date"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("service_products_service_idx").on(t.serviceTypeId), index("service_products_rate_idx").on(t.productRateId)],
);

/**
 * What a completed visit applied, with its cost saved at completion so reports never change when a
 * price does: the amount, the cost per use unit in force on the visit's day, and which cost that was.
 */
export const visitProducts = pgTable(
  "visit_products",
  {
    id: id(),
    companyId: companyId(),
    visitId: uuid("visit_id").notNull().references(() => visits.id, { onDelete: "cascade" }),
    serviceTypeId: uuid("service_type_id").references(() => serviceTypes.id, { onDelete: "set null" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    productRateId: uuid("product_rate_id").references(() => productRates.id, { onDelete: "set null" }),
    productCostId: uuid("product_cost_id").references(() => productCosts.id, { onDelete: "restrict" }),
    /** As they were at completion. */
    productName: text("product_name").notNull(),
    epaRegNo: text("epa_reg_no"),
    rateName: text("rate_name"),
    amountPer1000: doublePrecision("amount_per_1000").notNull(),
    areaSqFt: doublePrecision("area_sq_ft").notNull(),
    amount: doublePrecision("amount").notNull(),
    unit: text("unit").notNull(),
    /** Null when the product had no cost on that day. */
    costPerUseUnitCents: doublePrecision("cost_per_use_unit_cents"),
    costCents: integer("cost_cents"),
    costDate: date("cost_date").notNull(),
    /** How it was applied: one of Chemical Tracking's application methods (its spray volume, or dry). */
    applicationMethodId: uuid("application_method_id").references(() => applicationMethods.id, { onDelete: "set null" }),
    methodName: text("method_name"),
    carrierGalPer1000: doublePrecision("carrier_gal_per_1000"),
    /** The mix it was applied as part of (Chemical Tracking → Mixes), if any. */
    mixName: text("mix_name"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("visit_products_visit_idx").on(t.visitId), index("visit_products_company_product_idx").on(t.companyId, t.productId), index("visit_products_cost_idx").on(t.productCostId)],
);

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

/** Property measurements from the Measure page: turf areas, cut-outs and lines traced on aerial photos. */
export const measurements = pgTable(
  "measurements",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    address: text("address"),
    notes: text("notes"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    zoom: integer("zoom").notNull(),
    /** Which photo the shapes were traced on, e.g. "Oklahoma 2025 leaf-off (Feb–Mar 2025)". */
    imagery: text("imagery"),
    /** The pin on the house. */
    pinLat: doublePrecision("pin_lat"),
    pinLng: doublePrecision("pin_lng"),
    shapes: jsonb("shapes").$type<MeasureShape[]>().notNull(),
    /** Areas minus cut-outs, in square feet (kept for the list and sorting). */
    netSqFt: doublePrecision("net_sq_ft").notNull().default(0),
    /** Front- and back-yard areas minus cut-outs, in square feet (null until worked out for older rows). */
    frontSqFt: doublePrecision("front_sq_ft"),
    backSqFt: doublePrecision("back_sq_ft"),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedById: uuid("updated_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("measurements_company_idx").on(t.companyId, t.updatedAt)],
);

/**
 * Oklahoma 911 address points (OKMaps) for the counties companies work in, kept locally so address search is
 * instant; refreshed about monthly. Public data, shared by all companies. `key` is addressKey() in @crewdesk/shared.
 */
export const addressPoints = pgTable(
  "address_points",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    county: text("county").notNull(),
    key: text("key").notNull(),
    fullAddress: text("full_address").notNull(),
    city: text("city"),
    zip: text("zip"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
  },
  (t) => [index("address_points_key_idx").on(t.key.op("text_pattern_ops")), index("address_points_county_idx").on(t.county)],
);

/** When each county's address points were last downloaded. */
export const addressCounties = pgTable("address_counties", {
  county: text("county").primaryKey(),
  count: integer("count").notNull().default(0),
  loadedAt: timestamp("loaded_at", { withTimezone: true }),
  /** "loading" while downloading; the last error if it failed. */
  status: text("status"),
  error: text("error"),
});

/* ───────────── Customers and properties (customer system, Phase 1) ───────────── */

/** Tags for customers and properties: a managed list, so the same thing isn't tagged three ways. */
export const crmTags = pgTable(
  "crm_tags",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    color: text("color").notNull().default("gray"),
    description: text("description"),
    archived: boolean("archived").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("crm_tags_company_name_idx").on(t.companyId, sql`lower(${t.name})`)],
);

/** The cancellation drop-down: admins add, rename, reorder and retire reasons. */
export const cancellationReasons = pgTable(
  "cancellation_reasons",
  {
    id: id(),
    companyId: companyId(),
    label: text("label").notNull(),
    /** "customer" or "company" (e.g. non-payment). */
    initiatedBy: text("initiated_by").notNull().default("customer"),
    commentRequired: boolean("comment_required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    retired: boolean("retired").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("cancellation_reasons_company_idx").on(t.companyId, t.sortOrder)],
);

export const customers = pgTable(
  "customers",
  {
    id: id(),
    companyId: companyId(),
    /** Customer number, per company (e.g. 1001). */
    number: integer("number").notNull(),
    kind: text("kind").notNull().default("residential"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    companyName: text("company_name"),
    email: text("email"),
    phone: text("phone"),
    altPhone: text("alt_phone"),
    /** They replied STOP: no texts until they reply START. */
    textOptOutAt: timestamp("text_opt_out_at", { withTimezone: true }),
    billingStreet: text("billing_street"),
    billingCity: text("billing_city"),
    billingState: text("billing_state").notNull().default("OK"),
    billingZip: text("billing_zip"),
    /** Any of "email", "paper", "text". */
    delivery: text("delivery").array().notNull().default(sql`ARRAY['email']::text[]`),
    source: text("source"),
    poRequired: boolean("po_required").notNull().default(false),
    /** Sales tax: exempt customers pay none (with their exemption certificate number); or their own rate. */
    taxExempt: boolean("tax_exempt").notNull().default(false),
    taxExemptNumber: text("tax_exempt_number"),
    taxRate: doublePrecision("tax_rate"),
    notes: text("notes"),
    /** "lead", "active" or "cancelled". */
    status: text("status").notNull().default("active"),
    tagIds: uuid("tag_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    /** Made by the sample-customer button, so they can be removed in one go. */
    sample: boolean("sample").notNull().default(false),
    stripeCustomerId: text("stripe_customer_id"),
    bigcapitalCustomerId: integer("bigcapital_customer_id"),
    /** When they used the unsubscribe link in an email sent to many customers (invoices and receipts still go). */
    emailOptOutAt: timestamp("email_opt_out_at", { withTimezone: true }),
    /** Before a visit: "none", "text" (text ahead) or "call" (call ahead). */
    notifyBefore: text("notify_before").notNull().default("none"),
    /** Card on file not required for any of their properties: why, who, when. */
    cardExemptReason: text("card_exempt_reason"),
    cardExemptById: uuid("card_exempt_by_id"),
    cardExemptAt: timestamp("card_exempt_at", { withTimezone: true }),
    /** Charge their default card or bank account on file when an invoice is sent. */
    autopay: boolean("autopay").notNull().default(false),
    /** Mr., Mrs., Dr. ... (shown with their name on letters). */
    title: text("title"),
    county: text("county"),
    /** Defaults for their new invoices and estimates (like Homeworks' Discount % and Defaults box). */
    discountPercent: doublePrecision("discount_percent").notNull().default(0),
    invoiceNotes: text("invoice_notes"),
    /** Days to pay (blank: the company's usual terms). */
    termsDays: integer("terms_days"),
    /** Late fees: "default" (the company's), "none", or "custom" (lateFeeRules). */
    lateFeeMode: text("late_fee_mode").notNull().default("default"),
    lateFeeRules: jsonb("late_fee_rules").$type<LateFeeRule[]>(),
    /** Auto-sending invoices: "default" (the company's), "off", or "custom" (autoSendSchedule). */
    autoSendMode: text("auto_send_mode").notNull().default("default"),
    autoSendSchedule: jsonb("auto_send_schedule").$type<SendSchedule>(),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Custom field values (custom_fields), by field id. */
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("customers_company_number_idx").on(t.companyId, t.number),
    index("customers_company_status_idx").on(t.companyId, t.status),
    index("customers_tags_idx").using("gin", t.tagIds),
  ],
);

/** Extra people on an account (spouse, property manager, accounts payable), and who gets invoices. */
export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: id(),
    companyId: companyId(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    relation: text("relation"),
    email: text("email"),
    phone: text("phone"),
    getsInvoices: boolean("gets_invoices").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("customer_contacts_customer_idx").on(t.customerId)],
);

export const properties = pgTable(
  "properties",
  {
    id: id(),
    companyId: companyId(),
    name: text("name"),
    street: text("street").notNull(),
    city: text("city"),
    state: text("state").notNull().default("OK"),
    zip: text("zip"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    /** Map Code (MC); set from the pin once MC outlines exist, or by hand. */
    mapCode: text("map_code"),
    mapCodeManual: boolean("map_code_manual").notNull().default(false),
    lawnSqFt: doublePrecision("lawn_sq_ft"),
    frontSqFt: doublePrecision("front_sq_ft"),
    backSqFt: doublePrecision("back_sq_ft"),
    /** The saved Property Measure the lawn size came from. */
    measurementId: uuid("measurement_id").references(() => measurements.id, { onDelete: "set null" }),
    gateCode: text("gate_code"),
    /** Sales tax rate where the property is (null: the customer's, else the company default). */
    taxRate: doublePrecision("tax_rate"),
    pets: text("pets"),
    /** "Always assign to …" (the crew or truck). */
    preferredCrewId: uuid("preferred_crew_id"),
    /** Overrides the customer's: "none", "text" or "call". */
    notifyBefore: text("notify_before"),
    /** After a chemical application: "email", "text", "printed" or "none" (Chemical Tracking notices). */
    chemicalNotice: text("chemical_notice").notNull().default("email"),
    /** Card on file not required for this property: why, who, when. */
    cardExemptReason: text("card_exempt_reason"),
    cardExemptById: uuid("card_exempt_by_id"),
    cardExemptAt: timestamp("card_exempt_at", { withTimezone: true }),
    accessNotes: text("access_notes"),
    notes: text("notes"),
    /** "active" or "cancelled". */
    status: text("status").notNull().default("active"),
    tagIds: uuid("tag_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    sample: boolean("sample").notNull().default(false),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Custom field values (custom_fields), by field id. */
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("properties_company_status_idx").on(t.companyId, t.status),
    index("properties_company_map_code_idx").on(t.companyId, t.mapCode),
    index("properties_tags_idx").using("gin", t.tagIds),
  ],
);

/**
 * Which customers are on a property and as what: one current bill-to (who's invoiced) and any
 * residents. Ended assignments stay as history; a property's past invoices stay with the old customer.
 */
export const propertyAssignments = pgTable(
  "property_assignments",
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    /** "bill_to" or "resident". */
    role: text("role").notNull(),
    startDate: date("start_date").notNull(),
    /** The last day; null while current. */
    endDate: date("end_date"),
    createdAt: createdAt(),
  },
  (t) => [
    index("property_assignments_property_idx").on(t.propertyId),
    index("property_assignments_customer_idx").on(t.customerId),
    uniqueIndex("property_assignments_one_bill_to_idx").on(t.propertyId).where(sql`${t.role} = 'bill_to' and ${t.endDate} is null`),
  ],
);

/** Each cancellation (and any reactivation) of a customer or property, for reports and win-back lists. */
export const cancellations = pgTable(
  "cancellations",
  {
    id: id(),
    companyId: companyId(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    reasonId: uuid("reason_id").references(() => cancellationReasons.id, { onDelete: "set null" }),
    /** The reason's wording at the time, in case it's renamed later. */
    reasonLabel: text("reason_label").notNull(),
    effectiveDate: date("effective_date").notNull(),
    comment: text("comment"),
    byId: uuid("by_id").references(() => employees.id, { onDelete: "set null" }),
    reactivatedAt: timestamp("reactivated_at", { withTimezone: true }),
    reactivatedById: uuid("reactivated_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("cancellations_company_idx").on(t.companyId, t.effectiveDate)],
);

/**
 * A card or bank account a customer saved with Stripe for later payments (the details stay at
 * Stripe; this keeps Stripe's id and what to show, e.g. "Visa ·· 4242, expires 04/28").
 */
export const customerPaymentMethods = pgTable(
  "customer_payment_methods",
  {
    id: id(),
    companyId: companyId(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    stripePaymentMethodId: text("stripe_payment_method_id").notNull(),
    /** "card" or "ach". */
    type: text("type").notNull(),
    brand: text("brand"),
    last4: text("last4"),
    expMonth: integer("exp_month"),
    expYear: integer("exp_year"),
    bankName: text("bank_name"),
    accountType: text("account_type"),
    isDefault: boolean("is_default").notNull().default(false),
    /** "customer" (portal) or "office". */
    addedBy: text("added_by").notNull().default("customer"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("customer_payment_methods_stripe_idx").on(t.stripePaymentMethodId),
    index("customer_payment_methods_customer_idx").on(t.customerId),
  ],
);

/** Each late fee step added to an invoice (once per step), and whether the office waived it. */
export const invoiceLateFees = pgTable(
  "invoice_late_fees",
  {
    id: id(),
    companyId: companyId(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    days: integer("days").notNull(),
    amountCents: integer("amount_cents").notNull(),
    lineId: uuid("line_id").references(() => invoiceLines.id, { onDelete: "set null" }),
    waivedAt: timestamp("waived_at", { withTimezone: true }),
    waivedById: uuid("waived_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invoice_late_fees_step_idx").on(t.invoiceId, t.days)],
);

/** Notes on a customer (like Homeworks' Call Notes): a call or a note, who wrote it, who was told, and any follow-up to-do. */
export const customerNotes = pgTable(
  "customer_notes",
  {
    id: id(),
    companyId: companyId(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    /** "call" or "note". */
    kind: text("kind").notNull().default("call"),
    body: text("body").notNull(),
    notifiedIds: uuid("notified_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    todoId: uuid("todo_id").references(() => todos.id, { onDelete: "set null" }),
    byId: uuid("by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("customer_notes_customer_idx").on(t.customerId, t.createdAt)],
);

/** Photos and documents on a customer (like Homeworks' Photos / Documents). */
export const customerFiles = pgTable(
  "customer_files",
  {
    id: id(),
    companyId: companyId(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    caption: text("caption"),
    uploadedById: uuid("uploaded_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("customer_files_customer_idx").on(t.customerId)],
);

/** An estimate (quote) for a customer, like Homeworks': numbered from 1000, sent with a link to accept online. */
export const estimates = pgTable(
  "estimates",
  {
    id: id(),
    companyId: companyId(),
    number: integer("number").notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    title: text("title"),
    /** draft, sent (pending), accepted, declined, changes (changes requested). */
    status: text("status").notNull().default("draft"),
    issueDate: date("issue_date").notNull(),
    validUntil: date("valid_until"),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    poNumber: text("po_number"),
    discountPercent: doublePrecision("discount_percent").notNull().default(0),
    /** With the lines that count (optional ones ticked, or the customer's choice once answered). */
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    terms: text("terms"),
    customerNotes: text("customer_notes"),
    internalNotes: text("internal_notes"),
    /** The link the customer opens to see and answer it. */
    token: text("token"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    emailedTo: text("emailed_to"),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    /** The name typed to accept, and any comment (why declined, what to change). */
    responseName: text("response_name"),
    responseComment: text("response_comment"),
    /** "customer" (online) or "office" (taken by phone, recorded by respondedById). */
    respondedBy: text("responded_by"),
    respondedById: uuid("responded_by_id").references(() => employees.id, { onDelete: "set null" }),
    /** The optional lines the customer chose. */
    chosenLineIds: uuid("chosen_line_ids").array(),
    visitId: uuid("visit_id").references(() => visits.id, { onDelete: "set null" }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    /** Deposit to accept: "default" (the company's rule), "none", or "custom" (depositKind/depositValue: cents or %). */
    depositMode: text("deposit_mode").notNull().default("default"),
    depositKind: text("deposit_kind"),
    depositValue: doublePrecision("deposit_value"),
    /** What the customer chose while paying the deposit; it's accepted with this once the deposit is paid. */
    pendingResponse: jsonb("pending_response").$type<{ selectedLineIds: string[]; name: string; comment: string | null }>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("estimates_company_number_idx").on(t.companyId, t.number),
    uniqueIndex("estimates_token_idx").on(t.token),
    index("estimates_customer_idx").on(t.customerId),
    index("estimates_company_status_idx").on(t.companyId, t.status),
  ],
);

export const estimateLines = pgTable(
  "estimate_lines",
  {
    id: id(),
    estimateId: uuid("estimate_id").notNull().references(() => estimates.id, { onDelete: "cascade" }),
    serviceTypeId: uuid("service_type_id").references(() => serviceTypes.id, { onDelete: "set null" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    quantity: doublePrecision("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    visits: integer("visits").notNull().default(1),
    taxRate: doublePrecision("tax_rate").notNull().default(0),
    incomeAccountCode: text("income_account_code").notNull().default("4000"),
    costCents: integer("cost_cents"),
    /** "Our cost" comes from the service's products (kept up to date while the estimate is open); false once typed in. */
    costAuto: boolean("cost_auto").notNull().default(false),
    budgetedHours: doublePrecision("budgeted_hours"),
    optional: boolean("optional").notNull().default(false),
    selected: boolean("selected").notNull().default(true),
    recommended: boolean("recommended").notNull().default(false),
    amountCents: integer("amount_cents").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("estimate_lines_estimate_idx").on(t.estimateId)],
);

/** An email sent to many customers at once (the Customers list's Send menu). */
export const customerMessages = pgTable(
  "customer_messages",
  {
    id: id(),
    companyId: companyId(),
    channel: text("channel").notNull().default("email"),
    subject: text("subject").notNull(),
    /** With fill-in fields like {first_name}, filled in for each customer when sent. */
    body: text("body").notNull(),
    /** "sending", "sent" or "stopped". */
    status: text("status").notNull().default("sending"),
    /** Who it went to, in words (e.g. "Customers · Balance owed more than $0"). */
    audience: text("audience"),
    byId: uuid("by_id").references(() => employees.id, { onDelete: "set null" }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("customer_messages_company_idx").on(t.companyId, t.createdAt)],
);

/** One customer on a customer message: queued, sent, failed, or skipped (and why). */
export const customerMessageRecipients = pgTable(
  "customer_message_recipients",
  {
    id: id(),
    companyId: companyId(),
    messageId: uuid("message_id").notNull().references(() => customerMessages.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** The customer's name and address when it was sent. */
    name: text("name").notNull(),
    email: text("email"),
    /** "queued", "sending", "sent", "failed" or "skipped". */
    status: text("status").notNull().default("queued"),
    skipReason: text("skip_reason"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("customer_message_recipients_message_idx").on(t.messageId, t.status),
    index("customer_message_recipients_customer_idx").on(t.customerId),
    index("customer_message_recipients_queue_idx").on(t.status, t.createdAt),
  ],
);

/** Every tag added or removed, by whom and how (hand, bulk, import, sample, automation): the feed for automations. */
export const tagEvents = pgTable(
  "tag_events",
  {
    id: id(),
    companyId: companyId(),
    tagId: uuid("tag_id").notNull().references(() => crmTags.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    source: text("source").notNull().default("hand"),
    byId: uuid("by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("tag_events_company_idx").on(t.companyId, t.createdAt)],
);

/* ───────────── Billing: price list, invoices, payments (customer system, Phase 1) ───────────── */

/** The services price list: flat, per 1,000 sq ft (with a minimum) or by lawn-size bracket. */
export const serviceTypes = pgTable(
  "service_types",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    description: text("description"),
    /** "flat", "per_thousand" or "bracket". */
    pricing: text("pricing").notNull().default("flat"),
    priceCents: integer("price_cents").notNull().default(0),
    minimumCents: integer("minimum_cents").notNull().default(0),
    brackets: jsonb("brackets").$type<Bracket[]>().notNull().default([]),
    /** "tiered": volume-discount tiers after the minimum (the minimum covers lawns up to the first tier). */
    tiers: jsonb("tiers").$type<Tier[]>().notNull().default([]),
    /** "tiered": price in size bands of this many sq ft (null = exact price for every square foot). */
    bandSizeSqFt: integer("band_size_sq_ft"),
    /** "tiered": price each band at its start (0), middle (0.5) or end (1). */
    bandPricePoint: doublePrecision("band_price_point").notNull().default(0.5),
    /** "tiered": round to this many cents (50 = nearest $0.50). */
    roundToCents: integer("round_to_cents").notNull().default(50),
    /** "tiered": bigger lawns need a price typed in. */
    maxAutoSqFt: integer("max_auto_sq_ft"),
    /** Profit check: target revenue per man-hour, in cents. */
    targetCentsPerHour: integer("target_cents_per_hour"),
    /** The income account's code in the books (4000, 4100, 4200…), so it works in real and test books alike. */
    incomeAccountCode: text("income_account_code").notNull().default("4000"),
    /** Time estimate: setup minutes plus minutes per 1,000 sq ft. */
    setupMinutes: integer("setup_minutes"),
    minutesPer1000: doublePrecision("minutes_per_1000"),
    /** Homeworks' "This is Taxable": its lines get the sales tax rate once sales tax is on. */
    taxable: boolean("taxable").notNull().default(false),
    /** A chemical application: work orders with it get the weather recorded when completed. */
    chemical: boolean("chemical").notNull().default(false),
    /** Chemical records: where it's applied (ODAFF item 16), e.g. "Turf – front and back lawn". */
    applicationSite: text("application_site"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("service_types_company_idx").on(t.companyId, t.sortOrder)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    companyId: companyId(),
    /** Given when the invoice is first sent (drafts have none). */
    number: integer("number"),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    /** "draft", "sent", "partial", "paid" or "void". */
    status: text("status").notNull().default("draft"),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    poNumber: text("po_number"),
    notes: text("notes"),
    discountKind: text("discount_kind").notNull().default("none"),
    discountValue: doublePrecision("discount_value").notNull().default(0),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    /** Sales tax: the lines' tax added up (after the discount), rounded once. */
    taxCents: integer("tax_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    paidCents: integer("paid_cents").notNull().default(0),
    /** Customer credit used on it; what's owed is total − paid − credited. */
    creditedCents: integer("credited_cents").notNull().default(0),
    /** Waiting to be printed and mailed. */
    needsMailing: boolean("needs_mailing").notNull().default(false),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    emailedTo: text("emailed_to"),
    /** Autopay tried the card or bank account on file and it didn't go through (why, and when). */
    autopayError: text("autopay_error"),
    /** The late fee rules it got when first sent (later rule changes don't touch it). */
    lateFeeRules: jsonb("late_fee_rules").$type<LateFeeRule[]>(),
    /** The day it was first sent (late fee days count from here). */
    sentOn: date("sent_on"),
    /** Sent by the auto-send schedule rather than by hand. */
    autoSentAt: timestamp("auto_sent_at", { withTimezone: true }),
    autopayFailedAt: timestamp("autopay_failed_at", { withTimezone: true }),
    mailedAt: timestamp("mailed_at", { withTimezone: true }),
    /** For the online pay link (Phase 1 portal). */
    payToken: text("pay_token"),
    /** The pay link stops working after this (30 days from the last send); signing in to the portal still works. */
    payTokenExpiresAt: timestamp("pay_token_expires_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    bigcapitalInvoiceId: text("bigcapital_invoice_id"),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Custom field values (custom_fields), by field id. */
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invoices_company_number_idx").on(t.companyId, t.number),
    index("invoices_company_status_idx").on(t.companyId, t.status),
    index("invoices_customer_idx").on(t.customerId),
    uniqueIndex("invoices_pay_token_idx").on(t.payToken),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: id(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    serviceTypeId: uuid("service_type_id").references(() => serviceTypes.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    quantity: doublePrecision("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull(),
    amountCents: integer("amount_cents").notNull(),
    incomeAccountCode: text("income_account_code").notNull().default("4000"),
    /** Sales tax on the line, in percent (0 = not taxed). */
    taxRate: doublePrecision("tax_rate").notNull().default(0),
    /** A late fee Crewdesk added (not discounted or taxed). */
    isLateFee: boolean("is_late_fee").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("invoice_lines_invoice_idx").on(t.invoiceId)],
);

/** Payments against an invoice: cash and checks recorded by hand now; card and bank through the portal. */
export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: id(),
    companyId: companyId(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull(),
    /** "cash", "check", "card", "ach" or "other". */
    method: text("method").notNull(),
    receivedOn: date("received_on").notNull(),
    reference: text("reference"),
    note: text("note"),
    /** "completed", "pending" (a bank payment clearing), "failed" or "void". */
    status: text("status").notNull().default("completed"),
    /** Stripe PaymentIntent id (pi_…) for card and bank payments. */
    stripePaymentId: text("stripe_payment_id"),
    /** "Visa ·· 4242" or "Arvest checking ·· 6789". */
    methodDetail: text("method_detail"),
    feeCents: integer("fee_cents"),
    /** For "prepaid": the prepayment it came from. */
    prepaymentId: uuid("prepayment_id").references(() => prepayments.id, { onDelete: "restrict" }),
    /** For "prepaid" (booked the earlier way): the Bigcapital journal moving it out of 2400; removed when redone. */
    bigcapitalJournalId: text("bigcapital_journal_id"),
    /** For "prepaid": the Bigcapital credit note (on the prepayment's income account) that closes the invoice, and its application. */
    bigcapitalCreditNoteId: text("bigcapital_credit_note_id"),
    bigcapitalApplicationId: text("bigcapital_application_id"),
    /** Refunded so far (refunds pending or done); what counts toward the invoice is amount − refunded. */
    refundedCents: integer("refunded_cents").notNull().default(0),
    bigcapitalPaymentId: text("bigcapital_payment_id"),
    recordedById: uuid("recorded_by_id").references(() => employees.id, { onDelete: "set null" }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("invoice_payments_invoice_idx").on(t.invoiceId),
    index("invoice_payments_company_idx").on(t.companyId, t.receivedOn),
    uniqueIndex("invoice_payments_stripe_idx").on(t.stripePaymentId),
  ],
);

/** Which Bigcapital record a Crewdesk thing became, where the thing has no column of its own (e.g. price-list items). */
export const bigcapitalLinks = pgTable(
  "bigcapital_links",
  {
    id: id(),
    companyId: companyId(),
    /** "item" (a service type, or "custom" for custom lines). */
    kind: text("kind").notNull(),
    localKey: text("local_key").notNull(),
    externalId: text("external_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bigcapital_links_key_idx").on(t.companyId, t.kind, t.localKey)],
);

/** One-time sign-in codes (and links) for the customer portal. Only hashes are kept. */
/**
 * Money a customer paid ahead (a season, some services, or any amount), with an optional discount.
 * Held in 2400 Customer Prepayments until it pays their invoices; each invoice it pays gets its share
 * of the discount (as a credit). What's left can stay for later invoices or be refunded.
 */
export const prepayments = pgTable(
  "prepayments",
  {
    id: id(),
    companyId: companyId(),
    /** PP-1, PP-2… per company. */
    number: integer("number").notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    /** What it covers, as the customer sees it. */
    description: text("description").notNull(),
    lines: jsonb("lines").$type<{ serviceTypeId?: string | null; description: string; quantity: number; unitPriceCents: number }[]>().notNull().default([]),
    /** Value of what it covers; amount (what the customer pays) + discount. */
    coversCents: integer("covers_cents").notNull(),
    /** Where the money counts as income when received: [{ code: "4000", cents }], adding up to amountCents. */
    income: jsonb("income").$type<{ code: string; cents: number }[]>().notNull().default([]),
    discountCents: integer("discount_cents").notNull().default(0),
    amountCents: integer("amount_cents").notNull(),
    /** "requested" (link sent), "pending" (bank payment clearing), "open" (paid), "closed" (rest refunded) or "void". */
    status: text("status").notNull(),
    /** How it was paid: "cash", "check", "other", "card" or "ach". */
    method: text("method"),
    methodDetail: text("method_detail"),
    reference: text("reference"),
    receivedOn: date("received_on"),
    note: text("note"),
    /** Pay its customer's open invoices too as soon as it's paid. */
    useNow: boolean("use_now").notNull().default(false),
    /** A deposit to accept this estimate (paying it accepts the estimate). */
    estimateId: uuid("estimate_id").references((): AnyPgColumn => estimates.id, { onDelete: "set null" }),
    /** Cash used on invoices, discount given on them, and refunded (kept up to date from what they come from). */
    appliedCents: integer("applied_cents").notNull().default(0),
    appliedDiscountCents: integer("applied_discount_cents").notNull().default(0),
    refundedCents: integer("refunded_cents").notNull().default(0),
    /** The customer cancelled: no more discount, and the discount given was taken back. */
    discountReversed: boolean("discount_reversed").notNull().default(false),
    stripePaymentId: text("stripe_payment_id"),
    feeCents: integer("fee_cents"),
    payToken: text("pay_token"),
    payTokenExpiresAt: timestamp("pay_token_expires_at", { withTimezone: true }),
    bigcapitalReceiptId: text("bigcapital_receipt_id"),
    bigcapitalRefundId: text("bigcapital_refund_id"),
    bigcapitalRefundCents: integer("bigcapital_refund_cents").notNull().default(0),
    /** Its Bigcapital journals book it as income when received (older ones went to 2400 and are redone). */
    bigcapitalAsIncome: boolean("bigcapital_as_income").notNull().default(false),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("prepayments_customer_idx").on(t.customerId),
    uniqueIndex("prepayments_number_idx").on(t.companyId, t.number),
    uniqueIndex("prepayments_stripe_idx").on(t.stripePaymentId),
    uniqueIndex("prepayments_token_idx").on(t.payToken),
  ],
);

/**
 * Credit given to a customer (a missed service, goodwill, a billing correction, a refund written
 * off…). It lowers what they owe once it's used on invoices; what isn't used yet stays on their
 * account. Optionally for one property's invoices only.
 */
export const customerCredits = pgTable(
  "customer_credits",
  {
    id: id(),
    companyId: companyId(),
    /** CR-1, CR-2… per company. */
    number: integer("number").notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    amountCents: integer("amount_cents").notNull(),
    /** How much of it is used on invoices (kept up to date from credit_applications). */
    appliedCents: integer("applied_cents").notNull().default(0),
    reason: text("reason").notNull(),
    /** Shown to the customer. */
    description: text("description").notNull(),
    /** For the office only. */
    note: text("note"),
    issuedOn: date("issued_on").notNull(),
    /** "open" or "void". */
    status: text("status").notNull().default("open"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    /** The refund it writes off, when it came from "write it off" on a refund. */
    refundId: uuid("refund_id").references(() => paymentRefunds.id, { onDelete: "set null" }),
    /** A prepayment's discount on one invoice (only ever used with that prepayment). */
    prepaymentId: uuid("prepayment_id").references(() => prepayments.id, { onDelete: "cascade" }),
    bigcapitalCreditNoteId: text("bigcapital_credit_note_id"),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("customer_credits_customer_idx").on(t.customerId),
    uniqueIndex("customer_credits_number_idx").on(t.companyId, t.number),
  ],
);

/** Credit used on an invoice. Removing it (or voiding the invoice or the credit) puts it back on the account. */
export const creditApplications = pgTable(
  "credit_applications",
  {
    id: id(),
    companyId: companyId(),
    creditId: uuid("credit_id").notNull().references(() => customerCredits.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    appliedOn: date("applied_on").notNull(),
    /** Set when it's taken off the invoice; the row stays until Bigcapital has caught up. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    bigcapitalApplicationId: text("bigcapital_application_id"),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("credit_applications_credit_idx").on(t.creditId), index("credit_applications_invoice_idx").on(t.invoiceId)],
);

/** Refunds of card and bank payments, made in Crewdesk or in Stripe's dashboard (kept in step with Stripe). */
export const paymentRefunds = pgTable(
  "payment_refunds",
  {
    id: id(),
    companyId: companyId(),
    paymentId: uuid("payment_id").notNull().references(() => invoicePayments.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    /** Stripe refund id (re_…). */
    stripeRefundId: text("stripe_refund_id"),
    amountCents: integer("amount_cents").notNull(),
    /** Stripe's status: "pending", "requires_action", "succeeded", "failed" or "canceled". */
    status: text("status").notNull(),
    /** "requested_by_customer", "duplicate", "fraudulent" or another reason Stripe gives. */
    reason: text("reason"),
    note: text("note"),
    refundedOn: date("refunded_on").notNull(),
    /** Who refunded it in Crewdesk (empty when it was done in Stripe). */
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    /** When the customer was emailed about it. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("payment_refunds_payment_idx").on(t.paymentId), uniqueIndex("payment_refunds_stripe_idx").on(t.stripeRefundId)],
);

export const portalCodes = pgTable(
  "portal_codes",
  {
    id: id(),
    companyId: companyId(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    linkHash: text("link_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("portal_codes_email_idx").on(t.companyId, t.email), uniqueIndex("portal_codes_link_idx").on(t.linkHash)],
);

/**
 * Custom fields (like Homeworks'): the company's own fields on customers, properties, work orders,
 * to-dos, invoices or equipment. Values live on each record (its "custom" column), by field id.
 */
export const customFields = pgTable(
  "custom_fields",
  {
    id: id(),
    companyId: companyId(),
    /** customer | property | workorder | todo | invoice | asset */
    appliesTo: text("applies_to").notNull(),
    name: text("name").notNull(),
    /** text | checkbox | date | decimal | integer | select */
    type: text("type").notNull(),
    /** The choices of a dropdown. */
    options: text("options").array().notNull().default(sql`'{}'::text[]`),
    defaultValue: text("default_value"),
    /** Copies the value from the same-named field on the record it's made for. */
    transferable: boolean("transferable").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("custom_fields_company_idx").on(t.companyId, t.appliesTo)],
);

/** To-do categories (Homeworks' "To-do Category", with "Add New Category"). */
export const todoCategories = pgTable(
  "todo_categories",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("todo_categories_company_name_idx").on(t.companyId, t.name)],
);

/** Off-seasons (Homeworks' "Available Seasons"): a named stretch of the year that repeating series pause in. */
export const offSeasons = pgTable(
  "off_seasons",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    /** "MM-DD"; a start after the end runs over New Year. */
    startMd: text("start_md").notNull(),
    endMd: text("end_md").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("off_seasons_company_name_idx").on(t.companyId, t.name)],
);

/**
 * A repeating to-do series: its rule and how far ahead its to-dos have been made. Its id is the
 * to-dos' seriesId. Series ending on a date or never are made a year ahead and topped up by the
 * scheduler (lib/jobs); shiftDays is how far "this and later" edits moved the dates.
 */
export const todoSeries = pgTable(
  "todo_series",
  {
    id: uuid("id").primaryKey(),
    companyId: companyId(),
    rule: jsonb("rule").$type<TodoRule>().notNull(),
    startDate: date("start_date").notNull(),
    shiftDays: integer("shift_days").notNull().default(0),
    offSeasonId: uuid("off_season_id").references(() => offSeasons.id, { onDelete: "set null" }),
    /** The rule's dates are made through this day (before any shift). */
    generatedThrough: date("generated_through").notNull(),
    /** "Delete this and later" (or nothing left to copy) stops it: nothing more is made. */
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    label: text("label").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("todo_series_company_idx").on(t.companyId)],
);

/**
 * To-dos (like Homeworks'): one-off or repeating jobs for the office or the crew. Each is for a day
 * (or several), optionally at a time, optionally tied to a customer and property or a free-text
 * location, with a category, budgeted hours, a crew and people (todo_assignees), and tracked work
 * time. A repeat makes one row per date, sharing a seriesId (todo_series).
 */
export const todos = pgTable(
  "todos",
  {
    id: id(),
    companyId: companyId(),
    title: text("title").notNull(),
    notes: text("notes"),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    location: text("location"),
    color: text("color").notNull().default("#2563eb"),
    date: date("date").notNull(),
    /** The last day of a multi-day to-do (inclusive). */
    endDate: date("end_date"),
    /** "HH:MM" in the company's time zone. */
    startTime: text("start_time"),
    endTime: text("end_time"),
    budgetedHours: doublePrecision("budgeted_hours"),
    categoryId: uuid("category_id").references(() => todoCategories.id, { onDelete: "set null" }),
    crewId: uuid("crew_id").references(() => crews.id, { onDelete: "set null" }),
    seriesId: uuid("series_id"),
    /** How the series repeats ("none" for a single to-do; the rule's frequency for newer series). */
    repeat: text("repeat").notNull().default("none"),
    /** Work tracking: a running timer's start, and the time already tracked. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    trackedSeconds: integer("tracked_seconds").notNull().default(0),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneById: uuid("done_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Custom field values (custom_fields), by field id. */
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("todos_company_date_idx").on(t.companyId, t.date),
    index("todos_series_idx").on(t.seriesId),
    index("todos_customer_idx").on(t.customerId),
    index("todos_property_idx").on(t.propertyId),
  ],
);

export const todoAssignees = pgTable(
  "todo_assignees",
  {
    todoId: uuid("todo_id").notNull().references(() => todos.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.todoId, t.employeeId] }), index("todo_assignees_employee_idx").on(t.employeeId)],
);

/** Notes for the dispatcher on a to-do (Homeworks' "Notes for the Dispatcher"), newest last. */
export const todoNotes = pgTable(
  "todo_notes",
  {
    id: id(),
    companyId: companyId(),
    todoId: uuid("todo_id").notNull().references(() => todos.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorId: uuid("author_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("todo_notes_todo_idx").on(t.todoId)],
);

/** Photos and documents on a to-do; the bytes are in encrypted file storage (lib/storage). */
export const todoFiles = pgTable(
  "todo_files",
  {
    id: id(),
    companyId: companyId(),
    todoId: uuid("todo_id").notNull().references(() => todos.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    caption: text("caption"),
    uploadedById: uuid("uploaded_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("todo_files_todo_idx").on(t.todoId)],
);

/**
 * Work orders (Homeworks calls them visits): a scheduled job at a customer's property. Stored as
 * "visits" because repair orders already use work_orders. No date = on the waitlist. A repeating
 * series makes one row per date up front, sharing a seriesId.
 */
export const visits = pgTable(
  "visits",
  {
    id: id(),
    companyId: companyId(),
    /** WO-1001, WO-1002… per company. */
    number: integer("number").notNull(),
    title: text("title").notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    color: text("color").notNull().default("#2563eb"),
    location: text("location"),
    /** "invoice" or "none". */
    billing: text("billing").notNull().default("invoice"),
    date: date("date"),
    endDate: date("end_date"),
    startTime: text("start_time"),
    endTime: text("end_time"),
    budgetedHours: doublePrecision("budgeted_hours"),
    totalCents: integer("total_cents").notNull().default(0),
    /** open | on_site | completed | skipped */
    status: text("status").notNull().default("open"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Where the phone was when it was marked completed (when location was allowed). */
    completedLat: doublePrecision("completed_lat"),
    completedLng: doublePrecision("completed_lng"),
    completedAccuracy: doublePrecision("completed_accuracy"),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    finishedById: uuid("finished_by_id").references(() => employees.id, { onDelete: "set null" }),
    skipReason: text("skip_reason"),
    /** For the crew. */
    notes: text("notes"),
    /** What the crew wrote when they finished. */
    completionNotes: text("completion_notes"),
    seriesId: uuid("series_id"),
    /** From crm_tags (the company's one tag list). */
    tagIds: uuid("tag_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    /** The crew it went to (its members were copied to visit_assignees). */
    /** Waiting list window: eligible from (release date), due by, minimum days since the property's last service. */
    releaseOn: date("release_on"),
    dueBy: date("due_by"),
    minDaysAfterLast: integer("min_days_after_last"),
    /** Scheduled before it was eligible: why, who and when (the recorded override). */
    earlyReason: text("early_reason"),
    earlyById: uuid("early_by_id").references((): AnyPgColumn => employees.id, { onDelete: "set null" }),
    earlyAt: timestamp("early_at", { withTimezone: true }),
    /** "low", "normal" or "high". */
    priority: text("priority").notNull().default("normal"),
    /** Appointment window (HH:MM), e.g. after 13:00. */
    windowStart: text("window_start"),
    windowEnd: text("window_end"),
    /** On the waiting list since (set again when it's sent back), and why it was sent back. */
    waitingSince: timestamp("waiting_since", { withTimezone: true }),
    backReason: text("back_reason"),
    crewId: uuid("crew_id").references((): AnyPgColumn => crews.id, { onDelete: "set null" }),
    /** "Every 6 weeks (not Dec, Jan, Feb)" for a series. */
    repeatLabel: text("repeat_label"),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Custom field values (custom_fields), by field id. */
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("visits_company_number_idx").on(t.companyId, t.number),
    index("visits_company_date_idx").on(t.companyId, t.date),
    index("visits_customer_idx").on(t.customerId),
    index("visits_property_idx").on(t.propertyId),
    index("visits_series_idx").on(t.seriesId),
    index("visits_invoice_idx").on(t.invoiceId),
  ],
);

export const visitLines = pgTable(
  "visit_lines",
  {
    id: id(),
    visitId: uuid("visit_id").notNull().references(() => visits.id, { onDelete: "cascade" }),
    serviceTypeId: uuid("service_type_id").references(() => serviceTypes.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    quantity: doublePrecision("quantity").notNull().default(1),
    budgetedHours: doublePrecision("budgeted_hours"),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    amountCents: integer("amount_cents").notNull().default(0),
    /** Sales tax on the line, in percent (0 = not taxed). */
    taxRate: doublePrecision("tax_rate").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("visit_lines_visit_idx").on(t.visitId)],
);

export const visitAssignees = pgTable(
  "visit_assignees",
  {
    visitId: uuid("visit_id").notNull().references(() => visits.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.visitId, t.employeeId] }), index("visit_assignees_employee_idx").on(t.employeeId)],
);

/** Crews (like Homeworks'): a named team with a lead, members and the truck they take. */
export const crews = pgTable(
  "crews",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#2563eb"),
    leadId: uuid("lead_id").references(() => employees.id, { onDelete: "set null" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    notes: text("notes"),
    /** Hours a day it can work (for the waiting list's workload strip). */
    dailyHours: doublePrecision("daily_hours").notNull().default(8),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("crews_company_idx").on(t.companyId)],
);

export const crewMembers = pgTable(
  "crew_members",
  {
    crewId: uuid("crew_id").notNull().references(() => crews.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.crewId, t.employeeId] }), index("crew_members_employee_idx").on(t.employeeId)],
);

/** Packages: a saved bundle of line items added to a work order in one go. */
export const packages = pgTable(
  "packages",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("packages_company_idx").on(t.companyId)],
);

export const packageLines = pgTable(
  "package_lines",
  {
    id: id(),
    packageId: uuid("package_id").notNull().references(() => packages.id, { onDelete: "cascade" }),
    serviceTypeId: uuid("service_type_id").references(() => serviceTypes.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    quantity: doublePrecision("quantity").notNull().default(1),
    budgetedHours: doublePrecision("budgeted_hours"),
    /** Null: the service's price for the property's lawn. */
    unitPriceCents: integer("unit_price_cents"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("package_lines_package_idx").on(t.packageId)],
);

/** Photos and documents on a work order; the bytes are in encrypted file storage (lib/storage). */
export const visitFiles = pgTable(
  "visit_files",
  {
    id: id(),
    companyId: companyId(),
    visitId: uuid("visit_id").notNull().references(() => visits.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    caption: text("caption"),
    uploadedById: uuid("uploaded_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("visit_files_visit_idx").on(t.visitId)],
);


/** Texts with customers: sent from the office or automations, and their replies. */
export const customerTexts = pgTable(
  "customer_texts",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Null for a reply from a number that isn't a customer's. */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** "out" or "in". */
    direction: text("direction").notNull(),
    /** The customer's number (+1…). */
    phone: text("phone").notNull(),
    body: text("body").notNull(),
    /** Out: "sending", "sent", "delivered" or "failed". In: "received". */
    status: text("status").notNull(),
    error: text("error"),
    providerId: text("provider_id"),
    /** "office", "automation" or "test". */
    source: text("source").notNull().default("office"),
    sentById: uuid("sent_by_id").references(() => employees.id, { onDelete: "set null" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("customer_texts_customer_idx").on(t.customerId, t.createdAt),
    index("customer_texts_company_idx").on(t.companyId, t.createdAt),
    index("customer_texts_phone_idx").on(t.companyId, t.phone),
    uniqueIndex("customer_texts_provider_idx").on(t.companyId, t.providerId),
  ],
);

/** Email and text templates for automations (with {fill-ins}). */
export const messageTemplates = pgTable(
  "message_templates",
  {
    id: id(),
    companyId: companyId(),
    /** "email" or "text". */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("message_templates_company_idx").on(t.companyId, t.kind)],
);

/** When something happens, run these steps (Automations). */
export const automations = pgTable(
  "automations",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(false),
    /** When it was last turned on: only things that happen after this start it. */
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    trigger: text("trigger").notNull(),
    daysBefore: integer("days_before"),
    tagId: uuid("tag_id").references(() => crmTags.id, { onDelete: "set null" }),
    onlyTagIds: uuid("only_tag_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    exceptTagIds: uuid("except_tag_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    stopWhen: text("stop_when").array().notNull().default(sql`ARRAY[]::text[]`),
    review: boolean("review").notNull().default(false),
    steps: jsonb("steps").$type<AutomationStep[]>().notNull(),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("automations_company_idx").on(t.companyId, t.trigger)],
);

/** One automation running for one customer (and the estimate, invoice or work order it's about). */
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: id(),
    companyId: companyId(),
    automationId: uuid("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    /** "estimate", "invoice", "payment", "visit" or "customer", and its id. */
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    /** One run per automation per thing that started it. */
    dedupeKey: text("dedupe_key").notNull(),
    /** "running", "review" (waiting for approval), "done", "stopped" or "failed". */
    status: text("status").notNull().default("running"),
    stepIndex: integer("step_index").notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }),
    /** What each step did: { step, action, status ("done", "skipped" or "failed"), detail, at }. */
    log: jsonb("log").$type<{ step: number; action: string; status: string; detail: string; at: string }[]>().notNull().default([]),
    stoppedReason: text("stopped_reason"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("automation_runs_dedupe_idx").on(t.automationId, t.dedupeKey),
    index("automation_runs_due_idx").on(t.status, t.nextAt),
    index("automation_runs_customer_idx").on(t.customerId, t.createdAt),
  ],
);

/** Every email the server hands to the mail service: who to, the subject, and whether it went (for Email deliverability). */
export const emailLog = pgTable(
  "email_log",
  {
    id: id(),
    /** Lower-cased recipient. */
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    /** "sent" (the mail service took it) or "failed" (it refused it, with the error). */
    status: text("status").notNull(),
    error: text("error"),
    /** Customer emails (invoices, estimates, templates): whose, to whom, from which template. */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    templateId: uuid("template_id"),
    /** The message as plain text (template emails only; never sign-in codes). */
    body: text("body"),
    /** Opens, from the tracking image in template emails (some mail apps load it on their own). */
    openedAt: timestamp("opened_at", { withTimezone: true }),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    openCount: integer("open_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("email_log_to_idx").on(t.to, t.createdAt), index("email_log_created_idx").on(t.createdAt), index("email_log_company_idx").on(t.companyId, t.createdAt)],
);

/** Saved views of a list (filters, columns, sort): shared with everyone, or one person's. */
export const savedViews = pgTable(
  "saved_views",
  {
    id: id(),
    companyId: companyId(),
    page: text("page").notNull(),
    name: text("name").notNull(),
    /** Null: shared with everyone. */
    ownerId: uuid("owner_id").references(() => employees.id, { onDelete: "cascade" }),
    config: jsonb("config").$type<{ filters: { key: string; value: string }[]; columns: string[]; sort: { key: string; dir: "asc" | "desc" } | null }>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("saved_views_company_page_idx").on(t.companyId, t.page)],
);

/**
 * The weather on a completed chemical application (one per work order): automatic from the
 * National Weather Service, the office's entry for the day, or typed in for this one. `source` is
 * null while automatic is still waiting for the station to report (tries and the last error kept).
 */
export const visitWeather = pgTable(
  "visit_weather",
  {
    visitId: uuid("visit_id").primaryKey().references(() => visits.id, { onDelete: "cascade" }),
    companyId: companyId(),
    /** "auto", "day" or "office"; null until there's a reading. */
    source: text("source"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    windMph: doublePrecision("wind_mph"),
    windDeg: integer("wind_deg"),
    gustMph: doublePrecision("gust_mph"),
    tempF: doublePrecision("temp_f"),
    rainIn: doublePrecision("rain_in"),
    /** The weather station (automatic), e.g. "Norman, Max Westheimer Airport (KOUN)". */
    station: text("station"),
    note: text("note"),
    enteredById: uuid("entered_by_id").references(() => employees.id, { onDelete: "set null" }),
    tries: integer("tries").notNull().default(0),
    lastTryAt: timestamp("last_try_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("visit_weather_company_idx").on(t.companyId, t.source)],
);

/** The office's weather for a day (manual mode, or a fallback): applied to that day's applications. */
export const weatherDays = pgTable(
  "weather_days",
  {
    id: id(),
    companyId: companyId(),
    date: date("date").notNull(),
    windMph: doublePrecision("wind_mph").notNull(),
    windDeg: integer("wind_deg"),
    gustMph: doublePrecision("gust_mph"),
    tempF: doublePrecision("temp_f"),
    rainIn: doublePrecision("rain_in"),
    note: text("note"),
    enteredById: uuid("entered_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("weather_days_company_date_idx").on(t.companyId, t.date)],
);

/** A product's label (PDF or photo), kept by upload date so each record links the label in force that day (ODAFF item 19). */
export const productLabels = pgTable(
  "product_labels",
  {
    id: id(),
    companyId: companyId(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    caption: text("caption"),
    uploadedById: uuid("uploaded_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("product_labels_product_idx").on(t.productId, t.createdAt)],
);

/** An employee's pesticide applicator certification (ODAFF item 4). */
export const applicatorCerts = pgTable("applicator_certs", {
  employeeId: uuid("employee_id").primaryKey().references(() => employees.id, { onDelete: "cascade" }),
  companyId: companyId(),
  certNo: text("cert_no").notNull(),
  expiresOn: date("expires_on").notNull(),
  categories: text("categories"),
  updatedById: uuid("updated_by_id").references(() => employees.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A chemical application record, made when a work order applying tracked products is completed:
 * everything OAC 35:30-17-21(a) asks for, copied as it was that day. Never deleted: a reopened work
 * order voids its record (a new one is made when it's completed again); corrections are logged.
 */
export const applicationRecords = pgTable(
  "application_records",
  {
    id: id(),
    companyId: companyId(),
    /** Kept if the work order is later deleted (records outlive it). */
    visitId: uuid("visit_id").references(() => visits.id, { onDelete: "set null" }),
    visitNumber: integer("visit_number"),
    /** 3: the company. */
    companyName: text("company_name").notNull(),
    companyAddress: text("company_address"),
    companyLicenseNo: text("company_license_no"),
    /** 4: the certified applicator who made it. */
    applicatorId: uuid("applicator_id").references(() => employees.id, { onDelete: "set null" }),
    applicatorName: text("applicator_name").notNull(),
    applicatorCertNo: text("applicator_cert_no"),
    applicatorCertExpires: date("applicator_cert_expires"),
    /** 5: for whom. 6: where (street address). */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull(),
    customerAddress: text("customer_address"),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    siteAddress: text("site_address"),
    /** 7: date. 1: start and stop. */
    appliedOn: date("applied_on").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    /** 16: site. 17: area. 10: tank mix used (gallons; null when nothing was mixed). */
    site: text("site"),
    areaSqFt: doublePrecision("area_sq_ft"),
    tankMixGal: doublePrecision("tank_mix_gal"),
    /** Where the phone was at completion, when location was allowed. */
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    /** What's missing or wrong, for the office to fix (empty = complete). */
    issues: jsonb("issues").$type<string[]>().notNull().default([]),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("application_records_company_date_idx").on(t.companyId, t.appliedOn), index("application_records_visit_idx").on(t.visitId)],
);

/** Each product on a record: 2 amount, 8 rate, 9 dilution, 11 trade name, 12 EPA #, 13–14 adjuvants, 15 target, 18 REI, 19 label. */
export const applicationRecordProducts = pgTable(
  "application_record_products",
  {
    id: id(),
    recordId: uuid("record_id").notNull().references(() => applicationRecords.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    tradeName: text("trade_name").notNull(),
    epaRegNo: text("epa_reg_no"),
    productType: text("product_type"),
    restrictedUse: boolean("restricted_use").notNull().default(false),
    rateName: text("rate_name"),
    ratePer1000: doublePrecision("rate_per_1000").notNull(),
    unit: text("unit").notNull(),
    /** Product per gallon of spray; null for products applied dry. */
    dilutionPerGal: doublePrecision("dilution_per_gal"),
    carrierGalPer1000: doublePrecision("carrier_gal_per_1000"),
    amount: doublePrecision("amount").notNull(),
    targets: text("targets"),
    reiHours: doublePrecision("rei_hours"),
    labelId: uuid("label_id").references(() => productLabels.id, { onDelete: "set null" }),
    /** How it was applied, e.g. "Truck 2gal/1000ft" or "Spreader (not mixed)". */
    methodName: text("method_name"),
    /** The mix it was part of, if any. */
    mixName: text("mix_name"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("application_record_products_record_idx").on(t.recordId)],
);

/** Corrections to a record: who changed what, from what, and why. */
export const applicationRecordChanges = pgTable(
  "application_record_changes",
  {
    id: id(),
    recordId: uuid("record_id").notNull().references(() => applicationRecords.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    reason: text("reason").notNull(),
    /** Order within the record's log (changes saved together share a time). */
    seq: integer("seq").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("application_record_changes_record_idx").on(t.recordId, t.seq)],
);

/**
 * How products are applied (Chemical Tracking): Truck 2 gal / 1,000, Backpack 1 gal / 1,000, a
 * spreader … Kept apart from the Spray Mix Calculator so only Chemical Tracking users change rates.
 */
export const applicationMethods = pgTable(
  "application_methods",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    /** Gallons of spray per 1,000 sq ft; null for products applied dry (not mixed). */
    galPer1000: doublePrecision("gal_per_1000"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    updatedById: uuid("updated_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("application_methods_company_idx").on(t.companyId, t.sortOrder)],
);

/** People an admin lets into Chemical Tracking (admins always can). */
export const chemicalAccess = pgTable("chemical_access", {
  employeeId: uuid("employee_id").primaryKey().references(() => employees.id, { onDelete: "cascade" }),
  companyId: companyId(),
  addedById: uuid("added_by_id").references(() => employees.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/**
 * After-application notices to customers: one per chemical record, sent the way the property
 * chooses (email, text) or queued to print. Kept with what was sent, for the record.
 */
export const chemicalNotices = pgTable(
  "chemical_notices",
  {
    id: id(),
    companyId: companyId(),
    recordId: uuid("record_id").notNull().references(() => applicationRecords.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    /** "email", "text" or "printed". */
    channel: text("channel").notNull(),
    /** "sending", "sent", "failed", "skipped", "to_print" or "printed". */
    status: text("status").notNull(),
    to: text("to"),
    subject: text("subject"),
    body: text("body").notNull(),
    /** Why it failed or was skipped. */
    detail: text("detail"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    sentById: uuid("sent_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("chemical_notices_company_idx").on(t.companyId, t.createdAt), index("chemical_notices_record_idx").on(t.recordId)],
);

/**
 * Mixes (Chemical Tracking): products that go in one tank together, each at its rate, applied one
 * way. A tech adds the whole mix in one tap instead of each product; the record still lists every
 * product (with the mix's name).
 */
export const chemicalMixes = pgTable(
  "chemical_mixes",
  {
    id: id(),
    companyId: companyId(),
    name: text("name").notNull(),
    applicationMethodId: uuid("application_method_id").references(() => applicationMethods.id, { onDelete: "set null" }),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    updatedById: uuid("updated_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("chemical_mixes_company_idx").on(t.companyId, t.sortOrder)],
);

export const chemicalMixItems = pgTable(
  "chemical_mix_items",
  {
    id: id(),
    mixId: uuid("mix_id").notNull().references(() => chemicalMixes.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    /** Per 1,000 sq ft, in the product's unit. */
    ratePer1000: doublePrecision("rate_per_1000").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("chemical_mix_items_mix_idx").on(t.mixId)],
);

/** Mixes a service applies (alongside its single products), with optional dates like products. */
export const serviceMixes = pgTable(
  "service_mixes",
  {
    id: id(),
    serviceTypeId: uuid("service_type_id").notNull().references(() => serviceTypes.id, { onDelete: "cascade" }),
    mixId: uuid("mix_id").notNull().references(() => chemicalMixes.id, { onDelete: "restrict" }),
    startDate: date("start_date"),
    endDate: date("end_date"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("service_mixes_service_idx").on(t.serviceTypeId), index("service_mixes_mix_idx").on(t.mixId)],
);

/**
 * Message templates (Marketing → Templates): emails (formatted) and texts with merge tags like
 * {{CUSTOMER_FIRST_NAME}}. `systemKey` marks Crewdesk's own invoice, estimate and receipt
 * templates: changeable and resettable, not deletable.
 */
export const templates = pgTable(
  "templates",
  {
    id: id(),
    companyId: companyId(),
    /** "email" or "text". */
    channel: text("channel").notNull(),
    /** "customer" or "internal" (to your team). */
    audience: text("audience").notNull().default("customer"),
    name: text("name").notNull(),
    subject: text("subject"),
    /** Email: cleaned HTML. Text: plain text. */
    body: text("body").notNull(),
    systemKey: text("system_key"),
    /** Brought in from another system, e.g. "homeworks:592671" (so importing twice doesn't double up). */
    importedFrom: text("imported_from"),
    createdById: uuid("created_by_id").references(() => employees.id, { onDelete: "set null" }),
    updatedById: uuid("updated_by_id").references(() => employees.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("templates_company_idx").on(t.companyId, t.channel),
    uniqueIndex("templates_company_system_idx").on(t.companyId, t.systemKey),
    uniqueIndex("templates_company_imported_idx").on(t.companyId, t.importedFrom),
  ],
);
