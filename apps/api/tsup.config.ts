import { defineConfig } from "tsup";

export default defineConfig({
  // server.ts: API only (development). main.ts: API + website (production); start.ts runs it with a log file.
  // backup-cli.ts and email-test.ts: commands, built so they run on hosts without dev tools.
  entry: ["src/server.ts", "src/main.ts", "src/start.ts", "src/backup-cli.ts", "src/email-test.ts"],
  format: "esm",
  target: "node22",
  // Bundle the workspace package (it ships TypeScript source); keep npm deps external.
  noExternal: ["@crewdesk/shared"],
});
