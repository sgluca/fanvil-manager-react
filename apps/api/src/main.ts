import { buildApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { acquireLock } from "./maintenance.ts";
const config = configFromEnv(),
  unlock = acquireLock(config.databasePath);
try {
  const app = await buildApp(config);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
    } finally {
      unlock();
    }
  };
  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
} catch (e) {
  unlock();
  console.error(e instanceof Error ? e.message : "Avvio fallito");
  process.exitCode = 1;
}
