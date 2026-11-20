import { describe, expect, it } from "vitest";
import { OK_COUNTIES, addressKey, countyLabel, titleCaseAddress, typedAddressKeys, typedStreetWords } from "../src/addresses";

describe("address keys", () => {
  it("builds keys from 911 records", () => {
    expect(addressKey({ number: 1601, street: "DESKIN", streetType: "DRIVE" })).toBe("1601 DESKIN DR");
    expect(addressKey({ number: 12488, street: "160TH", streetType: "STREET", sufDir: null })).toBe("12488 160TH ST");
    expect(addressKey({ number: 933, street: "AMBIVI", streetType: "CIRCLE", sufDir: " " })).toBe("933 AMBIVI CIR");
  });

  it("matches what people type, with or without direction, type spelled out, city and ZIP", () => {
    expect(typedAddressKeys("1601 Deskin Dr Norman, OK 73069")!.keys[0]).toBe("1601 DESKIN DR NORMAN");
    expect(typedAddressKeys("1601 Deskin Dr Norman, OK 73069")!.keys).toContain("1601 DESKIN DR");
    expect(typedAddressKeys("1601 Deskin Drive")!.keys[0]).toBe("1601 DESKIN DR");
    expect(typedAddressKeys("201 W. Gray St")!.keys[0]).toBe("201 GRAY ST");
    expect(typedAddressKeys("201 West Gray")!.keys[0]).toBe("201 GRAY");
    expect(typedAddressKeys("1601 Desk")!.keys[0]).toBe("1601 DESK");
    expect(typedAddressKeys("1601 Deskin Dr Norman OK 73069")!.extra).toEqual(expect.arrayContaining(["NORMAN", "OK", "73069"]));
    expect(typedAddressKeys("Deskin Dr")).toBeNull();
  });

  it("formats for display", () => {
    expect(titleCaseAddress("1601 DESKIN DR")).toBe("1601 Deskin Dr");
    expect(titleCaseAddress("201 W GRAY ST")).toBe("201 W Gray St");
    expect(titleCaseAddress("12488 160TH ST")).toBe("12488 160th St");
    expect(countyLabel("MCCLAIN")).toBe("McClain County");
    expect(countyLabel("LE FLORE")).toBe("Le Flore County");
    expect(OK_COUNTIES).toHaveLength(77);
  });
});

describe("street names typed without a number", () => {
  it("turns them into words to look for", () => {
    expect(typedStreetWords("Deskin")).toEqual(["DESKIN"]);
    expect(typedStreetWords("deskin drive")).toEqual(["DESKIN", "DR"]);
    expect(typedStreetWords("W Gray St")).toEqual(["GRAY", "ST"]);
    expect(typedStreetWords("Deskin Dr, Norman OK")).toEqual(["DESKIN", "DR"]);
    expect(typedStreetWords("1601 Deskin")).toBeNull();
    expect(typedStreetWords("ab")).toBeNull();
  });
});
