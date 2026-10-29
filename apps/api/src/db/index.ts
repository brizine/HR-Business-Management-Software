import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://crewdesk:crewdesk@localhost:5432/crewdesk",
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
