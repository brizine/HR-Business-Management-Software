import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  MAP_CODE_MAX, cleanOutline, distanceMeters, formatAddress, mapCodeChange, mapCodeFinder, overlapSqM, sameMapCode, trimOutline,
  type MapCodeChange, type MapCodeInput, type MapOutline,
} from "@crewdesk/shared";
import { db } from "../db";
import { companies, mapCodes, properties } from "../db/schema";
import { locateAddress } from "./dispatch";
import { HttpError } from "./errors";
import type { Tx } from "./crm";

/**
 * Map Codes: the outlines (kept so they never overlap), and the codes they give properties.
 *
 * A property's code comes from the outline its pin is inside, once the company has turned automatic map
 * codes on. Until then (while the outlines are being drawn) properties keep the codes typed on them.
 * A code typed by hand after that is left alone. A property with no pin can't be placed.
 */

type Db = typeof db | Tx;
export type MapCodeRow = typeof mapCodes.$inferSelect;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** An overlap smaller than this is two outlines sharing an edge, not one drawn over the other (square meters). */
const TOUCHING = 25;

export async function mapCodesAuto(companyId: string, tx: Db = db) {
  const [c] = await tx.select({ on: companies.mapCodesAuto }).from(companies).where(eq(companies.id, companyId));
  return !!c?.on;
}

export const listMapCodes = (companyId: string, tx: Db = db) =>
  tx.select().from(mapCodes).where(eq(mapCodes.companyId, companyId)).orderBy(asc(mapCodes.code));

/**
 * An outline as it will be kept: tidied, then trimmed to the edges of the company's other outlines (they keep
 * their ground). Says which neighbours it was trimmed against. `exceptId` is the outline being changed.
 */
export async function fitOutline(companyId: string, input: Pick<MapCodeInput, "code" | "outline">, exceptId?: string, tx: Db = db) {
  const others = (await listMapCodes(companyId, tx)).filter((c) => c.id !== exceptId);
  if (!exceptId && others.length >= MAP_CODE_MAX) throw new HttpError(400, `A company can have up to ${MAP_CODE_MAX} map codes`);
  const taken = others.find((c) => sameMapCode(c.code, input.code));
  if (taken) throw new HttpError(400, `There's already a map code ${taken.code}. Give this one another code, or change that one`);
  // The geometry can give up on a shape that folds back on itself in an odd way: that's the drawing, not a fault here.
  const worked = <T,>(fn: () => T): T => {
    try { return fn(); } catch { throw new HttpError(400, "That outline couldn't be worked out. Check that its lines don't cross each other, and try again"); }
  };
  const drawn = worked(() => cleanOutline(input.outline));
  if (!drawn.length) throw new HttpError(400, "That outline is too small to keep. Draw it around the area it covers");
  const over = worked(() => others.filter((c) => overlapSqM(drawn, c.outline) > TOUCHING));
  const outline = over.length ? worked(() => trimOutline(drawn, over.map((c) => c.outline))) : drawn;
  if (!outline.length) {
    throw new HttpError(400, `That outline is inside ${over.map((c) => c.code).join(" and ")}, so nothing of it is left once it's trimmed. Shrink ${over.length === 1 ? "that map code" : "those map codes"} first, then draw this one`);
  }
  return { outline, trimmedBy: over.map((c) => c.code), others };
}

export interface PlannedChange { id: string; address: string; from: string | null; to: string | null; change: MapCodeChange }
export interface MapCodePlan {
  /** Every property whose code would change: set, moved to another code, or cleared (outside every outline). */
  rows: PlannedChange[];
  counts: Record<MapCodeChange, number>;
  /** From one code to another, with how many: "805 → 801: 12". */
  moves: { from: string | null; to: string | null; count: number }[];
}

/**
 * What the outlines would do to the company's properties. `outlines` are the ones to test (as they'd be after
 * a save); `replaceByHand` is for turning automatic map codes on, when typed codes are replaced too.
 */
export async function planMapCodes(companyId: string, outlines: readonly { code: string; outline: MapOutline }[], replaceByHand = false, tx: Db = db): Promise<MapCodePlan> {
  const find = mapCodeFinder(outlines);
  const all = await tx.select({
    id: properties.id, street: properties.street, city: properties.city, state: properties.state, zip: properties.zip,
    lat: properties.lat, lng: properties.lng, mapCode: properties.mapCode, mapCodeManual: properties.mapCodeManual,
  }).from(properties).where(eq(properties.companyId, companyId)).orderBy(asc(properties.street));
  const counts: Record<MapCodeChange, number> = { same: 0, set: 0, moved: 0, cleared: 0, by_hand: 0, no_pin: 0 };
  const rows: PlannedChange[] = [];
  const moves = new Map<string, { from: string | null; to: string | null; count: number }>();
  for (const p of all) {
    const to = find(p.lat, p.lng)?.code ?? null;
    const change = mapCodeChange(p, to, replaceByHand);
    counts[change]++;
    if (change !== "set" && change !== "moved" && change !== "cleared") continue;
    rows.push({ id: p.id, address: formatAddress(p), from: p.mapCode, to, change });
    const key = `${(p.mapCode ?? "").toUpperCase()}→${(to ?? "").toUpperCase()}`;
    const m = moves.get(key) ?? { from: p.mapCode, to, count: 0 };
    m.count++;
    moves.set(key, m);
  }
  return { rows, counts, moves: [...moves.values()].sort((a, b) => b.count - a.count) };
}

/** Writes a plan's changes. Turning automatic map codes on also makes every placed property automatic again. */
async function applyPlan(tx: Tx, companyId: string, plan: MapCodePlan, replaceByHand: boolean) {
  const byTarget = new Map<string | null, string[]>();
  for (const r of plan.rows) byTarget.set(r.to, [...(byTarget.get(r.to) ?? []), r.id]);
  for (const [to, ids] of byTarget) {
    for (let i = 0; i < ids.length; i += 500) {
      await tx.update(properties).set({ mapCode: to, mapCodeManual: false, updatedAt: new Date() }).where(and(eq(properties.companyId, companyId), inArray(properties.id, ids.slice(i, i + 500))));
    }
  }
  if (replaceByHand) {
    await tx.update(properties).set({ mapCodeManual: false }).where(and(eq(properties.companyId, companyId), eq(properties.mapCodeManual, true), sql`${properties.lat} is not null and ${properties.lng} is not null`));
  }
  return plan.rows.length;
}

/** The outlines as they'd be with one saved (`next`) or taken away (`removeId`). */
function outlinesWith(others: MapCodeRow[], next?: { code: string; outline: MapOutline }, removeId?: string) {
  return [...others.filter((c) => c.id !== removeId), ...(next ? [next] : [])];
}

/** What saving (or deleting) an outline would change, without changing anything. Null plan while automatic map codes are off. */
export async function checkMapCode(companyId: string, input: (MapCodeInput & { id?: string }) | { removeId: string }) {
  const auto = await mapCodesAuto(companyId);
  if ("removeId" in input) {
    const all = await listMapCodes(companyId);
    if (!all.some((c) => c.id === input.removeId)) throw new HttpError(404, "Map code not found");
    return { outline: null, trimmedBy: [] as string[], plan: auto ? await planMapCodes(companyId, outlinesWith(all, undefined, input.removeId)) : null };
  }
  const fit = await fitOutline(companyId, input, input.id);
  return { outline: fit.outline, trimmedBy: fit.trimmedBy, plan: auto ? await planMapCodes(companyId, outlinesWith(fit.others, { code: input.code, outline: fit.outline })) : null };
}

/** Saves an outline (trimmed to fit) and, with automatic map codes on, moves the properties it changes. */
export async function saveMapCode(companyId: string, byId: string, input: MapCodeInput, id?: string) {
  return db.transaction(async (tx) => {
    // One save at a time for a company, so two outlines can't be fitted against each other's old shape.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`map-codes:${companyId}`}))`);
    const before = id ? (await listMapCodes(companyId, tx)).find((c) => c.id === id) : undefined;
    if (id && !before) throw new HttpError(404, "Map code not found");
    const fit = await fitOutline(companyId, input, id, tx);
    const values = { code: input.code, name: input.name ?? null, color: input.color, outline: fit.outline, updatedAt: new Date() };
    const [row] = id
      ? await tx.update(mapCodes).set(values).where(and(eq(mapCodes.id, id), eq(mapCodes.companyId, companyId))).returning()
      : await tx.insert(mapCodes).values({ ...values, companyId, createdById: byId }).returning();
    let changed = 0;
    if (await mapCodesAuto(companyId, tx)) {
      // A renamed code: the properties in it follow the new name even where the outline didn't move.
      changed = await applyPlan(tx, companyId, await planMapCodes(companyId, outlinesWith(fit.others, row), false, tx), false);
    }
    return { ...row, trimmedBy: fit.trimmedBy, changed };
  });
}

export async function deleteMapCode(companyId: string, id: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`map-codes:${companyId}`}))`);
    const [gone] = await tx.delete(mapCodes).where(and(eq(mapCodes.id, id), eq(mapCodes.companyId, companyId))).returning();
    if (!gone) throw new HttpError(404, "Map code not found");
    const changed = (await mapCodesAuto(companyId, tx)) ? await applyPlan(tx, companyId, await planMapCodes(companyId, await listMapCodes(companyId, tx), false, tx), false) : 0;
    return { ok: true, changed };
  });
}

/** What turning automatic map codes on would change: every placed property takes its outline's code, typed codes included. */
export const autoPreview = async (companyId: string) => planMapCodes(companyId, await listMapCodes(companyId), true);

/** Turns automatic map codes on (applying the outlines to every placed property) or off (codes stay as they are). */
export async function setMapCodesAuto(companyId: string, on: boolean) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`map-codes:${companyId}`}))`);
    let changed = 0;
    if (on) {
      const outlines = await listMapCodes(companyId, tx);
      if (!outlines.length) throw new HttpError(400, "Draw at least one map code first");
      changed = await applyPlan(tx, companyId, await planMapCodes(companyId, outlines, true, tx), true);
    }
    await tx.update(companies).set({ mapCodesAuto: on }).where(eq(companies.id, companyId));
    return { auto: on, changed };
  });
}

/**
 * Gives one property the code of the outline its pin is in (automatic map codes on, and its code not set by
 * hand). Called whenever its pin or its code may have changed. Returns the property's code afterwards.
 */
export async function assignMapCode(companyId: string, propertyId: string, tx: Db = db) {
  const [p] = await tx.select({ lat: properties.lat, lng: properties.lng, mapCode: properties.mapCode, mapCodeManual: properties.mapCodeManual })
    .from(properties).where(and(eq(properties.id, propertyId), eq(properties.companyId, companyId)));
  if (!p) return null;
  if (!(await mapCodesAuto(companyId, tx))) return p.mapCode;
  const to = mapCodeFinder(await listMapCodes(companyId, tx))(p.lat, p.lng)?.code ?? null;
  const change = mapCodeChange(p, to);
  if (change !== "set" && change !== "moved" && change !== "cleared") return p.mapCode;
  await tx.update(properties).set({ mapCode: to, updatedAt: new Date() }).where(eq(properties.id, propertyId));
  return to;
}

/* ───────────── Pins: finding a property's address on the map ───────────── */

type Locator = (address: string) => Promise<{ lat: number; lng: number } | null>;
/** Tests don't go looking addresses up on the internet unless they bring their own lookup. */
let locator: Locator | null = process.env.NODE_ENV === "test" ? null : (address) => locateAddress(address);
export function setPropertyLocator(fn: Locator | null) { locator = fn; }
/** A pin this close to where the address is found is the same place: a hand-placed pin is kept (meters). */
const SAME_PLACE_M = 150;

const lookUp = async (address: string) => {
  if (!locator) return undefined;
  const at = await locator(address).catch(() => null);
  return at && Number.isFinite(at.lat) && Number.isFinite(at.lng) ? { lat: round6(at.lat), lng: round6(at.lng) } : null;
};

/** Saves what a lookup found (or that it found nothing), then the property's map code. */
async function pinFound(companyId: string, propertyId: string, at: { lat: number; lng: number } | null, moved: boolean) {
  if (!at) {
    await db.update(properties).set({ pinLookupAt: new Date() }).where(and(eq(properties.id, propertyId), eq(properties.companyId, companyId)));
    return;
  }
  // Only where there's still no pin (or the address moved): someone may have placed one by hand while the lookup ran.
  await db.update(properties).set({ lat: at.lat, lng: at.lng, pinLookupAt: null, updatedAt: new Date() })
    .where(and(eq(properties.id, propertyId), eq(properties.companyId, companyId), moved ? undefined : isNull(properties.lat)));
  await assignMapCode(companyId, propertyId);
}

/**
 * A new property, or one whose address changed: finds the address on the map for its pin (when it has none,
 * or `moved` says the address is now somewhere else), then gives it its map code. The lookup gets `waitMs`;
 * a slower one carries on after the answer has gone back, and the pin and code appear when it's done.
 * Never throws: a property is saved whether or not its address can be found.
 */
export async function placeProperty(companyId: string, propertyId: string, opts: { moved?: boolean; waitMs?: number } = {}) {
  try {
    const [p] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.companyId, companyId)));
    if (!p) return;
    const hasPin = p.lat != null && p.lng != null;
    if (locator && (!hasPin || opts.moved)) {
      const looking = lookUp(formatAddress(p)).then(async (at) => {
        if (at === undefined) return;
        // The address was corrected, not moved: the pin (perhaps placed by hand on the driveway) stays.
        if (at && hasPin && distanceMeters({ lat: p.lat!, lng: p.lng! }, at) <= SAME_PLACE_M) return;
        // An address that can't be found leaves an existing pin where it is.
        if (!at && hasPin) return;
        await pinFound(companyId, propertyId, at, !!opts.moved);
      }).catch(() => undefined);
      const waited = await Promise.race([looking.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), opts.waitMs ?? 3500).unref?.())]);
      if (!waited) return;
    }
    await assignMapCode(companyId, propertyId);
  } catch { /* the property is saved; its pin and code can be set from its page */ }
}

/**
 * The catch-up: looks up addresses for properties with no pin, for as long as `budgetMs` allows, and says how
 * many are left. A run is several calls: the first has no `since` and is told when the run started (by the
 * server's clock, never the browser's); the rest send that back, so an address tried in this run isn't tried
 * again in it.
 */
export async function findPins(companyId: string, started?: Date, budgetMs = 20_000) {
  const now = new Date();
  const since = started && started < now ? started : now;
  const todo = and(eq(properties.companyId, companyId), isNull(properties.lat), ne(properties.status, "cancelled"), or(isNull(properties.pinLookupAt), lt(properties.pinLookupAt, since)));
  let found = 0, tried = 0;
  if (locator) {
    while (Date.now() - now.getTime() < budgetMs) {
      const batch = await db.select().from(properties).where(todo).orderBy(asc(properties.createdAt)).limit(2);
      if (!batch.length) break;
      // Two at a time: the national lookups ask not to be hammered.
      await Promise.all(batch.map(async (p) => {
        const at = await lookUp(formatAddress(p));
        tried++;
        if (at) found++;
        await pinFound(companyId, p.id, at ?? null, false);
      }));
    }
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(properties).where(todo);
  return { found, tried, remaining: locator ? n : 0, since: since.toISOString() };
}
