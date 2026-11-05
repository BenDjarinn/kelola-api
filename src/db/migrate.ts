import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDatabase, db } from "./index.js";

/**
 * Applies pending migrations using drizzle-orm's runtime migrator.
 *
 * Deliberately not `drizzle-kit migrate`: drizzle-kit is a devDependency, and hosts
 * that set NODE_ENV=production (Railway, Render) make npm skip devDependencies
 * entirely, so the drizzle-kit script is unavailable exactly where migrations need
 * to run. The migrator lives in drizzle-orm, which is a runtime dependency.
 *
 * Reads the SQL from ./drizzle relative to the process working directory, so it must
 * be run from the repository root — which is where both `npm start` and a host's
 * release command already run.
 */
async function main(): Promise<void> {
  await migrate(db, { migrationsFolder: "./drizzle" });
}

main()
  .then(async () => {
    console.log("Migrations applied.");
    await closeDatabase();
  })
  .catch(async (error: unknown) => {
    console.error("Migration failed", error);
    await closeDatabase();
    // Non-zero exit so a deploy that cannot migrate fails the release step rather
    // than booting a server against a stale schema.
    process.exit(1);
  });
