/** Map Codes: outlines that never overlap, the codes they give properties, the previews, the pin lookup, and who may. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { outlineHas, overlapSqM, type MapOutline } from "@crewdesk/shared";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setPropertyLocator } from "../src/lib/mapCodes";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@mc.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
/** Where the address lookup "finds" a street: by a word in it. Anything else isn't found. */
const PLACES: Record<string, { lat: number; lng: number }> = {
  west: { lat: 35.21, lng: -97.49 }, east: { lat: 35.21, lng: -97.47 }, north: { lat: 35.25, lng: -97.49 }, far: { lat: 35.6, lng: -97.2 },
};
const asked: string[] = [];

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body };
}
/** A box from (lat, lng) going `h` degrees north and `w` degrees east. */
const box = (lat: number, lng: number, h = 0.02, w = 0.02): MapOutline => [[[[lat, lng], [lat + h, lng], [lat + h, lng + w], [lat, lng + w]]]];
const WEST = box(35.2, -97.5), NORTH = box(35.24, -97.5);
const property = async (id: string) => (await call("GET", `/properties/${id}`, "office")).body;
/** A customer with one property on `street`; returns the property's id. */
async function add(street: string, extra: Record<string, unknown> = {}) {
  const c = await call("POST", "/customers", "office", { firstName: "Pat", lastName: street.split(" ")[1], email: email(street.replace(/\W/g, "").toLowerCase()), property: { street, city: "Norman", zip: "73069", ...extra } });
  expect(c.status).toBe(200);
  return (await call("GET", `/customers/${c.body.id}`, "office")).body.properties[0].id as string;
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setPropertyLocator(async (address) => { asked.push(address); const word = Object.keys(PLACES).find((w) => address.toLowerCase().includes(w)); return word ? PLACES[word] : null; });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Map Co", firstName: "Mo", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["boss", "admin"], ["office", "manager"], ["tech", "employee"]] as const) {
    await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  T.other = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Elsewhere Co", firstName: "Eli", lastName: "Other", email: email("other"), password: "password123" } })).json().token;
});

afterAll(async () => {
  setPropertyLocator(null);
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("map codes", () => {
  it("a new property gets its pin from its address; with automatic map codes off it keeps the code typed on it", async () => {
    ID.w1 = await add("10 West St", { mapCode: "OLD-A" });
    ID.e1 = await add("20 East St", { mapCode: "OLD-A" });
    ID.far = await add("30 Far Rd", { mapCode: "OLD-B" });
    ID.lost = await add("40 Nowhere Ln", { mapCode: "OLD-B" });
    ID.n1 = await add("50 North Ave");
    expect(asked).toContain("10 West St, Norman, OK 73069");
    expect(await property(ID.w1)).toMatchObject({ lat: 35.21, lng: -97.49, mapCode: "OLD-A", mapCodeManual: true });
    // An address that can't be found: saved all the same, with no pin.
    expect(await property(ID.lost)).toMatchObject({ lat: null, lng: null, mapCode: "OLD-B" });
    expect(await property(ID.n1)).toMatchObject({ lat: 35.25, lng: -97.49, mapCode: null, mapCodeManual: false });
    expect((await call("GET", "/map-codes", "office")).body).toEqual({ auto: false, codes: [] });
  });

  it("only admins draw; outlines are checked; a second code can't reuse a code", async () => {
    for (const who of ["office", "tech"]) expect((await call("POST", "/map-codes", who, { code: "801", outline: WEST })).status).toBe(403);
    expect((await call("GET", "/map-codes", "tech")).status).toBe(403);
    const made = await call("POST", "/map-codes", "boss", { code: "801", name: "West Norman", color: "#2ea043", outline: WEST });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ code: "801", name: "West Norman", color: "#2ea043", trimmedBy: [], changed: 0 });
    ID.west = made.body.id;
    expect((await call("POST", "/map-codes", "boss", { code: " 801 ", outline: NORTH })).body.error).toMatch(/already a map code 801/);
    expect((await call("POST", "/map-codes", "boss", { code: "", outline: NORTH })).body.issues[0].message).toMatch(/Give the map code a code/);
    expect((await call("POST", "/map-codes", "boss", { code: "802", outline: [] })).body.issues[0].message).toMatch(/Draw the outline/);
    expect((await call("POST", "/map-codes", "boss", { code: "802", outline: box(35.3, -97.5, 0.00002, 0.00002) })).body.error).toMatch(/too small/);
    // Another company sees none of it and can't touch it.
    expect((await call("GET", "/map-codes", "other")).body.codes).toEqual([]);
    expect((await call("PUT", `/map-codes/${ID.west}`, "other", { code: "801", outline: WEST })).status).toBe(404);
    expect((await call("DELETE", `/map-codes/${ID.west}`, "other")).status).toBe(404);
    // With automatic map codes off, nothing on properties moved.
    expect((await property(ID.w1)).mapCode).toBe("OLD-A");
  });

  it("an outline drawn over a neighbour is trimmed to the neighbour's edge; one drawn inside it is refused", async () => {
    // Drawn from the middle of 801 on east: the part inside 801 is taken off.
    const drawn = box(35.2, -97.49, 0.02, 0.03);
    const check = await call("POST", "/map-codes/check", "boss", { code: "802", outline: drawn });
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ trimmedBy: ["801"], plan: null });
    expect(overlapSqM(check.body.outline, WEST)).toBeLessThan(1);
    expect((await call("GET", "/map-codes", "boss")).body.codes).toHaveLength(1);
    const made = await call("POST", "/map-codes", "boss", { code: "802", name: "East Norman", outline: drawn });
    expect(made.body.trimmedBy).toEqual(["801"]);
    ID.east = made.body.id;
    expect(overlapSqM(made.body.outline, WEST)).toBeLessThan(1);
    expect(Math.min(...(made.body.outline as MapOutline)[0][0].map((p) => p[1]))).toBe(-97.48);
    expect(outlineHas(made.body.outline, 35.21, -97.47)).toBe(true);
    expect(outlineHas(made.body.outline, 35.21, -97.49)).toBe(false);
    const inside = await call("POST", "/map-codes", "boss", { code: "803", outline: box(35.205, -97.495, 0.005, 0.005) });
    expect(inside.status).toBe(400);
    expect(inside.body.error).toMatch(/inside 801.*Shrink that map code first/);
    // Outlines that only share an edge aren't "trimmed".
    expect((await call("POST", "/map-codes/check", "boss", { code: "803", outline: NORTH })).body.trimmedBy).toEqual([]);
    expect((await call("POST", "/map-codes/check", "office", { code: "803", outline: NORTH })).status).toBe(403);
  });

  it("turning automatic map codes on shows what changes first, then replaces the typed codes", async () => {
    expect((await call("GET", "/map-codes/auto/preview", "office")).status).toBe(403);
    const preview = (await call("GET", "/map-codes/auto/preview", "boss")).body;
    expect(preview.counts).toMatchObject({ moved: 2, cleared: 1, no_pin: 1, same: 1, set: 0, by_hand: 0 });
    expect(preview.rows.map((r: any) => [r.address, r.from, r.to, r.change])).toEqual([
      ["10 West St, Norman, OK 73069", "OLD-A", "801", "moved"],
      ["20 East St, Norman, OK 73069", "OLD-A", "802", "moved"],
      ["30 Far Rd, Norman, OK 73069", "OLD-B", null, "cleared"],
    ]);
    expect(preview.moves).toEqual(expect.arrayContaining([{ from: "OLD-A", to: "801", count: 1 }, { from: "OLD-B", to: null, count: 1 }]));
    // The preview changed nothing.
    expect((await property(ID.w1)).mapCode).toBe("OLD-A");
    expect((await call("POST", "/map-codes/auto", "office", { on: true })).status).toBe(403);
    const on = await call("POST", "/map-codes/auto", "boss", { on: true });
    expect(on.body).toEqual({ auto: true, changed: 3 });
    expect(await property(ID.w1)).toMatchObject({ mapCode: "801", mapCodeManual: false });
    expect(await property(ID.e1)).toMatchObject({ mapCode: "802", mapCodeManual: false });
    // Outside every outline: no code. No pin: it can't be placed, so it keeps what it had.
    expect(await property(ID.far)).toMatchObject({ mapCode: null, mapCodeManual: false });
    expect(await property(ID.lost)).toMatchObject({ mapCode: "OLD-B", mapCodeManual: true });
    expect((await call("GET", "/map-codes", "office")).body.auto).toBe(true);
    // A company with no outlines can't turn it on.
    expect((await call("POST", "/map-codes/auto", "other", { on: true })).body.error).toMatch(/Draw at least one map code first/);
  });

  it("with it on, a new property gets its code as it's added, and a moved pin follows the outlines", async () => {
    ID.w2 = await add("12 West St");
    expect(await property(ID.w2)).toMatchObject({ lat: 35.21, lng: -97.49, mapCode: "801", mapCodeManual: false });
    ID.far2 = await add("32 Far Rd");
    expect(await property(ID.far2)).toMatchObject({ lat: 35.6, mapCode: null });
    // Added straight onto a customer (the property page's own Add): the same.
    const cust = (await call("POST", "/customers", "office", { firstName: "Sam", lastName: "Two", email: email("sam") })).body.id;
    const direct = await call("POST", "/properties", "office", { street: "14 East St", city: "Norman", zip: "73069", billToCustomerId: cust });
    expect(direct.status).toBe(200);
    expect(direct.body).toMatchObject({ lat: 35.21, lng: -97.47, mapCode: "802" });
    ID.e2 = direct.body.id;
    // Moving the pin into another outline moves the code; out of all of them clears it.
    expect((await call("PUT", `/properties/${ID.w2}/pin`, "office", { lat: 35.21, lng: -97.47 })).body).toEqual({ lat: 35.21, lng: -97.47, mapCode: "802" });
    expect((await call("PUT", `/properties/${ID.w2}/pin`, "office", { lat: 35.5, lng: -97.47 })).body.mapCode).toBeNull();
    expect((await call("PUT", `/properties/${ID.w2}/pin`, "office", { lat: 35.21, lng: -97.49 })).body.mapCode).toBe("801");
    // The property with no pin gets one by hand, and its code with it (once it's automatic again).
    expect((await call("PUT", `/properties/${ID.lost}/pin`, "office", { lat: 35.21, lng: -97.49 })).body.mapCode).toBe("OLD-B");
    expect((await call("POST", `/properties/${ID.lost}/map-code/auto`, "office")).body).toEqual({ mapCode: "801", mapCodeManual: false });
    expect((await call("POST", `/properties/${ID.lost}/map-code/auto`, "tech")).status).toBe(403);
  });

  it("a code typed by hand stays through redraws; emptied, it goes back to the outline's", async () => {
    const p = await property(ID.e2);
    const form = { street: p.street, city: p.city, state: p.state, zip: p.zip, tagIds: [] };
    const typed = await call("PUT", `/properties/${ID.e2}`, "office", { ...form, mapCode: "SPECIAL" });
    expect(typed.body).toMatchObject({ mapCode: "SPECIAL", mapCodeManual: true, lat: 35.21, lng: -97.47 });
    // Saving the form again as it is leaves it alone, and so does moving its pin.
    expect((await call("PUT", `/properties/${ID.e2}`, "office", { ...form, mapCode: "SPECIAL", gateCode: "1234" })).body).toMatchObject({ mapCode: "SPECIAL", mapCodeManual: true });
    expect((await call("PUT", `/properties/${ID.e2}/pin`, "office", { lat: 35.21, lng: -97.471 })).body.mapCode).toBe("SPECIAL");
    // A redraw says it's kept, and keeps it.
    const check = await call("POST", "/map-codes/check", "boss", { id: ID.east, code: "802E", name: "East Norman", outline: box(35.2, -97.48, 0.02, 0.02) });
    expect(check.body.plan.counts).toMatchObject({ by_hand: 1, moved: 1 });
    expect(check.body.plan.rows.map((r: any) => [r.address, r.from, r.to])).toEqual([["20 East St, Norman, OK 73069", "802", "802E"]]);
    expect((await property(ID.e1)).mapCode).toBe("802");
    const renamed = await call("PUT", `/map-codes/${ID.east}`, "boss", { code: "802E", name: "East Norman", outline: box(35.2, -97.48, 0.02, 0.02) });
    expect(renamed.body).toMatchObject({ code: "802E", changed: 1 });
    expect((await property(ID.e1)).mapCode).toBe("802E");
    expect((await property(ID.e2)).mapCode).toBe("SPECIAL");
    // Emptying the field hands it back to the outlines.
    expect((await call("PUT", `/properties/${ID.e2}`, "office", { ...form })).body).toMatchObject({ mapCode: "802E", mapCodeManual: false });
    // A code typed while adding a property is by hand too.
    ID.e3 = await add("16 East St", { mapCode: "VIP" });
    expect(await property(ID.e3)).toMatchObject({ mapCode: "VIP", mapCodeManual: true });
  });

  it("a changed address is looked up again; a corrected one keeps a hand-placed pin", async () => {
    // The edit form sends the property as it stands (its Map Code included) with the street changed.
    const restreet = async (street: string) => {
      const p = await property(ID.w1);
      return (await call("PUT", `/properties/${ID.w1}`, "office", { street, city: p.city, state: p.state, zip: p.zip, tagIds: [], mapCode: p.mapCode })).body;
    };
    // The pin is moved a little by hand (onto the driveway); fixing the address's spelling leaves it there.
    await call("PUT", `/properties/${ID.w1}/pin`, "office", { lat: 35.2102, lng: -97.4901 });
    expect(await restreet("10 West Street")).toMatchObject({ lat: 35.2102, lng: -97.4901, mapCode: "801", mapCodeManual: false });
    // Moved across town: a new pin, and the code that goes with it.
    expect(await restreet("10 East St")).toMatchObject({ lat: 35.21, lng: -97.47, mapCode: "802E", mapCodeManual: false });
    // An address that can't be found leaves the pin where it was.
    expect(await restreet("10 Mystery Way")).toMatchObject({ lat: 35.21, lng: -97.47, mapCode: "802E" });
    expect(await restreet("10 West St")).toMatchObject({ lat: 35.21, lng: -97.49, mapCode: "801" });
  });

  it("deleting an outline shows what loses its code, then clears those; turning it off leaves codes alone", async () => {
    const north = await call("POST", "/map-codes", "boss", { code: "803", outline: NORTH });
    expect(north.body.changed).toBe(1);
    expect((await property(ID.n1)).mapCode).toBe("803");
    const check = await call("POST", "/map-codes/check", "boss", { removeId: north.body.id });
    expect(check.body).toMatchObject({ outline: null, trimmedBy: [] });
    expect(check.body.plan.rows.map((r: any) => [r.address, r.from, r.to, r.change])).toEqual([["50 North Ave, Norman, OK 73069", "803", null, "cleared"]]);
    expect((await call("DELETE", `/map-codes/${north.body.id}`, "office")).status).toBe(403);
    expect((await call("DELETE", `/map-codes/${north.body.id}`, "boss")).body).toEqual({ ok: true, changed: 1 });
    expect((await property(ID.n1)).mapCode).toBeNull();
    expect((await call("DELETE", `/map-codes/${north.body.id}`, "boss")).status).toBe(404);
    // Off: outlines can be redrawn without touching properties.
    expect((await call("POST", "/map-codes/auto", "boss", { on: false })).body).toEqual({ auto: false, changed: 0 });
    const again = await call("POST", "/map-codes", "boss", { code: "803", outline: NORTH });
    expect(again.body.changed).toBe(0);
    expect((await call("POST", "/map-codes/check", "boss", { code: "804", outline: box(35.3, -97.5) })).body.plan).toBeNull();
    expect((await property(ID.n1)).mapCode).toBeNull();
    expect((await call("POST", "/map-codes/auto", "boss", { on: true })).body).toMatchObject({ auto: true });
    expect((await property(ID.n1)).mapCode).toBe("803");
  });

  it("the map's list of properties, and the catch-up that finds pins for the ones without", async () => {
    setPropertyLocator(null);
    ID.late = await add("60 West Later Rd");
    ID.gone = await add("70 Unfindable Ct");
    setPropertyLocator(async (address) => { asked.push(address); const word = Object.keys(PLACES).find((w) => address.toLowerCase().includes(w)); return word ? PLACES[word] : null; });
    const list = (await call("GET", "/map-codes/properties", "office")).body;
    expect(list.noPin.map((p: any) => [p.address, p.tried])).toEqual([["60 West Later Rd, Norman, OK 73069", false], ["70 Unfindable Ct, Norman, OK 73069", false]]);
    expect(list.pins.find((p: any) => p.id === ID.w1)).toEqual({ id: ID.w1, address: "10 West St, Norman, OK 73069", lat: 35.21, lng: -97.49, mapCode: "801", manual: false });
    expect((await call("GET", "/map-codes/properties", "tech")).status).toBe(403);
    expect((await call("GET", "/map-codes/no-pin-count", "office")).body).toEqual({ count: 2 });
    expect((await call("POST", "/map-codes/find-pins", "office", {})).status).toBe(403);
    // A run's first call is told when the run started (the server's clock), and sends that back on the next.
    const run = await call("POST", "/map-codes/find-pins", "boss", {});
    expect(run.body).toMatchObject({ found: 1, tried: 2, remaining: 0 });
    const since = run.body.since as string;
    expect(Math.abs(Date.parse(since) - Date.now())).toBeLessThan(5000);
    // Found: its pin, and (automatic map codes being on) its code. Not found: marked as tried.
    expect(await property(ID.late)).toMatchObject({ lat: 35.21, lng: -97.49, mapCode: "801" });
    expect(await property(ID.gone)).toMatchObject({ lat: null, mapCode: null });
    const after = (await call("GET", "/map-codes/properties", "office")).body;
    expect(after.noPin.map((p: any) => [p.address, p.tried])).toEqual([["70 Unfindable Ct, Norman, OK 73069", true]]);
    // The same run doesn't ask again; a later run does.
    expect((await call("POST", "/map-codes/find-pins", "boss", { since })).body).toMatchObject({ found: 0, tried: 0, remaining: 0, since });
    expect((await call("POST", "/map-codes/find-pins", "boss", {})).body).toMatchObject({ found: 0, tried: 1, remaining: 0 });
    // A browser whose clock runs ahead can't make a run ask for the same address again and again.
    const ahead = await call("POST", "/map-codes/find-pins", "boss", { since: new Date(Date.now() + 3_600_000).toISOString() });
    expect(ahead.body).toMatchObject({ found: 0, tried: 1, remaining: 0 });
    expect(Date.parse(ahead.body.since)).toBeLessThanOrEqual(Date.now());
    expect((await call("POST", "/map-codes/find-pins", "boss", { since: "yesterday" })).status).toBe(400);
  });

  it("attaching a measurement gives a property with no pin its first one, and its code", async () => {
    const m = await call("POST", "/measurements", "office", { name: "Unfindable", lat: 35.21, lng: -97.47, zoom: 19, pinLat: 35.2101, pinLng: -97.4701, shapes: [] });
    expect(m.status).toBe(200);
    const linked = await call("POST", `/properties/${ID.gone}/measurement`, "office", { measurementId: m.body.id });
    expect(linked.body).toMatchObject({ lat: 35.2101, lng: -97.4701, mapCode: "802E" });
  });
});
