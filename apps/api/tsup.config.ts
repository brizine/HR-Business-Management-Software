import { defineConfig } from "tsup";

export default defineConfig({
  // server.ts: API only (development). main.ts: API + website (production).
  // backup-cli.ts: backup commands, built so they run on hosts without dev tools.
  entry: ["src/server.ts", "src/main.ts", "src/backup-cli.ts"],
  format: "esm",
  target: "node22",
  // Bundle the workspace package (it ships TypeScript source); keep npm deps external.
  noExternal: ["@crewdesk/shared"],
});
