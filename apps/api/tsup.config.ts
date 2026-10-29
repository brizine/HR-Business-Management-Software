import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: "esm",
  target: "node22",
  // Bundle the workspace package (it ships TypeScript source); keep npm deps external.
  noExternal: ["@crewdesk/shared"],
});
