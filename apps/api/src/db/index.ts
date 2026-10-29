import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://crewdesk:crewdesk@localhost:5432/crewdesk";

export const pool = new pg.Pool({ connectionString: DATABASE_URL });

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
