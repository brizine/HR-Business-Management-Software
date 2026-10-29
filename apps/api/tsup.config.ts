import { defineConfig } from "tsup";

export default defineConfig({
  // server.ts: API only (development). main.ts: API + website (production).
  entry: ["src/server.ts", "src/main.ts"],
  format: "esm",
  target: "node22",
  // Bundle the workspace package (it ships TypeScript source); keep npm deps external.
  noExternal: ["@crewdesk/shared"],
});
