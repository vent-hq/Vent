import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";

async function main() {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const client = postgres(connectionString, { max: 1 });
  try {
    const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
    // Keep Drizzle's migration ledger so generated and existing migrations
    // use the same hashes and timestamps.
    await client`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
    await client`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `;

    console.log("Running migrations...");
    let appliedCount = 0;
    for (const migration of migrations) {
      // Drizzle's PostgreSQL migrator wraps every pending file in one
      // transaction. On a fresh database, later files then cannot use enum
      // values added by earlier files. Each file needs a committed boundary.
      const applied = await client.begin(async (transaction) => {
        // Serialize concurrent release commands and re-read the ledger after
        // acquiring the lock. Transaction locks also work through PgBouncer.
        await transaction.unsafe("SELECT pg_advisory_xact_lock(173827, 1)");
        const [last] = await transaction.unsafe<{ created_at: string }[]>(
          'SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
        );
        if (last && Number(last.created_at) >= migration.folderMillis) return;

        for (const statement of migration.sql) {
          await transaction.unsafe(statement);
        }
        await transaction.unsafe(
          'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
          [migration.hash, migration.folderMillis],
        );
        return true;
      });
      if (applied) {
        appliedCount++;
        console.log(`Applied migration ${migration.folderMillis}`);
      }
    }
    console.log(`Migrations complete (${appliedCount} applied).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
