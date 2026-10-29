import { z } from "zod";
import { DELIVERY_MODES, NOTIFICATION_CATEGORIES } from "./notifications";
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

export const employeeSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  title: z.string().optional(),
  department: z.string().optional(),
  role: z.enum(ROLES).default("employee"),
  managerId: z.string().uuid().nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default("full_time"),
  payType: z.enum(PAY_TYPES).default("hourly"),
  /** Hourly rate or annual salary, in cents. */
  payRateCents: z.number().int().nonnegative().default(0),
  startDate: isoDate.optional(),
  status: z.enum(["active", "onboarding", "terminated"]).default("active"),
  /** Optional initial password so the employee can sign in to the app. */
  password: z.string().min(8).optional(),
});
export type EmployeeInput = z.infer<typeof employeeSchema>;

export const clockInSchema = z.object({
  lat: z.number().optional(),
  lng: z.number().optional(),
  note: z.string().optional(),
});

export const timeEntryEditSchema = z.object({
  clockIn: z.string().datetime(),
  clockOut: z.string().datetime().nullable(),
  note: z.string().optional(),
});

export const ptoPolicySchema = z.object({
  name: z.string().min(1),
  /** Hours accrued per hour worked (e.g. 1/30 = 0.0333) or 0 for fixed grants. */
  accrualRate: z.number().nonnegative().default(0),
  annualGrantHours: z.number().nonnegative().default(0),
  maxBalanceHours: z.number().nonnegative().nullable().optional(),
});

export const ptoRequestSchema = z.object({
  policyId: z.string().uuid(),
  startDate: isoDate,
  endDate: isoDate,
  hours: z.number().positive(),
  reason: z.string().optional(),
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
  phone: z.string().optional(),
  notes: z.string().optional(),
});

export const applicantStageSchema = z.object({ stage: z.enum(APPLICANT_STAGES) });

export const onboardingTemplateSchema = z.object({
  name: z.string().min(1),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        assignee: z.enum(["employee", "manager", "admin"]).default("employee"),
        dueInDays: z.number().int().nonnegative().default(0),
        requiresDocument: z.boolean().default(false),
      }),
    )
    .min(1),
});

export const ASSET_TYPES = ["vehicle", "trailer", "heavy_equipment", "small_equipment", "tool", "other"] as const;

export const assetSchema = z.object({
  name: z.string().min(1),
  type: z.enum(ASSET_TYPES),
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
});

export const workOrderUpdateSchema = z.object({
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

export const payrollExportSchema = z.object({
  periodStart: isoDate,
  periodEnd: isoDate,
});

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
