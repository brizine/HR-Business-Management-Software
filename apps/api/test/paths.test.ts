import { describe, expect, it } from "vitest";
import { folderPath } from "../src/lib/paths";

describe("folder settings", () => {
  it("expands ~ to the account's home folder", () => {
    expect(folderPath("~/crewdesk-uploads", "/home/customer")).toBe("/home/customer/crewdesk-uploads");
    expect(folderPath("~", "/home/customer")).toBe("/home/customer");
    expect(folderPath(" ~/a/b ", "/home/u1")).toBe("/home/u1/a/b");
  });
  it("keeps full paths and makes relative ones full", () => {
    expect(folderPath("/srv/uploads", "/home/x")).toBe("/srv/uploads");
    expect(folderPath("./uploads", "/home/x")).toBe(`${process.cwd()}/uploads`);
  });
});
