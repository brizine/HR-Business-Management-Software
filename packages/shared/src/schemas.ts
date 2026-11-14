import { z } from "zod";
import { normalizePhone } from "./phone";
import { DELIVERY_MODES, NOTIFICATION_CATEGORIES } from "./notifications";
import { ONBOARDING_FORM_TYPES } from "./taxForms";
import { ROLES } from "./roles";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const signupSchema = z.object({
  companyName: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contractor", "seasonal"] as const;
export const PAY_TYPES = ["hourly", "salary"] as const;

/** Employee statuses. Inactive and terminated people can't sign in and aren't notified, scheduled or invited. */
export const EMPLOYEE_STATUSES = ["active", "onboarding", "inactive", "terminated"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];
export const INACTIVE_STATUSES: string[] = ["inactive", "terminated"];
/** True for inactive or terminated (no access). */
export const isInactive = (status: string | null | undefined) => INACTIVE_STATUSES.includes(status ?? "");

/** Optional text; an empty box clears it (null). */
const clearable = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === "" ? null : v));
/** A phone number: US numbers are saved as (555) 555-5555. */
const clearablePhone = clearable(40).transform((v) => normalizePhone(v));
const optionalPhone = z.string().trim().max(40).optional().transform((v) => normalizePhone(v));

/** A real birth date: not in the future, after 1900. */
const birthDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date as YYYY-MM-DD")
  .refine((d) => { const t = new Date(`${d}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(d); }, "Enter a real date of birth")
  .refine((d) => d >= "1900-01-01" && d <= new Date().toISOString().slice(0, 10), "Enter a real date of birth");

/** Whole years old on a given day (today by default). */
export function ageOn(dateOfBirth: string, on = new Date()) {
  const [y, m, d] = dateOfBirth.split("-").map(Number);
  const had = on.getMonth() + 1 > m || (on.getMonth() + 1 === m && on.getDate() >= d);
  return on.getFullYear() - y - (had ? 0 : 1);
}

/** Date of birth, home address and emergency contact. Employees can edit their own; managers and up see everyone's. */
export const employeeContactSchema = z.object({
  phone: clearablePhone,
  dateOfBirth: z.union([birthDate, z.literal("")]).nullable().optional().transform((v) => (v === "" ? null : v)),
  addressLine1: clearable(200),
  addressLine2: clearable(200),
  city: clearable(100),
  state: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/, "Use the 2-letter state code").nullable().optional().transform((v) => (v === "" ? null : v)),
  zip: z.string().trim().regex(/^(\d{5}(-\d{4})?)?$/, "Enter a 5-digit ZIP code").nullable().optional().transform((v) => (v === "" ? null : v)),
  emergencyName: clearable(120),
  emergencyRelationship: clearable(60),
  emergencyPhone: clearablePhone,
});
export type EmployeeContact = z.infer<typeof employeeContactSchema>;
/** Fields that only managers and up (and the person themselves) can see. */
export const EMPLOYEE_PRIVATE_CONTACT_FIELDS = ["dateOfBirth", "addressLine1", "addressLine2", "city", "state", "zip", "emergencyName", "emergencyRelationship", "emergencyPhone"] as const;

/** The owner's menus for the employee form's Job title and Department. */
const menuEntry = z.string().trim().min(1).max(80);
export const employeeMenusSchema = z.object({
  jobTitles: z.array(menuEntry).max(200).transform((l) => [...new Set(l)]),
  departments: z.array(menuEntry).max(200).transform((l) => [...new Set(l)]),
});
export type EmployeeMenus = z.infer<typeof employeeMenusSchema>;
export const menuRenameSchema = z.object({ kind: z.enum(["jobTitles", "departments"]), from: menuEntry, to: menuEntry });

/** The details on an employee's page, in order. (The owner rearranges pages with the layout editor.) */
export const PROFILE_FIELDS = [
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "role", label: "Role" },
  { key: "hireDate", label: "Hire date" },
  { key: "pay", label: "Pay" },
  { key: "employment", label: "Employment" },
  { key: "login", label: "App login" },
  { key: "twoFactor", label: "Two-factor" },
  { key: "signIn", label: "Sign-in (locked)" },
  { key: "dateOfBirth", label: "Date of birth" },
  { key: "address", label: "Home address" },
  { key: "emergency", label: "Emergency contact" },
] as const;
export type ProfileFieldKey = (typeof PROFILE_FIELDS)[number]["key"];

/**
 * Owner's page layouts from the layout editor: for each page, for each container on it (the page
 * itself, or a box), the order of what's inside, by layout id. Pages left out are untouched;
 * null resets a page to its default layout.
 */
const layoutId = z.string().min(1).max(200);
const pageLayout = z.record(layoutId, z.array(layoutId).max(300)).refine((v) => Object.keys(v).length <= 300, "Too many boxes");
export const pageLayoutsUpdateSchema = z.object({
  pages: z.record(layoutId, pageLayout.nullable()).refine((v) => Object.keys(v).length <= 200, "Too many pages"),
});
export type PageLayouts = Record<string, Record<string, string[]>>;

export const employeeSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: optionalPhone,
  title: z.string().trim().max(120).nullable().optional(),
  department: z.string().trim().max(120).nullable().optional(),
  role: z.enum(ROLES).default("employee"),
  managerId: z.string().uuid().nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default("full_time"),
  payType: z.enum(PAY_TYPES).default("hourly"),
  /** Hourly rate or annual salary, in cents. */
  payRateCents: z.number().int().nonnegative().default(0),
  startDate: isoDate.optional(),
  status: z.enum(EMPLOYEE_STATUSES).default("active"),
  /** Why they were made inactive or terminated. Ignored (cleared) for active and onboarding. */
  statusReason: z.string().trim().max(2000).nullable().optional(),
  ...employeeContactSchema.omit({ phone: true }).shape,
  /** Optional initial password so the employee can sign in to the app. */
  password: z.string().min(8).optional(),
  /** Email them a link to choose their own password (when no password is given). */
  sendInvite: z.boolean().optional(),
});
export type EmployeeInput = z.infer<typeof employeeSchema>;

export const clockInSchema = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    /** The phone's reported accuracy radius in meters. */
    accuracy: z.number().min(0).max(100_000).optional(),
    note: z.string().optional(),
  })
  .refine((b) => (b.lat === undefined) === (b.lng === undefined), { message: "Send both latitude and longitude", path: ["lat"] });

export const timeEntryEditSchema = z.object({
  clockIn: z.string().datetime(),
  clockOut: z.string().datetime().nullable(),
  note: z.string().optional(),
});

/** When a policy awards hours by date (see ptoAccrual.ts). */
export const PTO_GRANT_SCHEDULES = ["none", "yearly_date", "anniversary", "monthly"] as const;
export type PtoGrantSchedule = (typeof PTO_GRANT_SCHEDULES)[number];

export const PTO_CARRYOVER_RESETS = ["yearly_date", "anniversary"] as const;

/** A step up after some years of service: a new hourly accrual rate and/or award size. */
export const ptoTierSchema = z.object({
  afterYears: z.number().int().min(1).max(50),
  /** Hours earned per hour worked from this point; null keeps the policy's base rate. */
  accrualRate: z.number().nonnegative().max(1).nullable(),
  /** Hours per award from this point; null keeps the policy's base award. */
  grantHours: z.number().nonnegative().max(2000).nullable(),
});
export type PtoTier = z.infer<typeof ptoTierSchema>;

export const ptoPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** Hours accrued per hour worked (e.g. 1/30 = 0.0333); 0 for none. */
    accrualRate: z.number().nonnegative().max(1).default(0),
    /** Hours given on each award date (see grantSchedule). */
    annualGrantHours: z.number().nonnegative().max(2000).default(0),
    grantSchedule: z.enum(PTO_GRANT_SCHEDULES).default("none"),
    /** "MM-DD", for awards every year on a set date. */
    grantDate: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Use MM-DD").nullable().optional(),
    /** Day of the month (1–28), for monthly awards. */
    grantDayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
    maxBalanceHours: z.number().nonnegative().nullable().optional(),
    /** Most hours that carry into the next policy year; anything above is removed on the reset date. Null = no limit. */
    carryoverLimitHours: z.number().nonnegative().max(2000).nullable().optional(),
    /** When the policy year resets: every year on carryoverDate, or on each hire anniversary. */
    carryoverReset: z.enum(PTO_CARRYOVER_RESETS).default("yearly_date"),
    carryoverDate: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Use MM-DD").default("01-01"),
    tiers: z.array(ptoTierSchema).max(20).default([]),
  })
  .refine((p) => p.grantSchedule !== "yearly_date" || !!p.grantDate, { message: "Pick the date to award hours each year", path: ["grantDate"] })
  .refine((p) => p.grantSchedule !== "monthly" || !!p.grantDayOfMonth, { message: "Pick the day of the month", path: ["grantDayOfMonth"] })
  .refine((p) => new Set(p.tiers.map((t) => t.afterYears)).size === p.tiers.length, { message: "Each step needs a different number of years", path: ["tiers"] });

export const ptoRequestSchema = z.object({
  policyId: z.string().uuid(),
  startDate: isoDate,
  endDate: isoDate,
  hours: z.number().positive(),
  reason: z.string().optional(),
  /** Managers and up can enter a request for someone else (e.g. they called in sick). */
  employeeId: z.string().uuid().optional(),
});

export const ptoDecisionSchema = z.object({
  status: z.enum(["approved", "denied"]),
  note: z.string().optional(),
});

export const APPLICANT_STAGES = ["applied", "screening", "interview", "offer", "hired", "rejected"] as const;

export const jobSchema = z.object({
  title: z.string().min(1),
  department: z.string().optional(),
  location: z.string().optional(),
  description: z.string().default(""),
  payRange: z.string().optional(),
  status: z.enum(["draft", "open", "closed"]).default("open"),
});

export const applicantSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: optionalPhone,
  notes: z.string().optional(),
});

export const applicantStageSchema = z.object({ stage: z.enum(APPLICANT_STAGES) });

/**
 * What finishing a task takes: just checking it off, uploading a document
 * (e.g. a photo of a driver's license), or signing a company document (e.g.
 * the handbook). Upload and sign tasks complete themselves when that happens.
 */
export const TASK_ACTIONS = ["none", "upload", "sign", "form"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export const onboardingTaskTemplateSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    assignee: z.enum(["employee", "manager", "admin"]).default("employee"),
    dueInDays: z.number().int().nonnegative().default(0),
    action: z.enum(TASK_ACTIONS).default("none"),
    /** For "sign" tasks: the company-wide document each new hire signs. */
    documentId: z.string().uuid().nullable().optional(),
    /** For "form" tasks: which form finishes it ("i9_section2" is the employer's part, for admins). */
    formType: z.enum(ONBOARDING_FORM_TYPES).nullable().optional(),
  })
  .refine((t) => t.action !== "sign" || t.documentId, { message: "Choose the document to sign", path: ["documentId"] })
  .refine((t) => t.action !== "form" || t.formType, { message: "Choose the form", path: ["formType"] })
  .refine(
    (t) =>
      t.action === "none" ||
      (t.action === "form" && t.formType === "i9_section2" ? t.assignee === "admin" : t.assignee === "employee"),
    { message: "Only the new hire's own tasks can require an upload, signature or form (I-9 Section 2 is for admins)", path: ["action"] },
  );

export const onboardingTemplateSchema = z.object({
  name: z.string().min(1),
  tasks: z.array(onboardingTaskTemplateSchema).min(1),
});

/** Details asked for when hiring an applicant. */
export const hireSchema = z.object({
  startDate: isoDate.optional(),
  title: z.string().optional(),
  department: z.string().optional(),
  role: z.enum(["employee", "manager", "admin"]).default("employee"),
  managerId: z.string().uuid().nullable().optional(),
  payType: z.enum(PAY_TYPES).default("hourly"),
  payRateCents: z.number().int().nonnegative().default(0),
  employmentType: z.enum(EMPLOYMENT_TYPES).default("full_time"),
  onboardingTemplateId: z.string().uuid().nullable().optional(),
  sendInvite: z.boolean().default(true),
});

export const ASSET_TYPES = ["vehicle", "trailer", "heavy_equipment", "small_equipment", "tool", "other"] as const;

export const assetSchema = z.object({
  name: z.string().min(1),
  /** From the company's Asset types list (defaults to ASSET_TYPES). */
  type: z.string().trim().min(1).max(80),
  make: z.string().optional(),
  model: z.string().optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  vin: z.string().optional(),
  serialNumber: z.string().optional(),
  licensePlate: z.string().optional(),
  odometer: z.number().nonnegative().default(0),
  engineHours: z.number().nonnegative().default(0),
  status: z.enum(["active", "in_shop", "out_of_service", "retired"]).default("active"),
  assignedEmployeeId: z.string().uuid().nullable().optional(),
  registrationExpires: isoDate.nullable().optional(),
  insuranceExpires: isoDate.nullable().optional(),
});

export const meterReadingSchema = z.object({
  odometer: z.number().nonnegative().optional(),
  engineHours: z.number().nonnegative().optional(),
});

export const maintenanceScheduleSchema = z
  .object({
    assetId: z.string().uuid(),
    name: z.string().min(1),
    intervalMiles: z.number().positive().nullable().optional(),
    intervalHours: z.number().positive().nullable().optional(),
    intervalDays: z.number().int().positive().nullable().optional(),
    lastServiceDate: isoDate.nullable().optional(),
    lastServiceOdometer: z.number().nonnegative().nullable().optional(),
    lastServiceHours: z.number().nonnegative().nullable().optional(),
  })
  .refine((s) => s.intervalMiles || s.intervalHours || s.intervalDays, {
    message: "At least one interval (miles, hours or days) is required",
  });

export const WORK_ORDER_STATUSES = ["open", "in_progress", "waiting_parts", "completed", "cancelled"] as const;

export const workOrderSchema = z.object({
  assetId: z.string().uuid(),
  scheduleId: z.string().uuid().nullable().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  assignedToId: z.string().uuid().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  /** Due when the asset reaches this odometer reading / engine hours (whichever comes first, with the date). */
  dueOdometer: z.number().nonnegative().nullable().optional(),
  dueHours: z.number().nonnegative().nullable().optional(),
});

export const workOrderUpdateSchema = z.object({
  /** Managers can reschedule: by date, mileage or engine hours (null clears one). */
  dueDate: isoDate.nullable().optional(),
  dueOdometer: z.number().nonnegative().nullable().optional(),
  dueHours: z.number().nonnegative().nullable().optional(),
  status: z.enum(WORK_ORDER_STATUSES).optional(),
  assignedToId: z.string().uuid().nullable().optional(),
  laborHours: z.number().nonnegative().optional(),
  partsCostCents: z.number().int().nonnegative().optional(),
  laborCostCents: z.number().int().nonnegative().optional(),
  vendor: z.string().optional(),
  resolutionNotes: z.string().optional(),
  /** Meter readings at completion; used to reset the linked schedule. */
  completedOdometer: z.number().nonnegative().optional(),
  completedHours: z.number().nonnegative().optional(),
});

export const inspectionSchema = z.object({
  assetId: z.string().uuid(),
  odometer: z.number().nonnegative().optional(),
  engineHours: z.number().nonnegative().optional(),
  items: z
    .array(z.object({ item: z.string().min(1), ok: z.boolean(), note: z.string().optional() }))
    .min(1),
  notes: z.string().optional(),
});

/** Default pre-trip / pre-use checklist shown in the mobile app. */
export const DEFAULT_INSPECTION_ITEMS = [
  "Lights & signals",
  "Tires & wheels",
  "Brakes",
  "Fluid levels",
  "Leaks",
  "Mirrors & glass",
  "Horn & wipers",
  "Safety equipment",
];

export const payrollExportSchema = z
  .object({
    periodStart: isoDate,
    periodEnd: isoDate,
    /** Count only manager-approved time entries ("true" in a query string). */
    approvedOnly: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional(),
  })
  .refine((p) => p.periodEnd >= p.periodStart, { message: "The period must end on or after it starts", path: ["periodEnd"] });

export const deviceSchema = z.object({
  token: z.string().regex(/^Expo(nent)?PushToken\[[^\]]+\]$/, "Not an Expo push token"),
  platform: z.enum(["ios", "android", "web"]),
});

const MAX_SHIFT_HOURS = 24;

export const shiftBaseSchema = z.object({
  employeeId: z.string().uuid().nullable().optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  position: z.string().optional(),
  location: z.string().optional(),
  assetId: z.string().uuid().nullable().optional(),
  notes: z.string().optional(),
});

export const shiftSchema = shiftBaseSchema
  .refine((s) => Date.parse(s.endsAt) > Date.parse(s.startsAt), { message: "Shift must end after it starts", path: ["endsAt"] })
  .refine((s) => Date.parse(s.endsAt) - Date.parse(s.startsAt) <= MAX_SHIFT_HOURS * 3_600_000, {
    message: `Shifts can be at most ${MAX_SHIFT_HOURS} hours`,
    path: ["endsAt"],
  });
export type ShiftInput = z.infer<typeof shiftSchema>;

/** A date range [from, to) used for week views, publishing and copying. */
export const shiftRangeSchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

export const notificationPreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        category: z.enum(NOTIFICATION_CATEGORIES),
        app: z.boolean(),
        email: z.enum(DELIVERY_MODES),
        sms: z.enum(DELIVERY_MODES),
      }),
    )
    .optional(),
  /** Consent to receive texts, required before any SMS is sent. */
  smsOptIn: z.boolean().optional(),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");

export const availabilitySchema = z.object({
  rules: z
    .array(
      z
        .object({
          weekday: z.number().int().min(0).max(6),
          startTime: hhmm.nullable().optional(),
          endTime: hhmm.nullable().optional(),
          note: z.string().max(200).nullable().optional(),
        })
        .refine((r) => !r.startTime || !r.endTime || r.endTime > r.startTime, {
          message: "End time must be after start time",
          path: ["endTime"],
        }),
    )
    .max(50),
});

export const shiftTemplateSchema = z.object({
  name: z.string().min(1).max(80),
  /** Local start/end; an end at or before the start runs past midnight. */
  startTime: hhmm,
  endTime: hhmm,
  position: z.string().optional(),
  location: z.string().optional(),
  assetId: z.string().uuid().nullable().optional(),
  notes: z.string().optional(),
});
