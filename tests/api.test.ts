import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { hash } from "argon2";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { join } from "node:path";
import { buildApp } from "../apps/api/src/app.ts";
import { Store } from "../packages/database/src/index.ts";
import { Secrets } from "../packages/fanvil-core/src/index.ts";
import { remote } from "../apps/api/src/services.ts";
import { acquireLock, restoreOffline } from "../apps/api/src/maintenance.ts";
const dir = mkdtempSync(join(tmpdir(), "fanvil-test-")),
  key = randomBytes(32).toString("hex"),
  password = "test-password-only-123";
const s = new Store(join(dir, "test.sqlite")),
  secrets = new Secrets(key);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = "",
  csrf = "",
  personId = "",
  credentialId = "",
  device: any,
  job: any;
const call = async (
  method: string,
  url: string,
  payload?: any,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: method as any,
    url: "/api" + url,
    payload,
    headers: { cookie, "x-csrf-token": csrf, ...headers },
  });
beforeAll(async () => {
  s.run(
    "INSERT INTO admin_users(id,username,password_hash,role) VALUES(?,?,?,?)",
    randomUUID(),
    "admin",
    await hash(password),
    "admin",
  );
  app = await buildApp(
    {
      databasePath: s.path,
      encryptionKey: key,
      sessionSecret: randomBytes(32).toString("hex"),
      production: false,
      origin: "http://localhost:3000",
      demo: true,
      realRead: false,
      cidrs: [],
      timeoutMs: 100,
      retentionDays: 90,
      eventCollectMinutes: 0,
    },
    s,
  );
  await app.ready();
  const r = await call("POST", "/auth/login", { username: "admin", password });
  expect(r.statusCode).toBe(200);
  cookie = r.headers["set-cookie"]!.toString().split(";")[0];
  csrf = r.json().csrf;
}, 30000);
afterAll(async () => {
  await app?.close();
  s.close();
  rmSync(dir, { recursive: true, force: true });
});
describe("Flusso completo con SQLite e adapter mock", () => {
  it("nega accesso anonimo e CSRF", async () => {
    expect((await app.inject("/api/people")).statusCode).toBe(401);
    expect(
      (
        await call(
          "POST",
          "/people",
          { name: "Denied" },
          { "x-csrf-token": "wrong" },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          "POST",
          "/people",
          { name: "Denied" },
          { origin: "https://evil.invalid" },
        )
      ).statusCode,
    ).toBe(403);
  });
  it("demo persistente con quattro modelli e due relay per i62", async () => {
    const r = await call("GET", "/devices");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(4);
    device = r.json().find((d: any) => d.model === "i62");
    expect(device.relays).toHaveLength(2);
    expect(JSON.stringify(r.json())).not.toContain("secret");
  });
  it("crea e aggiorna persona senza perdere stato precedente", async () => {
    let r = await call("POST", "/people", {
      name: "Test Persona",
      notes: "Originale",
      active: false,
    });
    expect(r.statusCode).toBe(201);
    personId = r.json().id;
    r = await call("PATCH", "/people/" + personId, {
      name: "Test Persona aggiornata",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ notes: "Originale", active: false });
    await call("PATCH", "/people/" + personId, { active: true });
  });
  it("RFID e PIN cifrati, mascherati e assenti da audit", async () => {
    let r = await call("POST", "/credentials", {
      personId,
      kind: "rfid",
      value: "DEMO-TEST-CARD-1234",
    });
    expect(r.statusCode).toBe(201);
    credentialId = r.json().id;
    expect(r.body).not.toContain("DEMO-TEST-CARD-1234");
    r = await call("POST", "/credentials", {
      personId,
      kind: "pin",
      value: "9988776655",
    });
    expect(r.statusCode).toBe(201);
    expect(r.body).not.toContain("9988776655");
    expect(
      s.get("SELECT secret FROM credentials WHERE id=?", r.json().id)?.secret,
    ).not.toContain("9988776655");
    expect(JSON.stringify(s.all("SELECT * FROM audit_logs"))).not.toContain(
      "9988776655",
    );
  });
  it("permessi su relay specifico e anteprima preservano gli sconosciuti", async () => {
    const r = await call("POST", "/rules", {
      personId,
      deviceId: device.id,
      relayId: device.relays[1].id,
    });
    expect(r.statusCode).toBe(201);
    const before = remote(s, secrets, device.id);
    const p = await call("POST", "/devices/" + device.id + "/sync/preview", {
      confirm: true,
    });
    expect(p.statusCode).toBe(200);
    job = p.json();
    expect(job.operations).toHaveLength(2);
    expect(job.operations.every((o: any) => o.action === "upsert")).toBe(true);
    expect(remote(s, secrets, device.id)).toEqual(before);
  });
  it("apply richiede conferma ed è idempotente con verifica post-scrittura", async () => {
    expect(
      (await call("POST", "/sync/" + job.id + "/apply", {})).statusCode,
    ).toBe(400);
    let r = await call("POST", "/sync/" + job.id + "/apply", { confirm: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("applied");
    const data = remote(s, secrets, device.id);
    expect(
      data.find((v) => v.remoteId === "managed-" + credentialId)?.relayNumbers,
    ).toEqual([2]);
    expect(data.some((v) => v.remoteId === "demo-existing-001")).toBe(true);
    r = await call("POST", "/sync/" + job.id + "/apply", { confirm: true });
    expect(r.statusCode).toBe(200);
    expect(remote(s, secrets, device.id)).toEqual(data);
  });
  it("rileva anteprime obsolete e non applica modifiche", async () => {
    const p = (
      await call("POST", "/devices/" + device.id + "/sync/preview", {
        confirm: true,
      })
    ).json();
    await call("PATCH", "/credentials/" + credentialId, { revoked: true });
    const r = await call("POST", "/sync/" + p.id + "/apply", { confirm: true });
    expect(r.statusCode).toBe(409);
    expect(s.get("SELECT status FROM sync_jobs WHERE id=?", p.id)?.status).toBe(
      "conflict",
    );
  });
  it("revoca esplicita appare in preview senza rimuovere sconosciuti", async () => {
    const p = (
      await call("POST", "/devices/" + device.id + "/sync/preview", {
        confirm: true,
      })
    ).json();
    expect(
      p.operations.some(
        (o: any) => o.action === "remove" && o.credential_id === credentialId,
      ),
    ).toBe(true);
    expect(
      (await call("POST", "/sync/" + p.id + "/apply", { confirm: true }))
        .statusCode,
    ).toBe(200);
    expect(
      remote(s, secrets, device.id).some(
        (v) => v.remoteId === "demo-existing-001",
      ),
    ).toBe(true);
  });
  it("staging e riconciliazione ripetuta non duplicano persone o credenziali", async () => {
    const other = (await call("GET", "/devices"))
      .json()
      .find((d: any) => d.model === "i60");
    const batch = (
      await call("POST", "/devices/" + other.id + "/import", { confirm: true })
    ).json();
    expect(batch.items.length).toBe(1);
    expect(JSON.stringify(batch)).not.toContain("DEMO-EXISTING-001");
    let r = await call("POST", "/imports/" + batch.id + "/reconcile", {
      confirm: true,
      mappings: {},
    });
    expect(r.statusCode).toBe(200);
    const count = s.get("SELECT COUNT(*) n FROM people")!.n;
    const ccount = s.get("SELECT COUNT(*) n FROM credentials")!.n;
    const b2 = (
      await call("POST", "/devices/" + other.id + "/import", { confirm: true })
    ).json();
    r = await call("POST", "/imports/" + b2.id + "/reconcile", {
      confirm: true,
      mappings: {},
    });
    expect(r.statusCode).toBe(200);
    expect(s.get("SELECT COUNT(*) n FROM people")!.n).toBe(count);
    expect(s.get("SELECT COUNT(*) n FROM credentials")!.n).toBe(ccount);
  });
  it("events deduplicati, filtri, paginazione ed esportazioni", async () => {
    const n = s.get("SELECT COUNT(*) n FROM access_events")!.n;
    await call("POST", "/devices/" + device.id + "/events/collect", {
      confirm: true,
    });
    await call("POST", "/devices/" + device.id + "/events/collect", {
      confirm: true,
    });
    expect(s.get("SELECT COUNT(*) n FROM access_events")!.n).toBe(n);
    let r = await call(
      "GET",
      "/events?deviceId=" + device.id + "&outcome=denied&limit=1",
    );
    expect(r.json().items).toHaveLength(1);
    expect(r.json().total).toBe(1);
    r = await call("GET", "/events?format=csv");
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.body).toContain("occurred_at");
  });
  it("nessun comando pericoloso e scritture reali bloccate", async () => {
    const d = await call("POST", "/devices", {
      name: "Reale non contattato",
      model: "i60",
      host: "device.invalid",
      mode: "real",
    });
    expect(d.statusCode).toBe(201);
    const real = d.json();
    expect(
      (
        await call("POST", "/devices/" + real.id + "/inspect", {
          operation: "deviceInfo",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call("POST", "/relays/" + real.relays[0].id + "/open", {
          confirm: true,
        })
      ).statusCode,
    ).toBe(409);
    const p = (
      await call("POST", "/devices/" + real.id + "/sync/preview", {
        confirm: true,
      })
    ).json();
    expect(
      (await call("POST", "/sync/" + p.id + "/apply", { confirm: true }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call("POST", "/devices/" + real.id + "/import", { confirm: true }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call("POST", "/devices/" + real.id + "/inspect", {
          operation: "reboot",
        })
      ).statusCode,
    ).toBe(400);
  });
  it("audit non modificabile neppure per errore applicativo e backup consistente", async () => {
    expect(() => s.run("UPDATE audit_logs SET action='tampered'")).toThrow(
      "immutable",
    );
    expect(() => s.run("DELETE FROM audit_logs")).toThrow("immutable");
    const r = await call("POST", "/backup", { confirm: true });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.subarray(0, 15).toString()).toBe("SQLite format 3");
  });
  it("ruolo lettura non modifica, operatore non amministra", async () => {
    for (const role of ["lettura", "operatore"]) {
      const u = await call("POST", "/users", {
        username: role,
        password,
        role,
      });
      expect(u.statusCode).toBe(201);
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: role, password },
      });
      const h = {
        cookie: login.headers["set-cookie"]!.toString().split(";")[0],
        "x-csrf-token": login.json().csrf,
      };
      const read = await app.inject({ url: "/api/people", headers: h });
      expect(read.statusCode).toBe(200);
      const r = await app.inject({
        method: "POST",
        url: "/api/people",
        headers: h,
        payload: { name: "RBAC " + role },
      });
      expect(r.statusCode).toBe(role === "lettura" ? 403 : 201);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/backup",
            headers: h,
            payload: { confirm: true },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: "/api/users", headers: h })).statusCode,
      ).toBe(403);
    }
  });
  it("gruppi, membership e vincolo relay mantengono i permessi coerenti", async () => {
    const g = (
      await call("POST", "/groups", { name: "Gruppo integrazione" })
    ).json();
    expect(
      (await call("POST", "/groups/" + g.id + "/members", { personId }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call("POST", "/rules", {
          groupId: g.id,
          deviceId: device.id,
          relayId: device.relays[0].id,
        })
      ).statusCode,
    ).toBe(201);
    const other = (await call("GET", "/devices"))
      .json()
      .find((d: any) => d.id !== device.id);
    expect(
      (
        await call("POST", "/rules", {
          personId,
          deviceId: other.id,
          relayId: device.relays[0].id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call("DELETE", "/groups/" + g.id + "/members/" + personId))
        .statusCode,
    ).toBe(200);
    expect((await call("DELETE", "/groups/" + g.id)).statusCode).toBe(200);
    expect(
      s.get("SELECT id FROM access_rules WHERE group_id=?", g.id),
    ).toBeUndefined();
  });
  it("fallimento apply esegue rollback e permette retry sicuro", async () => {
    await call("PATCH", "/credentials/" + credentialId, { revoked: false });
    const p = (
      await call("POST", "/devices/" + device.id + "/sync/preview", {
        confirm: true,
      })
    ).json();
    const op = s.get("SELECT * FROM sync_operations WHERE job_id=?", p.id)!;
    const before = remote(s, secrets, device.id);
    s.run(
      "UPDATE sync_operations SET payload=? WHERE id=?",
      "corrupted",
      op.id,
    );
    expect(
      (await call("POST", "/sync/" + p.id + "/apply", { confirm: true }))
        .statusCode,
    ).toBe(409);
    expect(s.get("SELECT status FROM sync_jobs WHERE id=?", p.id)?.status).toBe(
      "failed",
    );
    expect(remote(s, secrets, device.id)).toEqual(before);
    s.run("UPDATE sync_operations SET payload=? WHERE id=?", op.payload, op.id);
    expect(
      (await call("POST", "/sync/" + p.id + "/apply", { confirm: true })).json()
        .status,
    ).toBe("applied");
  });
  it("scadenza locale esclude credenziali e nomi uguali richiedono riconciliazione", async () => {
    const expiry = (
      await call("POST", "/credentials", {
        personId,
        kind: "rfid",
        value: "EXPIRED-TEST-ONLY",
        expiresAt: "2000-01-01T00:00:00.000Z",
      })
    ).json();
    const p = (
      await call("POST", "/devices/" + device.id + "/sync/preview", {
        confirm: true,
      })
    ).json();
    expect(p.operations.some((o: any) => o.credential_id === expiry.id)).toBe(
      false,
    );
    const d = (
      await call("POST", "/devices", {
        name: "Conflitto nome",
        model: "i60",
        host: "conflict.demo.invalid",
        mode: "demo",
      })
    ).json();
    const list = [
      {
        remoteId: "unique-remote",
        name: "Test Persona aggiornata",
        kind: "rfid",
        value: "UNIQUE-TEST-CARD",
      },
    ];
    s.run(
      "UPDATE mock_remote SET data=? WHERE device_id=?",
      secrets.encrypt(list),
      d.id,
    );
    const batch = (
      await call("POST", "/devices/" + d.id + "/import", { confirm: true })
    ).json();
    const count = s.get("SELECT COUNT(*) n FROM people")!.n;
    expect(
      (
        await call("POST", "/imports/" + batch.id + "/reconcile", {
          confirm: true,
          mappings: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(s.get("SELECT COUNT(*) n FROM people")!.n).toBe(count);
    expect(
      (
        await call("POST", "/imports/" + batch.id + "/reconcile", {
          confirm: true,
          mappings: { [batch.items[0].id]: personId },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("gestione utenti invalida sessioni e protegge ultimo admin", async () => {
    const admin = s.get("SELECT id FROM admin_users WHERE username='admin'")!;
    expect(
      (await call("PATCH", "/users/" + admin.id, { active: false })).statusCode,
    ).toBe(409);
    const user = s.get(
      "SELECT id FROM admin_users WHERE username='operatore'",
    )!;
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "operatore", password },
    });
    const h = { cookie: login.headers["set-cookie"]!.toString().split(";")[0] };
    expect(
      (await app.inject({ url: "/api/people", headers: h })).statusCode,
    ).toBe(200);
    expect(
      (await call("PATCH", "/users/" + user.id, { active: false })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/people", headers: h })).statusCode,
    ).toBe(401);
  });
  it("inspector comunica il blocco preciso e salva diagnostica sanitizzata senza contattare il dispositivo", async () => {
    const d = (
      await call("POST", "/devices", {
        name: "Diagnostica read disabled",
        model: "i60",
        host: "never-contact.invalid",
        mode: "real",
        approved: true,
        username: "synthetic-user",
        password: "synthetic-secret-do-not-log",
      })
    ).json();
    const r = await call("POST", "/devices/" + d.id + "/inspect", {
      operation: "deviceInfo",
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("FANVIL_READ_DISABLED");
    expect(r.json().error).toContain("FANVIL_READ_ENABLED=true");
    const diagnostics = (
      await call("GET", "/devices/" + d.id + "/diagnostics")
    ).json();
    expect(diagnostics[0].metadata.code).toBe("FANVIL_READ_DISABLED");
    expect(JSON.stringify(diagnostics)).not.toContain(
      "synthetic-secret-do-not-log",
    );
    expect(
      JSON.stringify(
        s.all("SELECT * FROM audit_logs WHERE action='inspector.failed'"),
      ),
    ).not.toContain("synthetic-secret-do-not-log");
  });
  it("OpenAPI contiene le operazioni protette e schemi", async () => {
    const r = await call("GET", "/docs/json");
    expect(r.statusCode).toBe(200);
    expect(r.json().paths["/api/devices/{id}/sync/preview"]).toBeDefined();
  });
});
describe("Ripristino offline", () => {
  it("lock esclusivo si libera dopo crash di un processo separato", async () => {
    const database = join(dir, "crash.sqlite");
    const code = `import {acquireLock} from ${JSON.stringify(pathToFileURL(resolve("apps/api/src/maintenance.ts")).href)};acquireLock(${JSON.stringify(database)});console.log('locked');setInterval(()=>{},1000);`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout, "data");
      expect(() => acquireLock(database)).toThrow("in uso");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const release = acquireLock(database);
      release();
    } finally {
      child.kill("SIGKILL");
    }
  }, 10000);

  it("blocca DB in uso, verifica backup e conserva copia preventiva", async () => {
    const dest = join(dir, "restore.sqlite"),
      source = join(dir, "snapshot.sqlite");
    const a = new Store(dest);
    a.run(
      "INSERT INTO people VALUES(?,?,?,?,?,?)",
      randomUUID(),
      "Prima",
      "",
      1,
      1,
      new Date().toISOString(),
    );
    await a.backup(source);
    a.run(
      "INSERT INTO people VALUES(?,?,?,?,?,?)",
      randomUUID(),
      "Dopo",
      "",
      1,
      1,
      new Date().toISOString(),
    );
    a.close();
    const release = acquireLock(dest);
    await expect(restoreOffline(dest, source)).rejects.toThrow("in uso");
    release();
    await restoreOffline(dest, source);
    const restored = new Store(dest);
    expect(restored.all("SELECT name FROM people")).toHaveLength(1);
    expect(restored.get("PRAGMA integrity_check")?.integrity_check).toBe("ok");
    restored.close();
  });
});
