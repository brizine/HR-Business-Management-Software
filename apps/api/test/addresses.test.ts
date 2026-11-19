/** Oklahoma 911 address points: turning records into rows, and searching the stored ones. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { addressPoints } from "../src/db/schema";
import { searchAddresses, toAddressRow } from "../src/lib/addresses";
import { geocode } from "../src/lib/geocode";

const COUNTY = "ZZTEST";

beforeAll(async () => {
  await db.delete(addressPoints).where(eq(addressPoints.county, COUNTY));
  const rows = [
    toAddressRow({ geometry: { coordinates: [-97.46507469, 35.26028745] }, properties: { fulladdr: "1601 ZQDESKIN DR", address: 1601, predir: " ", street: "ZQDESKIN", streettype: "DRIVE", sufdir: " ", city: "NORMAN", postcomm: "NORMAN", zipcode: "73069" } }, COUNTY, "address"),
    toAddressRow({ geometry: { coordinates: [-97.4646, 35.2598] }, properties: { fulladdr: "1600 ZQDESKIN DR", address: 1600, street: "ZQDESKIN", streettype: "DRIVE", city: "NORMAN", zipcode: "73069" } }, COUNTY, "address"),
    toAddressRow({ geometry: { coordinates: [-97.6271, 34.9415] }, properties: { fulladdr: "1601 ZQDESKIN STREET", addnumber: 1601, predir: null, street: "ZQDESKIN", streettype: "STREET", city: "UNINCORPORATED", postcomm: "LINDSAY", zipcode: "73052" } }, COUNTY, "addnumber"),
  ];
  await db.insert(addressPoints).values(rows.map((r) => r!));
});


describe("Oklahoma 911 addresses", () => {
  it("reads records from either layer version, using the mailing city for unincorporated places", () => {
    const row = toAddressRow({ geometry: { coordinates: [-97.6, 34.9] }, properties: { fulladdr: "12488 160TH STREET", addnumber: 12488, street: "160TH", streettype: "STREET", city: "UNINCORPORATED", postcomm: "LINDSAY", zipcode: "73052" } }, "MCCLAIN", "addnumber");
    expect(row).toMatchObject({ key: "12488 160TH ST", city: "LINDSAY", zip: "73052", lat: 34.9, lng: -97.6 });
    expect(toAddressRow({ geometry: null, properties: { address: 1, street: "X" } }, "X", "address")).toBeNull();
  });

  it("finds an address as typed, with the city picking between same-named streets", async () => {
    const norman = await searchAddresses("1601 Zqdeskin Dr Norman, OK 73069");
    expect(norman[0].label).toBe("1601 Zqdeskin Dr, Norman, OK 73069");
    const lindsay = await searchAddresses("1601 Zqdeskin Lindsay");
    expect(lindsay[0].label).toBe("1601 Zqdeskin Street, Lindsay, OK 73052");
    expect((await searchAddresses("1601 Zqdesk")).map((m) => m.label)).toHaveLength(2);
    expect(await searchAddresses("Zqdeskin Dr")).toEqual([]);
  });

  it("Find uses the 911 list before the national geocoders", async () => {
    const r = await geocode("1601 Zqdeskin Drive, Norman OK");
    expect(r).toMatchObject({ source: "ok911", lat: 35.26028745, lng: -97.46507469 });
  });
});

describe("other places", () => {
  it("leaves addresses in other states and other cities to the national geocoders", async () => {
    expect(await searchAddresses("1601 Zqdeskin Dr, Austin, TX")).toEqual([]);
    expect(await searchAddresses("1601 Zqdeskin Dr Tulsa", undefined, 1, { strict: true })).toEqual([]);
    expect((await searchAddresses("1601 Zqdeskin Dr", undefined, 1, { strict: true }))[0].label).toContain("1601 Zqdeskin");
  });
});

afterAll(async () => {
  await db.delete(addressPoints).where(eq(addressPoints.county, COUNTY));
  await pool.end();
});
