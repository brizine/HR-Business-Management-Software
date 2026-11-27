import { describe, expect, it } from "vitest";
import { CUSTOMER_COLUMNS, CUSTOMER_FILTER_FIELDS, DEFAULT_CUSTOMER_COLUMNS, describeFilter, filterField, filterReady, parseCustomerFilters } from "../src";

describe("customer list filters", () => {
  it("reads filters from the query string and ignores junk", () => {
    expect(parseCustomerFilters(JSON.stringify([{ f: "balance", op: "gt", v: 50 }]))).toEqual([{ f: "balance", op: "gt", v: 50 }]);
    expect(parseCustomerFilters("not json")).toEqual([]);
    expect(parseCustomerFilters(JSON.stringify({ f: "x" }))).toEqual([]);
    expect(parseCustomerFilters(undefined)).toEqual([]);
  });

  it("describes each kind of filter for its chip", () => {
    const f = (k: string) => filterField(k);
    expect(describeFilter({ f: "balance", op: "gt", v: 50 }, { field: f("balance") })).toBe("Balance owed more than $50");
    expect(describeFilter({ f: "name", op: "starts", v: "Jo" }, { field: f("name") })).toBe('Name starts with "Jo"');
    expect(describeFilter({ f: "email", op: "blank" }, { field: f("email") })).toBe("Email is blank");
    expect(describeFilter({ f: "status", op: "isnot", v: ["cancelled"] }, { field: f("status") })).toBe("Status is not Inactive");
    expect(describeFilter({ f: "tags", op: "any", v: ["a", "b"] }, { field: f("tags"), tagName: (id) => (id === "a" ? "MAP 100" : "MAP 200") })).toBe("Tags has any of MAP 100, MAP 200");
    expect(describeFilter({ f: "since", op: "between", v: "2026-01-01", v2: "2026-03-31" }, { field: f("since") })).toBe("Customer since Jan 1, 2026 – Mar 31, 2026");
    expect(describeFilter({ f: "lastService", op: "never" }, { field: f("lastService") })).toBe("Last service: never");
    expect(describeFilter({ f: "service", op: "completed", v: ["s1"], from: "2026-04-01" }, { field: f("service"), serviceName: () => "Core aeration" })).toBe("Core aeration completed (Apr 1, 2026 – now)");
    expect(describeFilter({ f: "nextService", op: "no" }, { field: f("nextService") })).toBe("Nothing scheduled");
  });

  it("knows when a filter is ready to apply", () => {
    expect(filterReady({ f: "balance", op: "between", v: 10 }, filterField("balance"))).toBe(false);
    expect(filterReady({ f: "balance", op: "between", v: 10, v2: 20 }, filterField("balance"))).toBe(true);
    expect(filterReady({ f: "name", op: "contains", v: " " }, filterField("name"))).toBe(false);
    expect(filterReady({ f: "email", op: "blank" }, filterField("email"))).toBe(true);
    expect(filterReady({ f: "status", op: "nope", v: ["active"] }, filterField("status"))).toBe(false);
  });

  it("turns custom fields into filters by type", () => {
    const custom = [{ id: "c1", name: "Grass type", type: "select", options: ["Bermuda", "Fescue"] }, { id: "c2", name: "Gallons", type: "decimal", options: [] }];
    expect(filterField("cf:c1", custom)).toMatchObject({ label: "Grass type", kind: "enum", options: [["Bermuda", "Bermuda"], ["Fescue", "Fescue"]] });
    expect(filterField("cf:c2", custom)?.kind).toBe("number");
    expect(filterField("cf:zz", custom)).toBeUndefined();
  });

  it("has more columns than Homeworks, nine on by default, each key once", () => {
    expect(CUSTOMER_COLUMNS.length).toBeGreaterThan(20);
    expect(DEFAULT_CUSTOMER_COLUMNS).toHaveLength(9);
    expect(new Set(CUSTOMER_COLUMNS.map((c) => c.key)).size).toBe(CUSTOMER_COLUMNS.length);
    expect(new Set(CUSTOMER_FILTER_FIELDS.map((c) => c.key)).size).toBe(CUSTOMER_FILTER_FIELDS.length);
  });
});
