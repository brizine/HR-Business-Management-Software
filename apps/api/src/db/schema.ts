import type { NotificationLink } from "@crewdesk/shared";
import {
  boolean,
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
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const companies = pgTable("companies", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/Chicago"),
  /** "csv" exports timesheets only; "check" pushes to the Check payroll API. */
  payrollProvider: text("payroll_provider").notNull().default("csv"),
  payrollProviderCompanyId: text("payroll_provider_company_id"),
  weeklyOvertimeThreshold: doublePrecision("weekly_overtime_threshold").notNull().default(40),
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
  requiresDocument: boolean;
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
