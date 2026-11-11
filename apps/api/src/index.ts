import { buildApp } from "./app.js";
import { envPositiveInt, requireEnv } from "@vent/shared";

async function main() {
  const app = await buildApp();
  const port = envPositiveInt("API_PORT", 3000);
  const host = requireEnv("API_HOST");

  // While shutting down, close each connection as soon as its response is
  // done (including responses already streaming when the signal came).
  // Otherwise its idle keep-alive connection holds close() open for Fastify's
  // 72s keepAliveTimeout, long past Fly's kill.
  let shuttingDown = false;
  app.addHook("onResponse", async () => {
    if (shuttingDown) app.server.closeIdleConnections();
  });

  await app.listen({ port, host });
  console.log(`Vent API listening on ${host}:${port}`);

  // Fly stops a machine (deploy, scale-down) with SIGINT and force-kills it
  // after kill_timeout. Without this, Node exits at once and drops requests
  // in progress: a submit cut off after saving its run leaves it unqueued.
  // close() refuses new requests, ends run streams and relay sockets, waits
  // for the requests in progress, then runs the onClose hooks.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      shuttingDown = true;
      app.log.info({ signal }, "Shutting down: finishing requests in progress");
      app.close().then(
        () => process.exit(0),
        (err) => {
          app.log.error({ err }, "Shutdown failed");
          process.exit(1);
        },
      );
    });
  }
}

main().catch((err) => {
  console.error("Failed to start API:", err);
  process.exit(1);
});
