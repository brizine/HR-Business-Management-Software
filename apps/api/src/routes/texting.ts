import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { INACTIVE_STATUSES, TEXT_FILTERS, TEXT_SKIP_REASONS, TEXT_THREAD_STATUSES, customerName, formatPhone, textBodySchema, textGroupSchema, textSendSchema, toE164, type TextFilter } from "@crewdesk/shared";
import { db } from "../db";
import { companies, crewMembers, crews, customerTexts, customers, employees, pushTokens, textBatches, textGroupMembers, textGroups, textThreads } from "../db/schema";
import { authenticate, isManager, requireRole } from "../lib/auth";
import { customerInCompany } from "../lib/crm";
import { HttpError, parse } from "../lib/errors";
import { fillTemplateText, templateVars } from "../lib/templates";
import {
  connectTexting, disconnectTexting, markTextsRead, markThreadRead, queueTexts, receiveHook, requireTexting, sendCustomerText, sendStaffText, sendThreadText,
  textNumberFor, textTeam, textingConfig, textingNumbers, textingProvider, threadFor, type QueuedText,
} from "../lib/texting";
import { parseSelection, selectedIds } from "./customers";

const AREA = "customers" as const;
const PAGE = 25;
const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`.trim();

/** The provider calling about a new text (no sign-in: the call is checked against the company's signing secret). */
export const textingHookRoutes: FastifyPluginAsync = async (app) => {
  // The body exactly as sent is what's signed.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post<{ Params: { token: string } }>("/talkroute/:token", async (req, reply) => {
    const r = await receiveHook(req.params.token, req.headers, Buffer.isBuffer(req.body) ? req.body : Buffer.from(""));
    if (r === "unknown") return reply.status(404).send({ error: "Not found" });
    if (r === "bad-signature") return reply.status(401).send({ error: "Signature didn't match" });
    return { ok: true };
  });
};

/** Texting: the connection (Settings → Integrations), conversations, sending to one or many, groups, and who hears about new texts. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireTexting);
  const owner = { preHandler: requireRole("owner", AREA) };
  const admin = { preHandler: requireRole("admin", AREA) };
  const manager = { preHandler: requireRole("manager", AREA) };

  /* ── The connection ── */

  app.get("/settings", async (req) => {
    const { companyId } = req.user;
    const cfg = await textingConfig(companyId);
    const team = await textTeam(companyId);
    const people = team.ids.length ? await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName }).from(employees).where(inArray(employees.id, team.ids)).orderBy(asc(employees.firstName)) : [];
    return {
      available: textingProvider().ready, connected: !!cfg, provider: "talkroute",
      ...(cfg ? { fromNumber: cfg.fromNumber, connectedAt: cfg.connectedAt, accountName: cfg.accountName, webhook: cfg.webhook, hookAt: cfg.hookAt ?? null } : {}),
      // Who's told about texts that come in: the people picked, or (nobody picked) the managers.
      notify: { picked: team.picked, people: people.map((p) => ({ id: p.id, name: fullName(p) })) },
    };
  });

  /** The account's numbers that can text, to pick from before connecting. */
  app.post("/settings/numbers", owner, async (req) => {
    const { apiKey } = parse(z.object({ apiKey: z.string().trim().min(8, "Paste the API key from Talkroute").max(500) }), req.body);
    return { numbers: await textingNumbers(apiKey) };
  });

  app.put("/settings", owner, async (req) => {
    const body = parse(z.object({ apiKey: z.string().trim().min(8, "Paste the API key from Talkroute").max(500), fromNumber: z.string().trim().min(7).max(30) }), req.body);
    const r = await connectTexting(req.user.companyId, body.apiKey, body.fromNumber);
    return { ok: true, ...r };
  });

  app.delete("/settings", owner, async (req) => {
    await disconnectTexting(req.user.companyId);
    return { ok: true };
  });

  /** Everyone on the team, for picking who hears about new texts: whether they have the phone app signed in, and a mobile number. */
  app.get("/settings/people", admin, async (req) => {
    const { companyId } = req.user;
    const rows = await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, role: employees.role, phone: employees.phone }).from(employees)
      .where(and(eq(employees.companyId, companyId), notInArray(employees.status, INACTIVE_STATUSES))).orderBy(asc(employees.firstName), asc(employees.lastName));
    const phones = rows.length ? await db.selectDistinct({ id: pushTokens.employeeId }).from(pushTokens).where(inArray(pushTokens.employeeId, rows.map((r) => r.id))) : [];
    const hasApp = new Set(phones.map((p) => p.id));
    const [c] = await db.select({ ids: companies.textingNotifyIds }).from(companies).where(eq(companies.id, companyId));
    return { picked: c?.ids ?? [], people: rows.map((r) => ({ id: r.id, name: fullName(r), role: r.role, hasApp: hasApp.has(r.id) })) };
  });

  app.put("/settings/notify", admin, async (req) => {
    const { employeeIds } = parse(z.object({ employeeIds: z.array(z.string().uuid()).max(200) }), req.body);
    const { companyId } = req.user;
    const ok = employeeIds.length ? await db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, companyId), inArray(employees.id, employeeIds))) : [];
    await db.update(companies).set({ textingNotifyIds: ok.map((r) => r.id) }).where(eq(companies.id, companyId));
    return { ok: true, count: ok.length };
  });

  /** A test text to your own mobile number, to see the connection work end to end. */
  app.post("/settings/test", admin, async (req) => {
    const { companyId, sub } = req.user;
    const cfg = await textingConfig(companyId);
    if (!cfg) throw new HttpError(400, "Connect texting first");
    const [me] = await db.select({ phone: employees.phone }).from(employees).where(eq(employees.id, sub));
    const to = toE164(me?.phone);
    if (!to) throw new HttpError(400, "Add your mobile number to your profile first, so there's somewhere to send it");
    try { await textingProvider().send(cfg, to, "This is a test text from Crewdesk. Texting is connected."); }
    catch (e) { throw new HttpError(502, `It didn't go through: ${(e as Error).message}`); }
    return { ok: true, to: formatPhone(to) };
  });

  /* ── Conversations ── */

  /** How many conversations have something unread (the number on the chat bubble). */
  app.get("/unread", async (req) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(textThreads).where(and(eq(textThreads.companyId, req.user.companyId), sql`${textThreads.unread} > 0`));
    return { unread: r?.n ?? 0 };
  });

  type ThreadRow = { t: typeof textThreads.$inferSelect; c: typeof customers.$inferSelect | null; e: { firstName: string; lastName: string } | null };
  const shape = (r: ThreadRow, canSeeCustomers: boolean) => ({
    id: r.t.id, phone: r.t.phone,
    kind: r.c ? "customer" as const : r.e ? "employee" as const : "unknown" as const,
    name: r.c ? customerName(r.c) : r.e ? fullName(r.e) : null,
    // Someone picked to answer texts who isn't a Customers manager gets the name, not a way into the customer's page.
    customerId: canSeeCustomers ? r.t.customerId : null, employeeId: r.t.employeeId,
    status: r.t.status, unread: r.t.unread, optedOut: r.c?.textOptOutAt ?? null,
    last: { body: r.t.lastBody, direction: r.t.lastDirection, status: r.t.lastStatus, at: r.t.lastAt },
  });
  const threadRows = () => db.select({ t: textThreads, c: customers, e: { firstName: employees.firstName, lastName: employees.lastName } }).from(textThreads)
    .leftJoin(customers, eq(customers.id, textThreads.customerId)).leftJoin(employees, eq(employees.id, textThreads.employeeId));

  app.get<{ Querystring: { filter?: string; q?: string; page?: string } }>("/threads", async (req) => {
    const { companyId } = req.user;
    const filter: TextFilter = TEXT_FILTERS.includes(req.query.filter as TextFilter) ? (req.query.filter as TextFilter) : "all";
    const q = (req.query.q ?? "").trim().slice(0, 80);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const qDigits = q.replace(/\D/g, "");
    const where = and(
      eq(textThreads.companyId, companyId), sql`${textThreads.lastBody} <> ''`,
      filter === "unread" ? sql`${textThreads.unread} > 0` : filter === "open" ? eq(textThreads.status, "open") : filter === "done" ? eq(textThreads.status, "done") : undefined,
      q ? sql`(
        ${customers.firstName} || ' ' || coalesce(${customers.lastName}, '') ilike ${like} or ${customers.lastName} ilike ${like} or ${customers.companyName} ilike ${like}
        or ${employees.firstName} || ' ' || ${employees.lastName} ilike ${like}
        ${qDigits.length >= 3 ? sql`or ${textThreads.phone} like ${`%${qDigits}%`}` : sql``}
        or exists (select 1 from customer_texts x where x.thread_id = ${textThreads.id} and x.body ilike ${like})
      )` : undefined,
    );
    const rows = await threadRows().where(where).orderBy(desc(textThreads.lastAt)).limit(PAGE).offset((page - 1) * PAGE);
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(textThreads)
      .leftJoin(customers, eq(customers.id, textThreads.customerId)).leftJoin(employees, eq(employees.id, textThreads.employeeId)).where(where);
    const [{ unread }] = await db.select({ unread: sql<number>`count(*)::int` }).from(textThreads).where(and(eq(textThreads.companyId, companyId), sql`${textThreads.unread} > 0`));
    const canSee = isManager(req, AREA);
    return { total, page, pageSize: PAGE, unread, threads: rows.map((r) => shape(r, canSee)) };
  });

  const oneThread = async (companyId: string, id: string) => {
    const [r] = await threadRows().where(and(eq(textThreads.id, id), eq(textThreads.companyId, companyId)));
    if (!r) throw new HttpError(404, "Conversation not found");
    return r;
  };
  const textsOf = async (threadId: string) => {
    const rows = await db.select({ t: customerTexts, by: sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}` }).from(customerTexts)
      .leftJoin(employees, eq(employees.id, customerTexts.sentById))
      .where(eq(customerTexts.threadId, threadId)).orderBy(desc(customerTexts.createdAt)).limit(300);
    return rows.reverse().map(({ t, by }) => ({ id: t.id, direction: t.direction, body: t.body, status: t.status, error: t.error, source: t.source, by, at: t.createdAt }));
  };

  /** A conversation's texts (oldest first). Opening it marks its replies read, unless `peek` is set. */
  app.get<{ Params: { id: string }; Querystring: { peek?: string } }>("/threads/:id", async (req) => {
    const { companyId } = req.user;
    const r = await oneThread(companyId, req.params.id);
    if (req.query.peek !== "1" && r.t.unread > 0) { await markThreadRead(companyId, r.t.id); r.t.unread = 0; }
    const cfg = await textingConfig(companyId);
    return { ...shape(r, isManager(req, AREA)), connected: !!cfg, fromNumber: cfg?.fromNumber ?? null, texts: await textsOf(r.t.id) };
  });

  app.post<{ Params: { id: string } }>("/threads/:id", async (req) => {
    const { body } = parse(textBodySchema, req.body);
    const { companyId, sub } = req.user;
    const r = await oneThread(companyId, req.params.id);
    // Tags are filled in for the customer the conversation is with.
    const filled = /\{\{/.test(body) ? fillTemplateText(body, await templateVars(companyId, { customerId: r.t.customerId })) : body;
    if (!filled) throw new HttpError(400, "Write the text");
    const sent = await sendThreadText(companyId, r.t.id, filled, { by: sub });
    if (!sent.text) throw new HttpError(400, sent.skipped ?? "It couldn't be sent");
    if (sent.text.status === "failed") throw new HttpError(502, `It didn't go through: ${sent.text.error ?? "the texting service said no"}`);
    await markThreadRead(companyId, r.t.id);
    return { id: sent.text.id, status: sent.text.status };
  });

  app.post<{ Params: { id: string } }>("/threads/:id/unread", async (req) => {
    const r = await oneThread(req.user.companyId, req.params.id);
    await db.update(textThreads).set({ unread: sql`greatest(${textThreads.unread}, 1)` }).where(eq(textThreads.id, r.t.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/threads/:id/status", async (req) => {
    const { status } = parse(z.object({ status: z.enum(TEXT_THREAD_STATUSES) }), req.body);
    const r = await oneThread(req.user.companyId, req.params.id);
    await db.update(textThreads).set({ status, ...(status === "done" ? { unread: 0 } : {}) }).where(eq(textThreads.id, r.t.id));
    if (status === "done") await markThreadRead(req.user.companyId, r.t.id);
    return { ok: true };
  });

  /** Homeworks' "Delete Messages": the conversation and its texts are removed from Crewdesk (they stay in Talkroute). */
  app.delete<{ Params: { id: string } }>("/threads/:id", admin, async (req) => {
    const r = await oneThread(req.user.companyId, req.params.id);
    await db.delete(textThreads).where(eq(textThreads.id, r.t.id));
    return { ok: true };
  });

  /** Starts (or finds) the conversation with a customer, someone on the team, or a typed number. */
  app.post("/threads/open", async (req) => {
    const b = parse(z.object({ customerId: z.string().uuid().optional(), employeeId: z.string().uuid().optional(), phone: z.string().trim().max(30).optional() }), req.body);
    const { companyId } = req.user;
    if (b.customerId) {
      const c = await customerInCompany(db, companyId, b.customerId);
      const to = textNumberFor(c);
      if (!to) throw new HttpError(400, `${customerName(c)} has no mobile number on file`);
      return { id: (await threadFor(companyId, to, { customerId: c.id })).id };
    }
    if (b.employeeId) {
      const [e] = await db.select().from(employees).where(and(eq(employees.id, b.employeeId), eq(employees.companyId, companyId)));
      if (!e) throw new HttpError(404, "Employee not found");
      const to = toE164(e.phone);
      if (!to) throw new HttpError(400, `${fullName(e)} has no mobile number on file`);
      return { id: (await threadFor(companyId, to, { employeeId: e.id })).id };
    }
    const to = toE164(b.phone);
    if (!to) throw new HttpError(400, "Enter a mobile number with its area code");
    return { id: (await threadFor(companyId, to)).id };
  });

  /* ── A customer's texts, on their page (Customers & billing managers) ── */

  app.get<{ Params: { id: string } }>("/customers/:id", manager, async (req) => {
    const { companyId } = req.user;
    const c = await customerInCompany(db, companyId, req.params.id);
    await markTextsRead(companyId, c.id);
    const texts = await db.select({ t: customerTexts, by: sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}` }).from(customerTexts)
      .leftJoin(employees, eq(employees.id, customerTexts.sentById))
      .where(and(eq(customerTexts.companyId, companyId), eq(customerTexts.customerId, c.id), sql`${customerTexts.status} <> 'queued'`)).orderBy(desc(customerTexts.createdAt)).limit(200);
    const cfg = await textingConfig(companyId);
    return {
      connected: !!cfg, number: textNumberFor(c), optedOut: c.textOptOutAt,
      texts: texts.reverse().map(({ t, by }) => ({ id: t.id, direction: t.direction, body: t.body, status: t.status, error: t.error, source: t.source, by, at: t.createdAt })),
    };
  });

  app.post<{ Params: { id: string } }>("/customers/:id", manager, async (req) => {
    const { body } = parse(textBodySchema, req.body);
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const r = await sendCustomerText(req.user.companyId, c.id, body, { by: req.user.sub, source: "office" });
    if (!r.text) throw new HttpError(400, r.skipped ?? "It couldn't be sent");
    if (r.text.status === "failed") throw new HttpError(502, `It didn't go through: ${r.text.error ?? "the texting service said no"}`);
    // Answering them means their texts have been read.
    await markTextsRead(req.user.companyId, c.id);
    return r.text;
  });

  /** A conversation with a number that isn't anyone's yet: file it under a customer. */
  app.post("/assign", manager, async (req) => {
    const body = parse(z.object({ phone: z.string().max(30), customerId: z.string().uuid() }), req.body);
    const c = await customerInCompany(db, req.user.companyId, body.customerId);
    const phone = toE164(body.phone) ?? body.phone;
    await db.update(customerTexts).set({ customerId: c.id }).where(and(eq(customerTexts.companyId, req.user.companyId), eq(customerTexts.phone, phone), isNull(customerTexts.customerId)));
    await db.update(textThreads).set({ customerId: c.id, employeeId: null }).where(and(eq(textThreads.companyId, req.user.companyId), eq(textThreads.phone, phone)));
    return { ok: true };
  });

  /* ── Send Text Messages: who it can go to ── */

  /** The pick lists on the Send Text Messages tab: customers (searched), the team, crews and groups, each with whether they can be texted. */
  app.get<{ Querystring: { kind?: string; q?: string } }>("/recipients", async (req) => {
    const { companyId } = req.user;
    const q = (req.query.q ?? "").trim().slice(0, 80);
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    if (req.query.kind === "employees") {
      const rows = await db.select().from(employees).where(and(eq(employees.companyId, companyId), notInArray(employees.status, INACTIVE_STATUSES),
        q ? sql`${employees.firstName} || ' ' || ${employees.lastName} ilike ${like}` : undefined)).orderBy(asc(employees.firstName), asc(employees.lastName)).limit(200);
      return { rows: rows.map((e) => ({ id: e.id, name: fullName(e), detail: toE164(e.phone) ? formatPhone(e.phone) : "No mobile number", ok: !!toE164(e.phone) })) };
    }
    if (req.query.kind === "crews") {
      const rows = await db.select({ id: crews.id, name: crews.name, n: sql<number>`(select count(*)::int from crew_members m where m.crew_id = "crews"."id")` }).from(crews)
        .where(and(eq(crews.companyId, companyId), eq(crews.active, true), q ? sql`${crews.name} ilike ${like}` : undefined)).orderBy(asc(crews.name));
      return { rows: rows.map((c) => ({ id: c.id, name: c.name, detail: `${c.n} ${c.n === 1 ? "person" : "people"}`, ok: c.n > 0 })) };
    }
    if (req.query.kind === "groups") {
      const rows = await db.select({ id: textGroups.id, name: textGroups.name, n: sql<number>`(select count(*)::int from text_group_members m where m.group_id = "text_groups"."id")` }).from(textGroups)
        .where(and(eq(textGroups.companyId, companyId), q ? sql`${textGroups.name} ilike ${like}` : undefined)).orderBy(asc(textGroups.name));
      return { rows: rows.map((g) => ({ id: g.id, name: g.name, detail: `${g.n} ${g.n === 1 ? "member" : "members"}`, ok: g.n > 0 })) };
    }
    const rows = await db.select().from(customers).where(and(eq(customers.companyId, companyId), sql`${customers.status} <> 'cancelled'`,
      q ? sql`(${customers.firstName} || ' ' || coalesce(${customers.lastName}, '') ilike ${like} or ${customers.lastName} ilike ${like} or ${customers.companyName} ilike ${like} or ${customers.phone} ilike ${like})` : undefined))
      .orderBy(asc(customers.lastName), asc(customers.firstName)).limit(q ? 50 : 30);
    return { rows: rows.map((c) => ({ id: c.id, name: customerName(c), detail: c.textOptOutAt ? "Replied STOP" : textNumberFor(c) ? formatPhone(textNumberFor(c)!) : "No mobile number", ok: !c.textOptOutAt && !!textNumberFor(c) })) };
  });

  /* ── Groups ── */

  const groupIn = async (companyId: string, id: string) => {
    const [g] = await db.select().from(textGroups).where(and(eq(textGroups.id, id), eq(textGroups.companyId, companyId)));
    if (!g) throw new HttpError(404, "Group not found");
    return g;
  };
  const nameTaken = (e: unknown) => ((e as { code?: string; cause?: { code?: string } }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505" ? new HttpError(400, "There's already a group with that name") : e);

  app.post("/groups", async (req) => {
    const { name } = parse(textGroupSchema, req.body);
    try { const [g] = await db.insert(textGroups).values({ companyId: req.user.companyId, name }).returning(); return g; } catch (e) { throw nameTaken(e); }
  });
  app.put<{ Params: { id: string } }>("/groups/:id", async (req) => {
    const { name } = parse(textGroupSchema, req.body);
    const g = await groupIn(req.user.companyId, req.params.id);
    try { const [u] = await db.update(textGroups).set({ name }).where(eq(textGroups.id, g.id)).returning(); return u; } catch (e) { throw nameTaken(e); }
  });
  app.delete<{ Params: { id: string } }>("/groups/:id", async (req) => {
    const g = await groupIn(req.user.companyId, req.params.id);
    await db.delete(textGroups).where(eq(textGroups.id, g.id));
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>("/groups/:id", async (req) => {
    const g = await groupIn(req.user.companyId, req.params.id);
    const rows = await db.select({ m: textGroupMembers, c: customers, e: { firstName: employees.firstName, lastName: employees.lastName, phone: employees.phone } }).from(textGroupMembers)
      .leftJoin(customers, eq(customers.id, textGroupMembers.customerId)).leftJoin(employees, eq(employees.id, textGroupMembers.employeeId))
      .where(eq(textGroupMembers.groupId, g.id)).orderBy(asc(textGroupMembers.createdAt));
    return {
      ...g,
      members: rows.map((r) => ({
        id: r.m.id, kind: r.c ? "customer" : "employee", name: r.c ? customerName(r.c) : r.e ? fullName(r.e) : "Removed",
        detail: r.c ? (r.c.textOptOutAt ? "Replied STOP" : textNumberFor(r.c) ? formatPhone(textNumberFor(r.c)!) : "No mobile number") : toE164(r.e?.phone) ? formatPhone(r.e!.phone) : "No mobile number",
      })),
    };
  });
  app.post<{ Params: { id: string } }>("/groups/:id/members", async (req) => {
    const b = parse(z.object({ customerId: z.string().uuid().optional(), employeeId: z.string().uuid().optional() }).refine((x) => !!x.customerId !== !!x.employeeId, "Pick a customer or an employee"), req.body);
    const { companyId } = req.user;
    const g = await groupIn(companyId, req.params.id);
    if (b.customerId) await customerInCompany(db, companyId, b.customerId);
    else if (!(await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, b.employeeId!), eq(employees.companyId, companyId))))[0]) throw new HttpError(404, "Employee not found");
    await db.insert(textGroupMembers).values({ groupId: g.id, customerId: b.customerId ?? null, employeeId: b.employeeId ?? null }).onConflictDoNothing();
    return { ok: true };
  });
  app.delete<{ Params: { id: string; memberId: string } }>("/groups/:id/members/:memberId", async (req) => {
    const g = await groupIn(req.user.companyId, req.params.id);
    await db.delete(textGroupMembers).where(and(eq(textGroupMembers.id, req.params.memberId), eq(textGroupMembers.groupId, g.id)));
    return { ok: true };
  });

  /* ── Sending to one or many ── */

  /**
   * Sends a text to any mix of customers, employees, groups, crews and typed numbers (and, from the
   * Customers page, the customers ticked or all that match the list). One person: it goes now.
   * More: they're lined up and go out a few a minute. Tags are filled in for each customer.
   */
  app.post("/send", async (req) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const b = parse(textSendSchema, raw);
    const { companyId, sub } = req.user;
    if (!(await textingConfig(companyId))) throw new HttpError(400, "Texting isn't connected yet (Settings → Integrations)");
    // The Customers page sends its own selection (ticked rows, or everyone the list's filters match).
    const listed = raw.ids || raw.match ? await selectedIds(companyId, parseSelection(raw)) : [];
    if (listed.length && !isManager(req, AREA)) throw new HttpError(403, "You do not have permission to do that");

    const groups = b.groupIds.length ? await db.select().from(textGroups).where(and(eq(textGroups.companyId, companyId), inArray(textGroups.id, b.groupIds))) : [];
    const members = groups.length ? await db.select().from(textGroupMembers).where(inArray(textGroupMembers.groupId, groups.map((g) => g.id))) : [];
    const crewRows = b.crewIds.length ? await db.select().from(crews).where(and(eq(crews.companyId, companyId), inArray(crews.id, b.crewIds))) : [];
    const crewPeople = crewRows.length ? await db.select().from(crewMembers).where(inArray(crewMembers.crewId, crewRows.map((c) => c.id))) : [];
    const customerIds = [...new Set([...b.customerIds, ...listed, ...members.map((m) => m.customerId).filter((x): x is string => !!x)])];
    const employeeIds = [...new Set([...b.employeeIds, ...members.map((m) => m.employeeId).filter((x): x is string => !!x), ...crewPeople.map((m) => m.employeeId)])];

    const texts: QueuedText[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const seen = new Set<string>();
    const add = (phone: string, t: Omit<QueuedText, "phone">, name: string) => { if (seen.has(phone)) { skipped.push({ name, reason: TEXT_SKIP_REASONS.duplicate }); return; } seen.add(phone); texts.push({ phone, ...t }); };
    const tagged = /\{\{/.test(b.body);
    const companyVars = tagged ? await templateVars(companyId, {}) : {};
    const companyOnly = tagged ? fillTemplateText(b.body, companyVars) : b.body;
    for (let i = 0; i < customerIds.length; i += 500) {
      const rows = await db.select().from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, customerIds.slice(i, i + 500))));
      for (const c of rows) {
        const name = customerName(c), to = textNumberFor(c);
        if (c.sample && customerIds.length > 1) { skipped.push({ name, reason: TEXT_SKIP_REASONS.sample }); continue; }
        if (c.textOptOutAt) { skipped.push({ name, reason: TEXT_SKIP_REASONS.opted_out }); continue; }
        if (!to) { skipped.push({ name, reason: TEXT_SKIP_REASONS.no_number }); continue; }
        add(to, { customerId: c.id, body: tagged ? fillTemplateText(b.body, await templateVars(companyId, { customerId: c.id })) : b.body }, name);
      }
    }
    const staff = employeeIds.length ? await db.select().from(employees).where(and(eq(employees.companyId, companyId), inArray(employees.id, employeeIds), notInArray(employees.status, INACTIVE_STATUSES))) : [];
    for (const e of staff) {
      const to = toE164(e.phone);
      if (!to) { skipped.push({ name: fullName(e), reason: TEXT_SKIP_REASONS.no_number }); continue; }
      // Someone on the team gets their own name where a customer's would go.
      add(to, { employeeId: e.id, body: tagged ? fillTemplateText(b.body, { ...companyVars, CUSTOMER_NAME: fullName(e), CUSTOMER_FIRST_NAME: e.firstName, CUSTOMER_LAST_NAME: e.lastName }) : b.body }, fullName(e));
    }
    for (const p of b.phones) {
      const to = toE164(p);
      if (!to) { skipped.push({ name: p, reason: "Not a mobile number with its area code" }); continue; }
      add(to, { body: companyOnly }, formatPhone(to));
    }
    if (texts.some((t) => !t.body.trim())) throw new HttpError(400, "Write the text");
    if (!texts.length) throw new HttpError(400, skipped.length ? `Nobody on it can be texted: ${skipped.slice(0, 3).map((s) => `${s.name} (${s.reason.toLowerCase()})`).join(", ")}${skipped.length > 3 ? "…" : ""}` : "Pick who it goes to");

    if (texts.length === 1) {
      // One person: send it now, and say plainly if it didn't go.
      const t = texts[0];
      if (t.customerId) {
        const r = await sendCustomerText(companyId, t.customerId, t.body, { by: sub, source: "office" });
        if (!r.text) throw new HttpError(400, r.skipped ?? "It couldn't be sent");
        if (r.text.status === "failed") throw new HttpError(502, `It didn't go through: ${r.text.error ?? "the texting service said no"}`);
        return { sent: 1, queued: 0, skipped, threadId: r.text.threadId };
      }
      const r = await sendStaffText(companyId, t.phone, t.body, { by: sub, employeeId: t.employeeId ?? null, source: "office" });
      if (!r.sent) throw new HttpError(r.error ? 502 : 400, r.error ? `It didn't go through: ${r.error}` : r.skipped ?? "It couldn't be sent");
      return { sent: 1, queued: 0, skipped, threadId: (await threadFor(companyId, t.phone)).id };
    }
    const label = [
      groups.length ? `${groups.length === 1 ? "Group" : "Groups"}: ${groups.map((g) => g.name).join(", ")}` : null,
      crewRows.length ? `${crewRows.length === 1 ? "Crew" : "Crews"}: ${crewRows.map((c) => c.name).join(", ")}` : null,
      typeof raw.audience === "string" && raw.audience.trim() ? raw.audience.trim().slice(0, 160) : null,
    ].filter(Boolean).join(" · ") || `${texts.length} people`;
    const batch = await queueTexts(companyId, { body: b.body, label, by: sub, texts, skipped });
    return { sent: 0, queued: texts.length, skipped, batchId: batch.id };
  });

  /** Messages History: sends to many, newest first, with how each is going. */
  app.get("/batches", async (req) => {
    const { companyId } = req.user;
    const rows = await db.select({ b: textBatches, by: sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}` }).from(textBatches)
      .leftJoin(employees, eq(employees.id, textBatches.createdById)).where(eq(textBatches.companyId, companyId)).orderBy(desc(textBatches.createdAt)).limit(30);
    const counts = rows.length ? await db.select({ id: customerTexts.batchId, status: customerTexts.status, n: sql<number>`count(*)::int` }).from(customerTexts)
      .where(inArray(customerTexts.batchId, rows.map((r) => r.b.id))).groupBy(customerTexts.batchId, customerTexts.status) : [];
    const count = (id: string, ...statuses: string[]) => counts.filter((c) => c.id === id && statuses.includes(c.status)).reduce((n, c) => n + c.n, 0);
    return {
      rows: rows.map(({ b, by }) => ({
        id: b.id, at: b.createdAt, by, label: b.label, body: b.body, total: b.total, stopped: !!b.stoppedAt,
        sent: count(b.id, "sent", "delivered"), failed: count(b.id, "failed"), waiting: count(b.id, "queued", "sending"), skipped: b.skipped,
      })),
    };
  });

  /** Stops a send that's still going: the texts not sent yet are dropped. */
  app.post<{ Params: { id: string } }>("/batches/:id/stop", async (req) => {
    const { companyId } = req.user;
    const [b] = await db.select().from(textBatches).where(and(eq(textBatches.id, req.params.id), eq(textBatches.companyId, companyId)));
    if (!b) throw new HttpError(404, "Not found");
    await db.update(textBatches).set({ stoppedAt: new Date() }).where(eq(textBatches.id, b.id));
    const dropped = await db.delete(customerTexts).where(and(eq(customerTexts.batchId, b.id), eq(customerTexts.status, "queued"))).returning({ id: customerTexts.id });
    return { ok: true, dropped: dropped.length };
  });

  /** Error Log: texts that didn't go, newest first (date, what went wrong, the number). */
  app.get("/errors", async (req) => {
    const { companyId } = req.user;
    const rows = await db.select({ t: customerTexts, c: customers, e: { firstName: employees.firstName, lastName: employees.lastName } }).from(customerTexts)
      .leftJoin(customers, eq(customers.id, customerTexts.customerId)).leftJoin(employees, eq(employees.id, customerTexts.employeeId))
      .where(and(eq(customerTexts.companyId, companyId), eq(customerTexts.status, "failed"))).orderBy(desc(customerTexts.createdAt)).limit(200);
    return { rows: rows.map((r) => ({ id: r.t.id, at: r.t.createdAt, error: r.t.error ?? "Not sent", phone: r.t.phone, name: r.c ? customerName(r.c) : r.e ? fullName(r.e) : null, threadId: r.t.threadId, body: r.t.body.slice(0, 160) })) };
  });
};

export default routes;
