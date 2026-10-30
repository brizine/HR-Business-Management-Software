// Waits until PostgreSQL accepts connections (up to 2 minutes), so a demo
// started right after the database container isn't tripped up by it still
// booting. Used by `pnpm demo`.
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgres://crewdesk:crewdesk@localhost:5432/crewdesk";
const deadline = Date.now() + 120_000;
let announced = false;

for (;;) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.end();
    console.log("✔ Database is ready.");
    break;
  } catch (err) {
    await client.end().catch(() => {});
    if (Date.now() > deadline) {
      console.error(`✖ Couldn't reach the database after 2 minutes (${err.message}).`);
      console.error("  In a codespace: open the Command Palette and run 'Codespaces: Rebuild Container'.");
      process.exit(1);
    }
    if (!announced) {
      console.log("… Waiting for the database to start…");
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
