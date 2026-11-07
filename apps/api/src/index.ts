import { buildApp } from "./app.js";

async function main() {
  const app = await buildApp();
  const port = parseInt(process.env["API_PORT"] ?? "3000", 10);
  const host = process.env["API_HOST"] ?? "0.0.0.0";

  await app.listen({ port, host });
  console.log(`Vent API listening on ${host}:${port}`);
}

main().catch((err) => {
  console.error("Failed to start API:", err);
  process.exit(1);
});
