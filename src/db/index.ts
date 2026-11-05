import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { env } from "../env.js";
import * as schema from "./schema.js";

/**
 * Long-running Express process, so a real pool against Neon's POOLED endpoint is
 * right here — not the serverless driver. Neon's free tier suspends compute after
 * idle, so keep the pool small and let it reconnect rather than holding many
 * sockets open against a sleeping compute.
 */
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (error) => {
  console.error("Unexpected database pool error", error);
});

export const db = drizzle(pool, { schema });

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
