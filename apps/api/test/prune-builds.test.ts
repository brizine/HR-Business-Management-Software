/** Removing old SiteGround build copies (each is ~57,000 files on the hosting plan). */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeOlderBuilds } from "../src/lib/prune-builds";

let root = "";
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function layout(builds: string[], latest: string) {
  root = mkdtempSync(join(tmpdir(), "prune-"));
  const nodeapp = join(root, ".nodeapp");
  for (const b of builds) mkdirSync(join(nodeapp, b, "app_source", "node_modules"), { recursive: true });
  symlinkSync(join(nodeapp, latest), join(nodeapp, "latest"));
  return nodeapp;
}

describe("removing old builds", () => {
  it("keeps the running build and latest; removes only older ones", () => {
    const nodeapp = layout(["1794000001-aaaaaa", "1794000002-bbbbbb", "1794000003-cccccc", "1794000009-zzzzzz"], "1794000003-cccccc");
    const removed = removeOlderBuilds(join(nodeapp, "1794000003-cccccc", "app_source"), () => {});
    expect(removed.sort()).toEqual(["1794000001-aaaaaa", "1794000002-bbbbbb"]);
    // A newer build (a deploy in progress) is never touched.
    expect(readdirSync(nodeapp).sort()).toEqual(["1794000003-cccccc", "1794000009-zzzzzz", "latest"]);
  });

  it("follows the latest link when started from it, and does nothing elsewhere", () => {
    const nodeapp = layout(["1794000001-aaaaaa", "1794000002-bbbbbb"], "1794000002-bbbbbb");
    expect(removeOlderBuilds(join(nodeapp, "latest", "app_source"), () => {})).toEqual(["1794000001-aaaaaa"]);
    expect(removeOlderBuilds(process.cwd(), () => {})).toEqual([]);
  });
});
