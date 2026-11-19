/** Turning Photon's answers into address suggestions. */
import { describe, expect, it } from "vitest";
import { toSuggestions } from "../src/lib/suggest";

const f = (props: Record<string, string>, lng = -97.44, lat = 35.22) => ({ geometry: { coordinates: [lng, lat] as [number, number] }, properties: { countrycode: "US", ...props } });

describe("address suggestions", () => {
  it("formats full addresses and drops duplicates", () => {
    const s = toSuggestions("201 W Gray", [
      f({ type: "house", housenumber: "201", street: "West Gray Street", city: "Norman", state: "Oklahoma", postcode: "73069" }),
      f({ type: "house", housenumber: "201", street: "West Gray Street", city: "Norman", state: "Oklahoma", postcode: "73069" }),
    ]);
    expect(s).toEqual([{ label: "201 West Gray Street, Norman, OK 73069", lat: 35.22, lng: -97.44, kind: "address", lookUp: false }]);
  });

  it("adds the typed house number to a street result and marks it for an exact lookup", () => {
    const [s] = toSuggestions("1600 S Main St Moore", [f({ type: "street", name: "South Main Street", city: "Moore", state: "Oklahoma", postcode: "73160" })]);
    expect(s).toMatchObject({ label: "1600 South Main Street, Moore, OK 73160", kind: "address", lookUp: true });
  });

  it("lists streets without a number, towns, and skips other countries", () => {
    const s = toSuggestions("Porter", [
      f({ type: "street", name: "North Porter Avenue", city: "Norman", state: "Oklahoma", postcode: "73069" }),
      f({ type: "city", name: "Blanchard", county: "McClain", state: "Oklahoma" }),
      f({ type: "street", name: "Porter Road", city: "Toronto", countrycode: "CA" }),
    ]);
    expect(s.map((x) => [x.label, x.kind])).toEqual([["North Porter Avenue, Norman, OK 73069", "street"], ["Blanchard, OK", "place"]]);
  });
});
