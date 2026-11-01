import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { and, asc, eq, inArray } from "drizzle-orm";
import { EMPLOYEE_PRIVATE_CONTACT_FIELDS, employeeContactSchema, employeeMenusSchema, employeeSchema, hasRole, isInactive, menuRenameSchema, pageLayoutsUpdateSchema, MENU_LISTS, STORED_LISTS, defaultLabel, defaultList, menuLabelsSchema, menuListRenameSchema, menuListSchema, type Role, type StoredList } from "@crewdesk/shared";
import { db } from "../db";
import { assets, companies, documents, employees, jobs, mixProducts, mixSheets, recoveryCodes } from "../db/schema";
import { authenticate, canManageAccount, requireRole, signOutEverywhere, roleIn } from "../lib/auth";
import { sendInvite } from "../lib/invites";
import { storage } from "../lib/storage";
import { MAX_IMAGE_BYTES as MAX_PHOTO_BYTES, imageType } from "../lib/images";

async function actorName(id: string) {
  const [e] = await db.select({ f: employees.firstName, l: employees.lastName }).from(employees).where(eq(employees.id, id));
  return e ? `${e.f} ${e.l}` : undefined;
}
import { HttpError, notFound, parse } from "../lib/errors";

/** Which area of the Permissions page controls access here. */
const AREA = "people" as const;

type EmployeeRow = typeof employees.$inferSelect;


/** Never sends password hashes, two-factor secrets or lockout counters to clients. */
export function publicEmployee(e: EmployeeRow) {
  const { passwordHash, totpSecret, totpPendingSecret, totpLastStep, tokenVersion, failedLoginCount, lockedUntil, photoKey, ...rest } = e;
  return {
    ...rest,
    hasLogin: !!passwordHash,
    twoFactorEnabled: !!totpSecret,
    hasPhoto: !!photoKey,
    locked: !!lockedUntil && lockedUntil > new Date(),
  };
}

/** Strips pay, home address, emergency contact and the reason someone left for viewers who are not managers. */
function directoryView(e: EmployeeRow) {
  const { payRateCents, payType, payrollProviderEmployeeId, statusReason, statusChangedById, ...rest } = publicEmployee(e);
  for (const f of EMPLOYEE_PRIVATE_CONTACT_FIELDS) delete (rest as Partial<EmployeeRow>)[f];
  return rest;
}

/** Someone looking at their own record: everything except the notes managers keep about them leaving. */
function ownView(e: EmployeeRow) {
  const { statusReason, statusChangedById, ...rest } = publicEmployee(e);
  return rest;
}

/** Fills in the reason and who/when for a status change; the reason only applies to inactive and terminated. */
function statusFields(body: { status?: string; statusReason?: string | null }, before: EmployeeRow | null, actorId: string) {
  const status = body.status ?? before?.status ?? "active";
  const changed = status !== (before?.status ?? "active");
  const out: Partial<EmployeeRow> = {};
  if (!isInactive(status)) out.statusReason = null;
  else if (body.statusReason !== undefined) out.statusReason = body.statusReason || null;
  if (changed || (out.statusReason !== undefined && out.statusReason !== (before?.statusReason ?? null))) {
    out.statusChangedAt = new Date();
    out.statusChangedById = actorId;
  }
  return out;
}

function storedListKey(key: string): StoredList {
  if (!(STORED_LISTS as readonly string[]).includes(key)) throw new HttpError(404, "Menu not found");
  return key as StoredList;
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/", async (req) => {
    const rows = await db
      .select()
      .from(employees)
      .where(eq(employees.companyId, req.user.companyId))
      .orderBy(asc(employees.lastName), asc(employees.firstName));
    return hasRole(roleIn(req, AREA), "manager") ? rows.map(publicEmployee) : rows.map(directoryView);
  });

  // ---- Job title and Department menus (owner edits; everyone can read) ----

  async function menus(companyId: string) {
    const [c] = await db.select({ jobTitles: companies.jobTitles, departments: companies.departments, menuLists: companies.menuLists, menuLabels: companies.menuLabels }).from(companies).where(eq(companies.id, companyId));
    const used = await db.select({ title: employees.title, department: employees.department }).from(employees).where(eq(employees.companyId, companyId));
    const docs = await db.select({ v: documents.category }).from(documents).where(eq(documents.companyId, companyId));
    const units = await db.select({ v: mixProducts.unit }).from(mixProducts).innerJoin(mixSheets, eq(mixSheets.id, mixProducts.sheetId)).where(eq(mixSheets.companyId, companyId));
    const types = await db.select({ v: assets.type }).from(assets).where(eq(assets.companyId, companyId));
    const count = (vals: (string | null)[]) => vals.reduce<Record<string, number>>((n, v) => (v ? { ...n, [v]: (n[v] ?? 0) + 1 } : n), {});
    const lists = Object.fromEntries(STORED_LISTS.map((k) => [k, c.menuLists[k] ?? defaultList(k)])) as Record<StoredList, string[]>;
    return {
      jobTitles: c.jobTitles,
      departments: c.departments,
      ...lists,
      labels: c.menuLabels,
      usage: {
        jobTitles: count(used.map((u) => u.title)),
        departments: count(used.map((u) => u.department)),
        documentCategories: count(docs.map((d) => d.v)),
        mixUnits: count(units.map((d) => d.v)),
        assetTypes: count(types.map((d) => d.v)),
      },
    };
  }

  app.get("/menus", async (req) => menus(req.user.companyId));

  /** Replaces the lists (adding, removing, reordering). Removing an entry leaves people who have it as they are. */
  app.put("/menus", { preHandler: requireRole("owner", "company") }, async (req) => {
    const body = parse(employeeMenusSchema, req.body);
    await db.update(companies).set(body).where(eq(companies.id, req.user.companyId));
    return menus(req.user.companyId);
  });

  /** Renames an entry everywhere: the list, everyone who has it, and (for departments) job postings. */
  app.post("/menus/rename", { preHandler: requireRole("owner", "company") }, async (req) => {
    const { kind, from, to } = parse(menuRenameSchema, req.body);
    const current = await menus(req.user.companyId);
    const list = current[kind];
    if (!list.includes(from)) notFound("Menu entry");
    if (from !== to && list.includes(to)) throw new HttpError(409, `"${to}" is already on the list`);
    await db.transaction(async (tx) => {
      await tx.update(companies).set({ [kind]: list.map((v) => (v === from ? to : v)) }).where(eq(companies.id, req.user.companyId));
      const col = kind === "jobTitles" ? employees.title : employees.department;
      await tx.update(employees).set(kind === "jobTitles" ? { title: to } : { department: to }).where(and(eq(employees.companyId, req.user.companyId), eq(col, from)));
      if (kind === "departments") await tx.update(jobs).set({ department: to }).where(and(eq(jobs.companyId, req.user.companyId), eq(jobs.department, from)));
    });
    return menus(req.user.companyId);
  });

  /** Replaces one of the other editable lists (document categories, Spray Mix measurements, asset types). */
  app.put<{ Params: { key: string } }>("/menus/lists/:key", { preHandler: requireRole("owner", "company") }, async (req) => {
    const key = storedListKey(req.params.key);
    const { values } = parse(menuListSchema, req.body);
    const [c] = await db.select({ menuLists: companies.menuLists }).from(companies).where(eq(companies.id, req.user.companyId));
    await db.update(companies).set({ menuLists: { ...c.menuLists, [key]: values } }).where(eq(companies.id, req.user.companyId));
    return menus(req.user.companyId);
  });

  /** Renames an entry in one of those lists, and everything that uses it. */
  app.post<{ Params: { key: string } }>("/menus/lists/:key/rename", { preHandler: requireRole("owner", "company") }, async (req) => {
    const key = storedListKey(req.params.key);
    const { from, to } = parse(menuListRenameSchema, req.body);
    const current = await menus(req.user.companyId);
    const list = current[key];
    if (!list.includes(from)) notFound("Menu entry");
    if (from !== to && list.includes(to)) throw new HttpError(409, `"${to}" is already on the list`);
    const [c] = await db.select({ menuLists: companies.menuLists }).from(companies).where(eq(companies.id, req.user.companyId));
    const companyId = req.user.companyId;
    await db.transaction(async (tx) => {
      await tx.update(companies).set({ menuLists: { ...c.menuLists, [key]: list.map((v) => (v === from ? to : v)) } }).where(eq(companies.id, companyId));
      if (key === "documentCategories") await tx.update(documents).set({ category: to }).where(and(eq(documents.companyId, companyId), eq(documents.category, from)));
      if (key === "assetTypes") await tx.update(assets).set({ type: to }).where(and(eq(assets.companyId, companyId), eq(assets.type, from)));
      if (key === "mixUnits") {
        const sheetIds = (await tx.select({ id: mixSheets.id }).from(mixSheets).where(eq(mixSheets.companyId, companyId))).map((r) => r.id);
        if (sheetIds.length) await tx.update(mixProducts).set({ unit: to }).where(and(inArray(mixProducts.sheetId, sheetIds), eq(mixProducts.unit, from)));
      }
    });
    return menus(req.user.companyId);
  });

  /** New wording for fixed choices (e.g. "terminated" → "Separated"); blank puts back the default. */
  app.put<{ Params: { key: string } }>("/menus/labels/:key", { preHandler: requireRole("owner", "company") }, async (req) => {
    const menu = MENU_LISTS.find((m) => m.key === req.params.key && m.kind === "labels");
    if (!menu || !("values" in menu)) notFound("Menu");
    const { labels } = parse(menuLabelsSchema, req.body);
    const values = menu.values as readonly string[];
    const clean = Object.fromEntries(Object.entries(labels).filter(([v, l]) => values.includes(v) && l && l.trim() && l.trim() !== defaultLabel(v)).map(([v, l]) => [v, l!.trim()]));
    const [c] = await db.select({ menuLabels: companies.menuLabels }).from(companies).where(eq(companies.id, req.user.companyId));
    await db.update(companies).set({ menuLabels: { ...c.menuLabels, [menu.key]: clean } }).where(eq(companies.id, req.user.companyId));
    return menus(req.user.companyId);
  });

  /** Page layouts from the owner's layout editor; every page reads them. */
  app.get("/layouts", async (req) => {
    const [c] = await db.select({ pages: companies.pageLayouts }).from(companies).where(eq(companies.id, req.user.companyId));
    return { pages: c?.pages ?? {} };
  });

  /** Saves the pages sent (an empty or null page goes back to its default layout); other pages are kept. */
  app.put("/layouts", { preHandler: requireRole("owner", "company") }, async (req) => {
    const { pages } = parse(pageLayoutsUpdateSchema, req.body);
    const [c] = await db.select({ pages: companies.pageLayouts }).from(companies).where(eq(companies.id, req.user.companyId));
    const next = { ...(c?.pages ?? {}) };
    for (const [page, layout] of Object.entries(pages)) {
      if (!layout || !Object.keys(layout).length) delete next[page];
      else next[page] = layout;
    }
    if (Object.keys(next).length > 200) throw new HttpError(400, "Too many page layouts");
    await db.update(companies).set({ pageLayouts: next }).where(eq(companies.id, req.user.companyId));
    return { pages: next };
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const [row] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, req.params.id), eq(employees.companyId, req.user.companyId)));
    if (!row) notFound("Employee");
    if (hasRole(roleIn(req, AREA), "manager")) return publicEmployee(row);
    return row.id === req.user.sub ? ownView(row) : directoryView(row);
  });

  app.post("/", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const body = parse(employeeSchema, req.body);
    if (!canManageAccount(roleIn(req, "people"), body.role)) throw new HttpError(403, "Only the owner can add admins and owners");
    const { password, sendInvite: wantsInvite, statusReason, ...rest } = body;
    const [row] = await db
      .insert(employees)
      .values({
        ...rest,
        ...(isInactive(rest.status) ? statusFields(body, null, req.user.sub) : {}),
        email: rest.email.toLowerCase(),
        companyId: req.user.companyId,
        passwordHash: password ? await bcrypt.hash(password, 10) : null,
      })
      .returning();
    // No password given: by default, email them a link to choose one.
    const invite = !password && (wantsInvite ?? true) ? await sendInvite(row, await actorName(req.user.sub)) : null;
    return { ...publicEmployee(invite ? { ...row, invitedAt: new Date() } : row), invite };
  });

  /**
   * (Re)sends the "set up your account" email. The response includes the link
   * so an admin can text it if email isn't set up or didn't arrive.
   */
  app.post<{ Params: { id: string } }>("/:id/invite", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const target = await manageable(req, req.params.id, false);
    if (target.passwordHash) throw new HttpError(409, `${target.firstName} already has a login. They can use "Forgot your password?" if needed.`);
    if (isInactive(target.status)) throw new HttpError(409, `This person is ${target.status}. Make them active first.`);
    return sendInvite(target, await actorName(req.user.sub));
  });

  /** Loads someone in the caller's company that the caller is allowed to manage. */
  async function manageable(req: { user: { companyId: string; sub: string; role: Role } }, id: string, allowSelf = true) {
    const [target] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, id), eq(employees.companyId, req.user.companyId)));
    if (!target) notFound("Employee");
    const self = target.id === req.user.sub;
    if (self ? !allowSelf : !canManageAccount(roleIn(req, "people"), target.role as Role)) {
      throw new HttpError(403, self ? "Use your Security settings for your own account" : "Only the owner can change another admin's or the owner's account");
    }
    return target;
  }

  app.patch<{ Params: { id: string } }>("/:id", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const body = parse(employeeSchema.partial(), req.body);
    const target = await manageable(req, req.params.id);
    if (body.role && body.role !== target.role) {
      if (target.id === req.user.sub) throw new HttpError(403, "You can't change your own role");
      if (!canManageAccount(roleIn(req, "people"), body.role)) throw new HttpError(403, "Only the owner can make someone an admin or owner");
    }
    const { password, statusReason, ...rest } = body;
    const [row] = await db
      .update(employees)
      .set({
        ...rest,
        ...statusFields(body, target, req.user.sub),
        ...(rest.email ? { email: rest.email.toLowerCase() } : {}),
        ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
      })
      .where(and(eq(employees.id, req.params.id), eq(employees.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Employee");
    // Anything that changes who can sign in, or as what, ends their current sessions.
    const changedAccess =
      !!password ||
      (rest.email !== undefined && rest.email.toLowerCase() !== target.email) ||
      (rest.role !== undefined && rest.role !== target.role) ||
      (isInactive(rest.status) && !isInactive(target.status));
    return publicEmployee(changedAccess ? await signOutEverywhere(row.id) : row);
  });

  /** Ends all of someone's sessions, e.g. a lost phone or the day they leave. */
  app.post<{ Params: { id: string } }>("/:id/sign-out-everywhere", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const target = await manageable(req, req.params.id);
    await signOutEverywhere(target.id);
    return { ok: true };
  });

  /**
   * For someone who lost their phone and backup codes: turns two-factor off
   * and signs them out. If their role requires it, they'll set it up again at
   * their next sign-in. Unlocks the account too.
   */
  app.post<{ Params: { id: string } }>("/:id/reset-two-factor", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const target = await manageable(req, req.params.id, false);
    await db
      .update(employees)
      .set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, failedLoginCount: 0, lockedUntil: null })
      .where(eq(employees.id, target.id));
    await db.delete(recoveryCodes).where(eq(recoveryCodes.employeeId, target.id));
    await signOutEverywhere(target.id);
    return { ok: true };
  });

  /** Unlocks an account locked by too many failed sign-in attempts. */
  app.post<{ Params: { id: string } }>("/:id/unlock", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const target = await manageable(req, req.params.id);
    await db.update(employees).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(employees.id, target.id));
    return { ok: true };
  });

  // ---- Profile photos ----

  /** Admins can set anyone's photo (within canManageAccount); everyone can set their own. */
  async function photoTarget(req: { user: { companyId: string; sub: string; role: Role } }, id: string) {
    if (id === req.user.sub) {
      const [me] = await db.select().from(employees).where(eq(employees.id, id));
      return me;
    }
    if (!hasRole(roleIn(req, AREA), "admin")) throw new HttpError(403, "You can only change your own photo");
    return manageable(req, id);
  }

  /** multipart/form-data with one image (JPEG, PNG or WebP, up to 5 MB). */
  app.put<{ Params: { id: string } }>("/:id/photo", async (req) => {
    const target = await photoTarget(req, req.params.id);
    const file = await req.file();
    if (!file) throw new HttpError(400, "No photo uploaded");
    const buf = await file.toBuffer();
    if (buf.length > MAX_PHOTO_BYTES) throw new HttpError(400, "That photo is too large (5 MB max)");
    if (!imageType(buf)) throw new HttpError(400, "Use a JPEG, PNG or WebP photo");
    const key = `${req.user.companyId}/photos/${target.id}-${randomUUID()}`;
    await storage.put(key, buf);
    const [row] = await db.update(employees).set({ photoKey: key, photoUpdatedAt: new Date() }).where(eq(employees.id, target.id)).returning();
    return publicEmployee(row);
  });

  app.delete<{ Params: { id: string } }>("/:id/photo", async (req) => {
    const target = await photoTarget(req, req.params.id);
    const [row] = await db.update(employees).set({ photoKey: null, photoUpdatedAt: new Date() }).where(eq(employees.id, target.id)).returning();
    return publicEmployee(row);
  });

  /** Anyone in the company can see coworkers' photos. Add ?v=<photoUpdatedAt> so a new photo isn't served from cache. */
  app.get<{ Params: { id: string } }>("/:id/photo", async (req, reply) => {
    const [row] = await db
      .select({ photoKey: employees.photoKey })
      .from(employees)
      .where(and(eq(employees.id, req.params.id), eq(employees.companyId, req.user.companyId)));
    if (!row?.photoKey) notFound("Photo");
    const buf = await storage.get(row.photoKey);
    reply.header("Content-Type", imageType(buf) ?? "application/octet-stream");
    reply.header("Cache-Control", "private, max-age=86400");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(buf);
  });

  /** Lets an employee update their own phone, home address and emergency contact. Passwords change via /auth/password. */
  app.patch("/me/profile", async (req) => {
    const body = parse(employeeContactSchema, req.body);
    const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const [row] = Object.keys(changes).length
      ? await db.update(employees).set(changes).where(eq(employees.id, req.user.sub)).returning()
      : await db.select().from(employees).where(eq(employees.id, req.user.sub));
    return ownView(row);
  });
};

export default routes;
