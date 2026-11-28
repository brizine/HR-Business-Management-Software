import { z } from "zod";

/** Crews (like Homeworks'): a named team (a lead, members and the truck they take) that work orders go to. */

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const crewSchema = z.object({
  name: z.string().trim().min(1, "Name the crew").max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color").default("#2563eb"),
  leadId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  memberIds: z.array(z.string().uuid()).max(50).default([]),
  /** Hours a day it can work (the waiting list's workload strip). */
  dailyHours: z.coerce.number().min(1).max(24).default(8),
  /** The truck or equipment the crew takes. */
  assetId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  notes: z.preprocess(blankToNull, z.string().trim().max(1000).nullable()).optional(),
  active: z.boolean().default(true),
  /** Editing: also give this crew's open work orders (today on) the new members. */
  updateOpenWorkOrders: z.boolean().default(false),
});
export type CrewInput = z.infer<typeof crewSchema>;

/** Everyone on the crew: the lead (if any) first, then the members, no repeats. */
export const crewPeople = (c: { leadId?: string | null; memberIds: string[] }) => [...new Set([...(c.leadId ? [c.leadId] : []), ...c.memberIds])];
