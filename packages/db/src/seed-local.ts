import { createHash } from "node:crypto";
import postgres from "postgres";

async function main() {
  const url = new URL(process.env["DATABASE_URL"] ?? "");
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/vent_local") {
    throw new Error("Local seeding requires the local vent_local database.");
  }

  const token = "vent_010101010101010101010101010101010101010101010101";
  const hash = createHash("sha256").update(token).digest("hex");
  const sql = postgres(url.toString(), { max: 1 });
  try {
    await sql`
      INSERT INTO access_tokens (user_id, token_hash, name, prefix)
      VALUES ('local-developer', ${hash}, 'Local development', ${token.slice(0, 12)})
      ON CONFLICT (token_hash) DO UPDATE SET revoked_at = NULL
    `;
    console.log("Local development token ready.");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
