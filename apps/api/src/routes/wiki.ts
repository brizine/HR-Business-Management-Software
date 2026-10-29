import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  WIKI_LEVELS,
  WIKI_LEVEL_LABELS,
  canAccess,
  hasRole,
  wikiPageSchema,
  wikiPageUpdateSchema,
  type Role,
  type WikiLevel,
} from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { companies, employees, wikiPages, wikiRevisions } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { except, notify, staffWithRole } from "../lib/notify";

type Page = typeof wikiPages.$inferSelect;

const role = (req: FastifyRequest) => req.user.role as Role;
const isAdmin = (req: FastifyRequest) => hasRole(role(req), "admin");
const canView = (req: FastifyRequest, p: Page) => canAccess(role(req), p.viewMin);
const canEdit = (req: FastifyRequest, p: Page) => canAccess(role(req), p.editMin) && canView(req, p);

/** A snippet of the body around the search term, for results. */
function snippet(body: string, q: string) {
  const plain = body.replace(/[#*_`>\[\]()|-]/g, " ").replace(/\s+/g, " ");
  const i = plain.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return plain.slice(0, 140);
  const start = Math.max(0, i - 50);
  return (start ? "…" : "") + plain.slice(start, i + q.length + 90) + "…";
}

async function names(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db.select({ id: employees.id, f: employees.firstName, l: employees.lastName }).from(employees).where(inArray(employees.id, unique));
  return new Map(rows.map((r) => [r.id, `${r.f} ${r.l}`]));
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  async function loadPage(req: FastifyRequest, id: string) {
    const [page] = await db
      .select()
      .from(wikiPages)
      .where(and(eq(wikiPages.id, id), eq(wikiPages.companyId, req.user.companyId), isNull(wikiPages.deletedAt)));
    // Pages someone can't see look the same as pages that don't exist.
    if (!page || !canView(req, page)) notFound("Page");
    return page;
  }

  async function createMin(companyId: string) {
    const [c] = await db.select({ m: companies.wikiCreateMin }).from(companies).where(eq(companies.id, companyId));
    return c.m as WikiLevel;
  }

  /** Levels a person may give a page: never above their own role (they'd lock themselves out). */
  function checkLevels(req: FastifyRequest, viewMin: string, editMin: string) {
    if (!canAccess(role(req), viewMin) || !canAccess(role(req), editMin)) {
      throw new HttpError(403, "You can't restrict a page to people above your own role");
    }
    if (!hasRole(editMin as Role, viewMin as Role)) throw new HttpError(400, "People who can edit a page must also be able to see it");
  }

  async function checkParent(req: FastifyRequest, parentId: string | null | undefined, selfId?: string) {
    if (!parentId) return;
    if (parentId === selfId) throw new HttpError(400, "A page can't be inside itself");
    let cursor: string | null = parentId;
    for (let depth = 0; cursor; depth++) {
      if (cursor === selfId) throw new HttpError(400, "A page can't be moved inside one of its own sub-pages");
      if (depth > 20) throw new HttpError(400, "Pages are nested too deeply");
      const parent = await loadPage(req, cursor);
      cursor = parent.parentId;
    }
  }

  async function announce(req: FastifyRequest, page: Page, created: boolean, note?: string) {
    const [me] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
    notify(req.user.companyId, except(await staffWithRole(req.user.companyId, page.viewMin as Role), req.user.sub), {
      category: "wiki",
      title: `${created ? "New" : "Updated"} wiki page: ${page.title}`,
      body: note || `${created ? "Published" : "Updated"} by ${me.firstName} ${me.lastName}.`,
      link: { screen: "wiki", id: page.id },
    });
  }

  app.get("/settings", async (req) => {
    const min = await createMin(req.user.companyId);
    return { createMin: min, canCreate: canAccess(role(req), min), levels: WIKI_LEVEL_LABELS };
  });

  /** Who can create pages; admins decide. */
  app.put("/settings", { preHandler: requireRole("admin") }, async (req) => {
    const { createMin: m } = parse(z.object({ createMin: z.enum(WIKI_LEVELS) }), req.body);
    await db.update(companies).set({ wikiCreateMin: m }).where(eq(companies.id, req.user.companyId));
    return { createMin: m };
  });

  /** Every page the person can see (for the page tree), or search results when `q` is given. */
  app.get<{ Querystring: { q?: string } }>("/pages", async (req) => {
    const rows = await db
      .select()
      .from(wikiPages)
      .where(and(eq(wikiPages.companyId, req.user.companyId), isNull(wikiPages.deletedAt)));
    let visible = rows.filter((p) => canView(req, p));
    const q = req.query.q?.trim();
    if (q) {
      const lower = q.toLowerCase();
      visible = visible
        .filter((p) => p.title.toLowerCase().includes(lower) || p.body.toLowerCase().includes(lower))
        .sort((a, b) => Number(b.title.toLowerCase().includes(lower)) - Number(a.title.toLowerCase().includes(lower)));
    }
    const who = await names(visible.map((p) => p.updatedById));
    const ids = new Set(visible.map((p) => p.id));
    return visible.map((p) => ({
      id: p.id,
      title: p.title,
      // A sub-page whose parent is hidden from this person shows at the top level.
      parentId: p.parentId && ids.has(p.parentId) ? p.parentId : null,
      pinned: p.pinned,
      viewMin: p.viewMin,
      editMin: p.editMin,
      canEdit: canEdit(req, p),
      updatedAt: p.updatedAt,
      updatedBy: p.updatedById ? who.get(p.updatedById) ?? null : null,
      ...(q ? { snippet: snippet(p.body, q) } : {}),
    }));
  });

  app.get<{ Params: { id: string } }>("/pages/:id", async (req) => {
    const page = await loadPage(req, req.params.id);
    const crumbs: { id: string; title: string }[] = [];
    for (let cursor = page.parentId; cursor && crumbs.length < 20; ) {
      const [parent] = await db.select().from(wikiPages).where(and(eq(wikiPages.id, cursor), isNull(wikiPages.deletedAt)));
      if (!parent || !canView(req, parent)) break;
      crumbs.unshift({ id: parent.id, title: parent.title });
      cursor = parent.parentId;
    }
    const children = (
      await db
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.parentId, page.id), isNull(wikiPages.deletedAt)))
    )
      .filter((c) => canView(req, c))
      .map((c) => ({ id: c.id, title: c.title }))
      .sort((a, b) => a.title.localeCompare(b.title));
    const who = await names([page.updatedById, page.createdById]);
    return {
      ...page,
      updatedBy: page.updatedById ? who.get(page.updatedById) ?? null : null,
      createdBy: page.createdById ? who.get(page.createdById) ?? null : null,
      canEdit: canEdit(req, page),
      canManage: isAdmin(req),
      breadcrumbs: crumbs,
      children,
    };
  });

  app.post("/pages", async (req) => {
    const body = parse(wikiPageSchema, req.body);
    if (!canAccess(role(req), await createMin(req.user.companyId))) throw new HttpError(403, "Your company limits who can create wiki pages");
    checkLevels(req, body.viewMin, body.editMin);
    if (body.pinned && !isAdmin(req)) throw new HttpError(403, "Only admins can pin pages");
    await checkParent(req, body.parentId);
    const page = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(wikiPages)
        .values({
          companyId: req.user.companyId,
          parentId: body.parentId ?? null,
          title: body.title,
          body: body.body,
          viewMin: body.viewMin,
          editMin: body.editMin,
          pinned: body.pinned,
          createdById: req.user.sub,
          updatedById: req.user.sub,
        })
        .returning();
      await tx.insert(wikiRevisions).values({ pageId: p.id, title: p.title, body: p.body, note: body.note ?? "Created", editedById: req.user.sub });
      return p;
    });
    if (body.notify) await announce(req, page, true, body.note);
    return page;
  });

  /**
   * Edits a page. Anyone allowed to edit can change the title and text;
   * only admins can change who can see/edit it, pin it, or move it.
   */
  app.patch<{ Params: { id: string } }>("/pages/:id", async (req) => {
    const body = parse(wikiPageUpdateSchema, req.body);
    const page = await loadPage(req, req.params.id);
    if (!canEdit(req, page)) throw new HttpError(403, "You can read this page but not edit it");
    const changesAccess = (body.viewMin && body.viewMin !== page.viewMin) || (body.editMin && body.editMin !== page.editMin);
    const changesPlacement = (body.pinned !== undefined && body.pinned !== page.pinned) || (body.parentId !== undefined && body.parentId !== page.parentId);
    if ((changesAccess || changesPlacement) && !isAdmin(req)) throw new HttpError(403, "Only admins can change who can see or edit a page, pin it, or move it");
    if (changesAccess) checkLevels(req, body.viewMin ?? page.viewMin, body.editMin ?? page.editMin);
    if (body.parentId !== undefined && body.parentId !== page.parentId) await checkParent(req, body.parentId, page.id);
    if (body.baseUpdatedAt && new Date(body.baseUpdatedAt).getTime() !== page.updatedAt.getTime()) {
      throw new HttpError(409, "Someone else saved this page while you were editing. Copy your changes, reload, and try again.");
    }

    const contentChanged = (body.title !== undefined && body.title !== page.title) || (body.body !== undefined && body.body !== page.body);
    const updated = await db.transaction(async (tx) => {
      const [p] = await tx
        .update(wikiPages)
        .set({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.viewMin ? { viewMin: body.viewMin } : {}),
          ...(body.editMin ? { editMin: body.editMin } : {}),
          ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
          ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
          updatedById: req.user.sub,
          updatedAt: new Date(),
        })
        .where(eq(wikiPages.id, page.id))
        .returning();
      if (contentChanged) {
        await tx.insert(wikiRevisions).values({ pageId: p.id, title: p.title, body: p.body, note: body.note, editedById: req.user.sub });
      }
      return p;
    });
    if (body.notify) await announce(req, updated, false, body.note);
    return updated;
  });

  /** Removes a page (admins). Its sub-pages move up a level. It's kept in the database and can be restored. */
  app.delete<{ Params: { id: string } }>("/pages/:id", { preHandler: requireRole("admin") }, async (req) => {
    const page = await loadPage(req, req.params.id);
    await db.transaction(async (tx) => {
      await tx.update(wikiPages).set({ parentId: page.parentId }).where(eq(wikiPages.parentId, page.id));
      await tx.update(wikiPages).set({ deletedAt: new Date(), updatedById: req.user.sub }).where(eq(wikiPages.id, page.id));
    });
    return { ok: true };
  });

  app.get("/deleted", { preHandler: requireRole("admin") }, async (req) => {
    const rows = await db
      .select({ id: wikiPages.id, title: wikiPages.title, deletedAt: wikiPages.deletedAt })
      .from(wikiPages)
      .where(eq(wikiPages.companyId, req.user.companyId));
    return rows.filter((r) => r.deletedAt).sort((a, b) => b.deletedAt!.getTime() - a.deletedAt!.getTime());
  });

  app.post<{ Params: { id: string } }>("/pages/:id/undelete", { preHandler: requireRole("admin") }, async (req) => {
    const [row] = await db
      .update(wikiPages)
      .set({ deletedAt: null, parentId: null, updatedAt: new Date(), updatedById: req.user.sub })
      .where(and(eq(wikiPages.id, req.params.id), eq(wikiPages.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Page");
    return row;
  });

  /** Version history: available to anyone who can edit the page. */
  app.get<{ Params: { id: string } }>("/pages/:id/revisions", async (req) => {
    const page = await loadPage(req, req.params.id);
    if (!canEdit(req, page)) throw new HttpError(403, "Only people who can edit this page can see its history");
    const rows = await db.select().from(wikiRevisions).where(eq(wikiRevisions.pageId, page.id)).orderBy(desc(wikiRevisions.createdAt));
    const who = await names(rows.map((r) => r.editedById));
    return rows.map((r) => ({ ...r, editedBy: r.editedById ? who.get(r.editedById) ?? null : null }));
  });

  app.post<{ Params: { id: string; revisionId: string } }>("/pages/:id/restore/:revisionId", async (req) => {
    const page = await loadPage(req, req.params.id);
    if (!canEdit(req, page)) throw new HttpError(403, "You can read this page but not edit it");
    const [rev] = await db
      .select()
      .from(wikiRevisions)
      .where(and(eq(wikiRevisions.id, req.params.revisionId), eq(wikiRevisions.pageId, page.id)));
    if (!rev) notFound("Version");
    return db.transaction(async (tx) => {
      const [p] = await tx
        .update(wikiPages)
        .set({ title: rev.title, body: rev.body, updatedById: req.user.sub, updatedAt: new Date() })
        .where(eq(wikiPages.id, page.id))
        .returning();
      await tx.insert(wikiRevisions).values({
        pageId: p.id,
        title: p.title,
        body: p.body,
        note: `Restored the version from ${rev.createdAt.toISOString().slice(0, 10)}`,
        editedById: req.user.sub,
      });
      return p;
    });
  });
};

export default routes;
