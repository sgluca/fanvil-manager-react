import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { hash } from "argon2";
import { Store } from "../../packages/database/src/index.ts";
import { buildApp } from "../../apps/api/src/app.ts";
const dir = mkdtempSync(join(tmpdir(), "fanvil-e2e-")),
  s = new Store(join(dir, "e2e.sqlite"));
s.run(
  "INSERT INTO admin_users(id,username,password_hash,role) VALUES(?,?,?,?)",
  randomUUID(),
  "demo-admin",
  await hash("E2E-synthetic-password-2026"),
  "admin",
);
const app = await buildApp(
  {
    databasePath: s.path,
    encryptionKey: randomBytes(32).toString("hex"),
    sessionSecret: randomBytes(32).toString("hex"),
    production: false,
    origin: "http://127.0.0.1:3100",
    demo: true,
    realRead: false,
    cidrs: [],
    timeoutMs: 100,
    retentionDays: 90,
    eventCollectMinutes: 0,
    webRoot: resolve("apps/web/dist"),
  },
  s,
);
await app.listen({ port: 3100, host: "127.0.0.1" });
process.on("SIGTERM", () => {
  void app.close().then(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
