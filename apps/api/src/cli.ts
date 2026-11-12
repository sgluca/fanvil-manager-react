import { writeFileSync } from "node:fs";
import { Store } from "../../../packages/database/src/index.ts";
import { Secrets } from "../../../packages/fanvil-core/src/index.ts";
import { configFromEnv } from "./config.ts";
import { seedDemo } from "./services.ts";
import { createAdmin, readAdminPassword } from "./admin.ts";
import { acquireLock, restoreOffline } from "./maintenance.ts";
const [command, arg] = process.argv.slice(2),
  config = configFromEnv();
try {
  if (command === "restore") {
    if (!arg) throw Error("Indicare percorso backup");
    await restoreOffline(config.databasePath, arg);
    console.log("Ripristino completato");
  } else {
    const unlock = acquireLock(
        config.databasePath,
        command === "admin:create" ? "shared" : "exclusive",
      ),
      s = new Store(config.databasePath);
    try {
      if (command === "admin:create") {
        if (!arg) throw Error("Uso: admin:create nomeutente");
        await createAdmin(s, arg, await readAdminPassword());
        console.log("Amministratore creato");
      } else if (command === "demo:seed") {
        if (!config.demo) throw Error("Impostare DEMO_MODE=true");
        seedDemo(s, new Secrets(config.encryptionKey));
        console.log("Demo pronta");
      } else if (command === "backup") {
        if (!arg) throw Error("Indicare percorso backup");
        s.audit(null, "backup.cli");
        await s.backup(arg);
        writeFileSync(
          arg + ".json",
          JSON.stringify(
            {
              schemaVersion: 1,
              createdAt: new Date().toISOString(),
              requiresOriginalEncryptionKey: true,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        console.log("Backup e metadati creati");
      } else throw Error("Comandi: admin:create, demo:seed, backup, restore");
    } finally {
      s.close();
      unlock();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Comando fallito");
  process.exitCode = 1;
}
