/** Finding a job site's coordinates from an address or a maps link (network calls are faked). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { geocode } from "../src/lib/geocode";

type Reply = { status?: number; json?: unknown; location?: string };
function fakeNetwork(routes: Record<string, Reply>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r: Reply = key ? routes[key] : { status: 404, json: [] };
    return new Response(r.json === undefined ? "" : JSON.stringify(r.json), { status: r.status ?? (r.location ? 302 : 200), headers: r.location ? { location: r.location } : {} });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("geocode", () => {
  it("reads coordinates and full map links without going online", async () => {
    const calls = fakeNetwork({});
    expect(await geocode("30.2672, -97.7431")).toMatchObject({ lat: 30.2672, lng: -97.7431, source: "coordinates" });
    expect(await geocode("https://www.google.com/maps/place/Zilker/@30.2669,-97.7729,15z")).toMatchObject({ lat: 30.2669, lng: -97.7729 });
    expect(calls).toEqual([]);
  });

  it("follows a Google short share link to the full link", async () => {
    fakeNetwork({ "https://maps.app.goo.gl/abc": { location: "https://www.google.com/maps/place/Riverside+HOA/@30.25,-97.71,17z/data=!3d30.2501!4d-97.7102" } });
    expect(await geocode("https://maps.app.goo.gl/abc")).toMatchObject({ lat: 30.25, lng: -97.71, label: "Riverside HOA", source: "link" });
  });

  it("looks up a short link that only names the place", async () => {
    fakeNetwork({
      "https://maps.app.goo.gl/xyz": { location: "https://maps.google.com/?q=100+Main+St,+Austin,+TX" },
      "https://geocoding.geo.census.gov/": { json: { result: { addressMatches: [{ matchedAddress: "100 MAIN ST, AUSTIN, TX, 78701", coordinates: { x: -97.74, y: 30.27 } }] } } },
    });
    expect(await geocode("https://maps.app.goo.gl/xyz")).toMatchObject({ lat: 30.27, lng: -97.74, source: "census" });
  });

  it("turns a street address into coordinates, falling back to OpenStreetMap", async () => {
    const calls = fakeNetwork({
      "https://geocoding.geo.census.gov/": { json: { result: { addressMatches: [] } } },
      "https://nominatim.openstreetmap.org/": { json: [{ lat: "30.1", lon: "-97.6", display_name: "Riverside Park, Austin" }] },
    });
    expect(await geocode("Riverside Park, Austin TX")).toEqual({ lat: 30.1, lng: -97.6, label: "Riverside Park, Austin", source: "openstreetmap" });
    expect(calls[0]).toContain("address=Riverside%20Park%2C%20Austin%20TX");
  });

  it("returns null when nothing is found, and never fetches other websites", async () => {
    const calls = fakeNetwork({ "https://geocoding.geo.census.gov/": { json: { result: { addressMatches: [] } } } });
    expect(await geocode("nowhere at all")).toBeNull();
    expect(await geocode("https://example.com/somewhere")).toBeNull();
    expect(calls.some((c) => c.includes("example.com"))).toBe(false);
  });
});
