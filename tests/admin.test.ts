import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { verify } from "argon2";
import { Store } from "../packages/database/src/index.ts";
import {
  acquireLock,
  acquireRuntimeLock,
} from "../apps/api/src/maintenance.ts";
import { createAdmin } from "../apps/api/src/admin.ts";
const password = "synthetic-password-admin-2026";

describe("Bootstrap amministratore con applicazione avviata", () => {
  it("lock runtime permette admin condiviso ma blocca seconda istanza e manutenzione esclusiva", () => {
    const dir = mkdtempSync(join(tmpdir(), "fanvil-lock-admin-")),
      file = join(dir, "test.sqlite");
    const release = acquireRuntimeLock(file);
    try {
      const shared = acquireLock(file, "shared");
      shared();
      expect(() => acquireRuntimeLock(file)).toThrow("in uso");
      expect(() => acquireLock(file)).toThrow("in uso");
    } finally {
      release();
    }
    const exclusive = acquireLock(file);
    try {
      expect(() => acquireLock(file, "shared")).toThrow("in uso");
      expect(() => acquireRuntimeLock(file)).toThrow("in uso");
    } finally {
      exclusive();
    }
    const runtime = acquireRuntimeLock(file);
    runtime();
    rmSync(dir, { recursive: true, force: true });
  });
  it("crea utente e audit in transazione; duplicati e input errati non sovrascrivono account", async () => {
    const s = new Store(":memory:");
    try {
      const id = await createAdmin(s, "admin-test", password);
      expect(
        await verify(
          s.get("SELECT password_hash FROM admin_users WHERE id=?", id)!
            .password_hash,
          password,
        ),
      ).toBe(true);
      expect(s.get("SELECT role FROM admin_users WHERE id=?", id)!.role).toBe(
        "admin",
      );
      expect(
        s.get(
          "SELECT entity_id FROM audit_logs WHERE action='admin.bootstrap'",
        )!.entity_id,
      ).toBe(id);
      await expect(
        createAdmin(s, "admin-test", "different-password-long"),
      ).rejects.toThrow("già esistente");
      await expect(
        createAdmin(s, "invalid username", password),
      ).rejects.toThrow("Nome utente");
      await expect(createAdmin(s, "new-user", "short")).rejects.toThrow(
        "Password",
      );
      expect(s.get("SELECT COUNT(*) n FROM admin_users")!.n).toBe(1);
      expect(JSON.stringify(s.all("SELECT * FROM audit_logs"))).not.toContain(
        password,
      );
    } finally {
      s.close();
    }
  });
  it("errore audit annulla anche inserimento dell’utente", async () => {
    const s = new Store(":memory:");
    try {
      s.db.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;",
      );
      await expect(createAdmin(s, "rollback-test", password)).rejects.toThrow(
        "audit unavailable",
      );
      expect(s.get("SELECT COUNT(*) n FROM admin_users")!.n).toBe(0);
    } finally {
      s.close();
    }
  });
  it("CLI in processo separato crea account con lock runtime attivo e rispetta manutenzione", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fanvil-cli-admin-")),
      file = join(dir, "test.sqlite"),
      store = new Store(file);
    const env = {
      ...process.env,
      NODE_ENV: "development",
      DATABASE_PATH: file,
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      SESSION_SECRET: randomBytes(32).toString("hex"),
    };
    const args = [
      "--import",
      "tsx",
      resolve("apps/api/src/cli.ts"),
      "admin:create",
      "container-admin",
    ];
    const release = acquireRuntimeLock(file);
    try {
      const child = spawn(process.execPath, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (v) => {
        output += v;
      });
      child.stderr.on("data", (v) => {
        output += v;
      });
      const exited = once(child, "exit");
      child.stdin.end(password);
      expect((await exited)[0]).toBe(0);
      expect(output).toContain("Amministratore creato");
      expect(output).not.toContain(password);
      expect(
        store.get(
          "SELECT role FROM admin_users WHERE username='container-admin'",
        )!.role,
      ).toBe("admin");
    } finally {
      release();
    }
    const exclusive = acquireLock(file);
    try {
      const result = spawnSync(process.execPath, args, {
        env,
        input: password,
        encoding: "utf8",
        timeout: 10000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("in uso");
    } finally {
      exclusive();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
