import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  INACTIVE_STATUSES, TEXT_FILTERS, TEXT_HISTORY_DAYS, TEXT_MAX, TEXT_MEDIA_MAX_BYTES, TEXT_MEDIA_TYPES, TEXT_SKIP_REASONS, TEXT_THREAD_STATUSES, customerName, formatPhone, textBodySchema, textGroupSchema,
  textQuickReplySchema, textQuietSchema, textSendSchema, textingChoices, textingOptionsSchema, toE164, hasRole, type TextFilter,
} from "@crewdesk/shared";
import { db } from "../db";
import { companies, crewMembers, crews, customerTexts, customers, employees, phoneCalls, properties, propertyAssignments, pushTokens, textBatches, textGroupMembers, textGroups, textMedia, textQuickReplies, textThreads } from "../db/schema";
import { authenticate, isManager, requireRole, roleIn } from "../lib/auth";
import { customerInCompany } from "../lib/crm";
import { HttpError, parse } from "../lib/errors";
import { storage } from "../lib/storage";
import { fillTemplateText, templateVars } from "../lib/templates";
import {
  addTextNote, assignThread, connectTexting, disconnectTexting, markTextsRead, markThreadRead, mediaFor, queueTexts, receiveHook, requireTexting, sendCustomerText, sendStaffText, sendThreadText,
  startContactsCopy, startHistoryImport, textNumberFor, textPeople, textTeam, textingConfig, textingNumbers, textingProvider, threadFor, todoFromThread, type HookKind, type QueuedText,
} from "../lib/texting";
import { parseSelection, selectedIds } from "./customers";

const AREA = "customers" as const;
const PAGE = 25;
const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`.trim();
const isAdmin = (req: FastifyRequest) => hasRole(roleIn(req, AREA), "admin");

/** The provider calling about a new text (no sign-in: the call is checked against the company's signing secret). */
export const textingHookRoutes: FastifyPluginAsync = async (app) => {
  // The body exactly as sent is what's signed.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  const handle = async (token: string, kind: HookKind, req: { headers: Record<string, unknown>; body: unknown }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    const r = await receiveHook(token, kind, req.headers, Buffer.isBuffer(req.body) ? req.body : Buffer.from(""));
    if (r === "unknown") return reply.status(404).send({ error: "Not found" });
    if (r === "bad-signature") return reply.status(401).send({ error: "Signature didn't match" });
    return { ok: true };
  };
  app.post<{ Params: { token: string } }>("/talkroute/:token", (req, reply) => handle(req.params.token, "text", req, reply));
  // Calls and voicemails come to addresses of their own (each is signed with its own secret).
  app.post<{ Params: { token: string; kind: string } }>("/talkroute/:token/:kind", (req, reply) =>
    req.params.kind === "call" || req.params.kind === "voicemail" ? handle(req.params.token, req.params.kind, req, reply) : reply.status(404).send({ error: "Not found" }));
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
    const { companyId, sub } = req.user;
    const cfg = await textingConfig(companyId);
    const team = await textTeam(companyId);
    const people = team.ids.length ? await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName }).from(employees).where(inArray(employees.id, team.ids)).orderBy(asc(employees.firstName)) : [];
    const [co] = await db.select({ o: companies.textingOptions, tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
    const [me] = await db.select({ q: employees.textQuiet }).from(employees).where(eq(employees.id, sub));
    return {
      available: textingProvider().ready, connected: !!cfg, provider: "talkroute",
      ...(cfg ? { fromNumber: cfg.fromNumber, connectedAt: cfg.connectedAt, accountName: cfg.accountName, webhook: cfg.webhook, calls: cfg.calls, hookAt: cfg.hookAt ?? null } : {}),
      // The office's choices (after-hours reply, missed-call text), and how the long jobs are going.
      options: textingChoices(co?.o), history: co?.o?.history ?? null, contacts: co?.o?.contacts ?? null, timezone: co?.tz ?? "America/Chicago",
      myQuiet: me?.q ?? null,
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
    const rows = await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, role: employees.role, phone: employees.phone, quiet: employees.textQuiet }).from(employees)
      .where(and(eq(employees.companyId, companyId), notInArray(employees.status, INACTIVE_STATUSES))).orderBy(asc(employees.firstName), asc(employees.lastName));
    const phones = rows.length ? await db.selectDistinct({ id: pushTokens.employeeId }).from(pushTokens).where(inArray(pushTokens.employeeId, rows.map((r) => r.id))) : [];
    const hasApp = new Set(phones.map((p) => p.id));
    const [c] = await db.select({ ids: companies.textingNotifyIds }).from(companies).where(eq(companies.id, companyId));
    return { picked: c?.ids ?? [], people: rows.map((r) => ({ id: r.id, name: fullName(r), role: r.role, hasApp: hasApp.has(r.id), quiet: r.quiet ?? null })) };
  });

  /** The after-hours reply and the missed-call text. */
  app.put("/settings/options", admin, async (req) => {
    const body = parse(textingOptionsSchema, req.body);
    await db.update(companies).set({ textingOptions: sql`coalesce(${companies.textingOptions}, '{}'::jsonb) || ${JSON.stringify(body)}::jsonb` }).where(eq(companies.id, req.user.companyId));
    return { ok: true };
  });

  /** Quiet hours for incoming-text notifications: your own, or (admins) someone else's. */
  app.put("/settings/quiet", async (req) => {
    const b = parse(z.object({ employeeId: z.string().uuid().optional(), quiet: textQuietSchema }), req.body);
    const { companyId, sub } = req.user;
    const id = b.employeeId ?? sub;
    if (id !== sub && !isAdmin(req)) throw new HttpError(403, "You do not have permission to do that");
    const done = await db.update(employees).set({ textQuiet: b.quiet }).where(and(eq(employees.id, id), eq(employees.companyId, companyId))).returning({ id: employees.id });
    if (!done.length) throw new HttpError(404, "Employee not found");
    return { ok: true };
  });

  /** Bring in past conversations from Talkroute (as history: nobody is told, nothing is unread). */
  app.post("/settings/history", admin, async (req) => {
    const { days } = parse(z.object({ days: z.number().int().refine((d) => (TEXT_HISTORY_DAYS as readonly number[]).includes(d), "Pick 30, 90 or 365 days") }), req.body);
    return startHistoryImport(req.user.companyId, days);
  });

  /** Copy customers into Talkroute's contacts, so their names show in its apps. */
  app.post("/settings/contacts", admin, async (req) => startContactsCopy(req.user.companyId));

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
    status: r.t.status, unread: r.t.unread, optedOut: r.c?.textOptOutAt ?? null, assignedId: r.t.assignedId,
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
      filter === "unread" ? sql`${textThreads.unread} > 0` : filter === "open" ? eq(textThreads.status, "open") : filter === "done" ? eq(textThreads.status, "done")
        : filter === "mine" ? eq(textThreads.assignedId, req.user.sub) : undefined,
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
    const names = new Map((await textPeople(companyId)).map((p) => [p.id, p.name]));
    return { total, page, pageSize: PAGE, unread, threads: rows.map((r) => ({ ...shape(r, canSee), assignedName: r.t.assignedId ? names.get(r.t.assignedId) ?? null : null })) };
  });

  /** Who a conversation can be given to: everyone who answers texts. */
  app.get("/people", async (req) => ({ people: (await textPeople(req.user.companyId)).map((p) => ({ id: p.id, name: p.name })), me: req.user.sub }));

  const oneThread = async (companyId: string, id: string) => {
    const [r] = await threadRows().where(and(eq(textThreads.id, id), eq(textThreads.companyId, companyId)));
    if (!r) throw new HttpError(404, "Conversation not found");
    return r;
  };
  const textsOf = async (threadId: string) => {
    const rows = await db.select({ t: customerTexts, by: sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}` }).from(customerTexts)
      .leftJoin(employees, eq(employees.id, customerTexts.sentById))
      .where(and(eq(customerTexts.threadId, threadId), sql`${customerTexts.status} <> 'queued'`))
      // In the order they were said; ones still waiting to go come last, by when they'll go.
      .orderBy(desc(sql`case when ${customerTexts.status} = 'scheduled' then ${customerTexts.sendAt} else ${customerTexts.createdAt} end`), desc(customerTexts.createdAt)).limit(300);
    const media = await mediaFor(rows.map((r) => r.t.id));
    return rows.reverse().map(({ t, by }) => ({ id: t.id, direction: t.direction, body: t.body, status: t.status, error: t.error, source: t.source, by, at: t.createdAt, sendAt: t.sendAt, media: media.get(t.id) ?? [] }));
  };

  /** A conversation's texts (oldest first). Opening it marks its replies read, unless `peek` is set. */
  app.get<{ Params: { id: string }; Querystring: { peek?: string } }>("/threads/:id", async (req) => {
    const { companyId } = req.user;
    const r = await oneThread(companyId, req.params.id);
    if (req.query.peek !== "1" && r.t.unread > 0) { await markThreadRead(companyId, r.t.id); r.t.unread = 0; }
    const cfg = await textingConfig(companyId);
    return { ...shape(r, isManager(req, AREA)), connected: !!cfg, fromNumber: cfg?.fromNumber ?? null, texts: await textsOf(r.t.id) };
  });

  /** Tags in a reply are filled in for the customer the conversation is with. */
  const filledFor = async (companyId: string, customerId: string | null, body: string) => (/\{\{/.test(body) ? fillTemplateText(body, await templateVars(companyId, { customerId })) : body);
  const mustHaveGone = (sent: Awaited<ReturnType<typeof sendThreadText>>) => {
    if (!sent.text) throw new HttpError(400, sent.skipped ?? "It couldn't be sent");
    if (sent.text.status === "failed") throw new HttpError(502, `It didn't go through: ${sent.text.error ?? "the texting service said no"}`);
    return sent.text;
  };

  /** A reply: sent now, or (with sendAt) written to go later. */
  app.post<{ Params: { id: string } }>("/threads/:id", async (req) => {
    const { body, sendAt } = parse(textBodySchema.extend({ sendAt: z.string().datetime({ offset: true }).nullish() }), req.body);
    const { companyId, sub } = req.user;
    const r = await oneThread(companyId, req.params.id);
    const filled = await filledFor(companyId, r.t.customerId, body);
    if (!filled) throw new HttpError(400, "Write the text");
    const later = sendAt ? new Date(sendAt) : null;
    if (later && +later < Date.now() + 60_000) throw new HttpError(400, "Pick a time at least a minute from now");
    if (later && +later > Date.now() + 366 * 86_400_000) throw new HttpError(400, "Pick a time within the next year");
    const text = mustHaveGone(await sendThreadText(companyId, r.t.id, filled, { by: sub, sendAt: later }));
    await markThreadRead(companyId, r.t.id);
    return { id: text.id, status: text.status, sendAt: text.sendAt };
  });

  /** A picture (with words, if any): one JPG, PNG or GIF, small enough for carriers to pass along. */
  app.post<{ Params: { id: string } }>("/threads/:id/picture", async (req) => {
    const { companyId, sub } = req.user;
    const r = await oneThread(companyId, req.params.id);
    const file = await req.file();
    if (!file) throw new HttpError(400, "No picture uploaded");
    if (!(TEXT_MEDIA_TYPES as readonly string[]).includes(file.mimetype)) throw new HttpError(400, "Send a JPG, PNG or GIF picture");
    let data: Buffer;
    try { data = await file.toBuffer(); } catch { throw new HttpError(400, "That picture is too big to text"); }
    if (data.length > TEXT_MEDIA_MAX_BYTES || file.file.truncated) throw new HttpError(400, `That picture is too big to text (over ${(TEXT_MEDIA_MAX_BYTES / 1_000_000).toFixed(1)} MB). Try a smaller one.`);
    const captionField = file.fields?.body as { value?: unknown } | undefined;
    const caption = typeof captionField?.value === "string" ? captionField.value.trim().slice(0, TEXT_MAX) : "";
    const text = mustHaveGone(await sendThreadText(companyId, r.t.id, await filledFor(companyId, r.t.customerId, caption), { by: sub, picture: { contentType: file.mimetype, data, fileName: (file.filename || "picture").replace(/[^\w.\- ]/g, "_").slice(0, 120) } }));
    await markThreadRead(companyId, r.t.id);
    return { id: text.id, status: text.status };
  });

  /** The office's own note in the conversation: never sent. */
  app.post<{ Params: { id: string } }>("/threads/:id/note", async (req) => {
    const { body } = parse(textBodySchema, req.body);
    const note = await addTextNote(req.user.companyId, req.params.id, body, req.user.sub);
    return { id: note.id };
  });

  /** Gives the conversation to one person to answer (or back to everyone, with employeeId null). */
  app.post<{ Params: { id: string } }>("/threads/:id/assign", async (req) => {
    const { employeeId } = parse(z.object({ employeeId: z.string().uuid().nullable() }), req.body);
    await assignThread(req.user.companyId, req.params.id, employeeId, req.user.sub);
    return { ok: true };
  });

  /** Makes a to-do out of the conversation (its latest text, or the one picked), for you, due today. */
  app.post<{ Params: { id: string } }>("/threads/:id/todo", async (req) => {
    const { textId } = parse(z.object({ textId: z.string().uuid().nullish() }), req.body ?? {});
    const t = await todoFromThread(req.user.companyId, req.params.id, req.user.sub, textId);
    return { id: t.id, title: t.title };
  });

  /** Takes back a text that hasn't gone yet (one written to go later). */
  app.delete<{ Params: { id: string } }>("/texts/:id", async (req) => {
    const gone = await db.delete(customerTexts).where(and(eq(customerTexts.id, req.params.id), eq(customerTexts.companyId, req.user.companyId), eq(customerTexts.status, "scheduled"))).returning({ id: customerTexts.id });
    if (!gone.length) throw new HttpError(400, "That text has already gone (or been taken back)");
    return { ok: true };
  });

  /** A picture on a text. */
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/media/:id", async (req, reply) => {
    const [m] = await db.select().from(textMedia).where(and(eq(textMedia.id, req.params.id), eq(textMedia.companyId, req.user.companyId)));
    if (!m) throw new HttpError(404, "Picture not found");
    // Only kinds a browser shows safely are shown in place; anything else downloads.
    const inline = /^image\/(jpeg|png|gif|webp)$/.test(m.contentType) && req.query.download !== "1";
    reply.header("Content-Type", inline ? m.contentType : "application/octet-stream");
    reply.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${m.fileName.replace(/"/g, "")}"`);
    reply.header("Cache-Control", "private, max-age=3600");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(await storage.get(m.storageKey));
  });

  /* ── Quick replies ── */

  app.get("/quick-replies", async (req) => ({ rows: await db.select({ id: textQuickReplies.id, title: textQuickReplies.title, body: textQuickReplies.body }).from(textQuickReplies).where(eq(textQuickReplies.companyId, req.user.companyId)).orderBy(asc(textQuickReplies.title)) }));
  app.post("/quick-replies", async (req) => {
    const b = parse(textQuickReplySchema, req.body);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(textQuickReplies).where(eq(textQuickReplies.companyId, req.user.companyId));
    if (n >= 100) throw new HttpError(400, "That's 100 quick replies; delete one you don't use first");
    const [row] = await db.insert(textQuickReplies).values({ companyId: req.user.companyId, title: b.title, body: b.body, createdById: req.user.sub }).returning();
    return { id: row.id, title: row.title, body: row.body };
  });
  app.delete<{ Params: { id: string } }>("/quick-replies/:id", async (req) => {
    await db.delete(textQuickReplies).where(and(eq(textQuickReplies.id, req.params.id), eq(textQuickReplies.companyId, req.user.companyId)));
    return { ok: true };
  });

  /* ── Calls and voicemails (a customer's page) ── */

  app.get<{ Querystring: { customerId?: string } }>("/calls", manager, async (req) => {
    const { companyId } = req.user;
    const c = req.query.customerId ? await customerInCompany(db, companyId, req.query.customerId) : null;
    const rows = await db.select().from(phoneCalls).where(and(eq(phoneCalls.companyId, companyId), c ? eq(phoneCalls.customerId, c.id) : undefined)).orderBy(desc(phoneCalls.at)).limit(c ? 50 : 100);
    const cfg = await textingConfig(companyId);
    return { on: !!cfg?.calls, rows: rows.map((r) => ({ id: r.id, kind: r.kind, direction: r.direction, result: r.result, seconds: r.durationSeconds, phone: r.phone, callerName: r.callerName, transcript: r.transcript, at: r.at })) };
  });

  /**
   * Calls that just came in, for the caller box in the top bar: who it was (the customer or
   * employee the number belongs to), and how the call went. The phone service reports a call when
   * it is over, so this is "who just called", seconds after they hang up. The page asks every few
   * seconds, passing back the `now` it was given last time; with no `after` it gets nothing but the time.
   */
  app.get<{ Querystring: { after?: string } }>("/calls/recent", async (req) => {
    const { companyId } = req.user;
    const now = new Date();
    const cfg = await textingConfig(companyId);
    const after = req.query.after ? new Date(req.query.after) : null;
    // `on`: whether the phone service is set to report calls at all (Settings → Integrations).
    const on = !!cfg?.calls;
    if (!after || Number.isNaN(+after)) return { on, now, calls: [] };
    // No further back than ten minutes: a computer waking from sleep doesn't pop the morning's calls.
    const since = new Date(Math.max(+after, +now - 10 * 60_000));
    const rows = await db.select({ p: phoneCalls, c: customers, e: { firstName: employees.firstName, lastName: employees.lastName } }).from(phoneCalls)
      .leftJoin(customers, eq(customers.id, phoneCalls.customerId)).leftJoin(employees, eq(employees.id, phoneCalls.employeeId))
      .where(and(eq(phoneCalls.companyId, companyId), eq(phoneCalls.direction, "in"), sql`${phoneCalls.createdAt} > ${since.toISOString()}`, sql`${phoneCalls.at} > ${new Date(+since - 86_400_000).toISOString()}`))
      .orderBy(asc(phoneCalls.createdAt)).limit(5);
    const canSeeCustomers = isManager(req, AREA);
    // Where the customer's service is, to tell two Smiths apart at a glance.
    const ids = [...new Set(rows.map((r) => r.c?.id).filter((x): x is string => !!x))];
    const places = ids.length ? await db.select({ customerId: propertyAssignments.customerId, street: properties.street, city: properties.city }).from(propertyAssignments)
      .innerJoin(properties, eq(properties.id, propertyAssignments.propertyId))
      .where(and(inArray(propertyAssignments.customerId, ids), isNull(propertyAssignments.endDate), eq(properties.status, "active"))).orderBy(asc(properties.createdAt)) : [];
    return {
      on, now,
      calls: rows.map(({ p, c, e }) => {
        const at = c ? places.filter((x) => x.customerId === c.id) : [];
        return {
          id: p.id, kind: p.kind, result: p.result, seconds: p.durationSeconds, phone: p.phone, phoneText: formatPhone(p.phone), callerName: p.callerName, at: p.at,
          transcript: p.kind === "voicemail" ? p.transcript : null,
          who: c ? "customer" as const : e ? "employee" as const : "unknown" as const,
          name: c ? customerName(c) : e ? fullName(e) : null,
          customerId: c && canSeeCustomers ? c.id : null,
          address: at[0] ? [at[0].street, at[0].city].filter(Boolean).join(", ") + (at.length > 1 ? ` (+${at.length - 1} more)` : "") : null,
          status: c?.status ?? null,
        };
      }),
    };
  });

  /** Where a voicemail's recording can be played from (Talkroute's own short-lived address). */
  app.get<{ Params: { id: string } }>("/calls/:id/audio", manager, async (req) => {
    const { companyId } = req.user;
    const [call] = await db.select().from(phoneCalls).where(and(eq(phoneCalls.id, req.params.id), eq(phoneCalls.companyId, companyId), eq(phoneCalls.kind, "voicemail")));
    if (!call) throw new HttpError(404, "Voicemail not found");
    const cfg = await textingConfig(companyId);
    const find = textingProvider().voicemailAudio;
    if (!cfg || !find) throw new HttpError(400, "Texting isn't connected, so the recording can't be fetched");
    const url = await find(cfg, { from: call.phone, at: call.at }).catch((e) => { throw new HttpError(502, (e as Error).message); });
    if (!url) throw new HttpError(404, "Talkroute doesn't have that recording any more");
    return { url };
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
    const media = await mediaFor(texts.map((x) => x.t.id));
    return {
      connected: !!cfg, number: textNumberFor(c), optedOut: c.textOptOutAt,
      texts: texts.reverse().map(({ t, by }) => ({ id: t.id, direction: t.direction, body: t.body, status: t.status, error: t.error, source: t.source, by, at: t.createdAt, sendAt: t.sendAt, media: media.get(t.id) ?? [] })),
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

    const later = b.sendAt ? new Date(b.sendAt) : null;
    if (later && +later < Date.now() + 60_000) throw new HttpError(400, "Pick a time at least a minute from now");
    if (texts.length === 1 && !later) {
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
    const batch = await queueTexts(companyId, { body: b.body, label, by: sub, texts, skipped, sendAt: later });
    return { sent: 0, queued: texts.length, skipped, batchId: batch.id, sendAt: later };
  });

  /** Messages History: sends to many, newest first, with how each is going. */
  app.get("/batches", async (req) => {
    const { companyId } = req.user;
    const rows = await db.select({ b: textBatches, by: sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}` }).from(textBatches)
      .leftJoin(employees, eq(employees.id, textBatches.createdById)).where(eq(textBatches.companyId, companyId)).orderBy(desc(textBatches.createdAt)).limit(30);
    const counts = rows.length ? await db.select({ id: customerTexts.batchId, status: customerTexts.status, n: sql<number>`count(*)::int` }).from(customerTexts)
      .where(inArray(customerTexts.batchId, rows.map((r) => r.b.id))).groupBy(customerTexts.batchId, customerTexts.status) : [];
    const count = (id: string, ...statuses: string[]) => counts.filter((c) => c.id === id && statuses.includes(c.status)).reduce((n, c) => n + c.n, 0);
    const times = rows.length ? await db.select({ id: customerTexts.batchId, at: sql<Date>`min(${customerTexts.sendAt})` }).from(customerTexts)
      .where(and(inArray(customerTexts.batchId, rows.map((r) => r.b.id)), eq(customerTexts.status, "scheduled"))).groupBy(customerTexts.batchId) : [];
    const sendTimes = new Map(times.map((t) => [t.id, t.at]));
    return {
      rows: rows.map(({ b, by }) => ({
        id: b.id, at: b.createdAt, by, label: b.label, body: b.body, total: b.total, stopped: !!b.stoppedAt,
        sent: count(b.id, "sent", "delivered"), failed: count(b.id, "failed"), waiting: count(b.id, "queued", "sending"), scheduled: count(b.id, "scheduled"), skipped: b.skipped,
        sendAt: sendTimes.get(b.id) ?? null,
      })),
    };
  });

  /** Stops a send that's still going: the texts not sent yet are dropped. */
  app.post<{ Params: { id: string } }>("/batches/:id/stop", async (req) => {
    const { companyId } = req.user;
    const [b] = await db.select().from(textBatches).where(and(eq(textBatches.id, req.params.id), eq(textBatches.companyId, companyId)));
    if (!b) throw new HttpError(404, "Not found");
    await db.update(textBatches).set({ stoppedAt: new Date() }).where(eq(textBatches.id, b.id));
    const dropped = await db.delete(customerTexts).where(and(eq(customerTexts.batchId, b.id), inArray(customerTexts.status, ["queued", "scheduled"]))).returning({ id: customerTexts.id });
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
