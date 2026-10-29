import { z } from "zod";
import { hasRole, type Role } from "./roles";

/**
 * Who can see or edit a wiki page, as the lowest role allowed:
 * "employee" = everyone, "manager" = managers and above, "admin" = admins and the owner.
 */
export const WIKI_LEVELS = ["employee", "manager", "admin"] as const;
export type WikiLevel = (typeof WIKI_LEVELS)[number];

export const WIKI_LEVEL_LABELS: Record<WikiLevel, string> = {
  employee: "Everyone",
  manager: "Managers and admins",
  admin: "Admins only",
};

export const canAccess = (role: Role, level: string) => hasRole(role, level as Role);

export const wikiPageSchema = z
  .object({
    title: z.string().trim().min(1, "Give the page a title").max(200),
    body: z.string().max(200_000).default(""),
    parentId: z.string().uuid().nullable().optional(),
    viewMin: z.enum(WIKI_LEVELS).default("employee"),
    editMin: z.enum(WIKI_LEVELS).default("admin"),
    pinned: z.boolean().default(false),
    /** Tell everyone who can see the page that it was published/updated. */
    notify: z.boolean().default(false),
    /** A short note for the history ("Updated holiday dates"). */
    note: z.string().trim().max(200).optional(),
  })
  .refine((p) => hasRole(p.editMin as Role, p.viewMin as Role), {
    message: "People who can edit a page must also be able to see it",
    path: ["editMin"],
  });

export const wikiPageUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(200_000).optional(),
  parentId: z.string().uuid().nullable().optional(),
  viewMin: z.enum(WIKI_LEVELS).optional(),
  editMin: z.enum(WIKI_LEVELS).optional(),
  pinned: z.boolean().optional(),
  notify: z.boolean().default(false),
  note: z.string().trim().max(200).optional(),
  /** The page's updatedAt when editing started; a mismatch means someone else saved in the meantime. */
  baseUpdatedAt: z.string().datetime().optional(),
});
