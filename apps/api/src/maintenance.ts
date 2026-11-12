import { existsSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { Store, now } from "../../../packages/database/src/index.ts";
// SQLite advisory locking is released by the OS on crash, including across container PID namespaces.
export function acquireLock(
  database: string,
  mode: "shared" | "exclusive" = "exclusive",
) {
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(database + ".lock");
  try {
    lock.exec("PRAGMA busy_timeout=0;");
    if (
      !lock
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='process_lock'",
        )
        .get()
    ) {
      lock.exec("CREATE TABLE process_lock(id INTEGER PRIMARY KEY);");
    }
    lock.exec(
      mode === "shared"
        ? "BEGIN; SELECT id FROM process_lock LIMIT 1;"
        : "BEGIN EXCLUSIVE;",
    );
  } catch {
    lock.close();
    throw Error(
      "Database in uso: fermare applicazione e comandi amministrativi",
    );
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      try {
        lock.exec("ROLLBACK");
      } finally {
        lock.close();
      }
    }
  };
}
// One application process, with a shared maintenance lock that permits admin creation.
export function acquireRuntimeLock(database: string) {
  const singleton = acquireLock(database + ".instance");
  try {
    const maintenance = acquireLock(database, "shared");
    return () => {
      try {
        maintenance();
      } finally {
        singleton();
      }
    };
  } catch (error) {
    singleton();
    throw error;
  }
}
export async function restoreOffline(database: string, source: string) {
  if (resolve(database) === resolve(source))
    throw Error("Sorgente e destinazione coincidono");
  const unlock = acquireLock(database);
  let src: DatabaseSync | undefined;
  const temp = database + ".restoring";
  try {
    src = new DatabaseSync(source, { readOnly: true });
    if (src.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw Error("Backup corrotto");
    const version = src
      .prepare("SELECT MAX(version) version FROM migrations")
      .get()?.version;
    if (version !== 1) throw Error("Versione schema non compatibile");
    if (src.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("Foreign key non valide");
    if (existsSync(database)) {
      const current = new Store(database);
      try {
        await current.backup(
          database + ".pre-restore-" + Date.now() + ".sqlite",
        );
      } finally {
        current.close();
      }
    }
    if (existsSync(temp)) unlinkSync(temp);
    await backup(src, temp);
    src.close();
    src = undefined;
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(database + suffix)) unlinkSync(database + suffix);
    renameSync(temp, database);
    const result = new Store(database);
    result.audit(null, "backup.restore", null, { schemaVersion: 1, at: now() });
    result.close();
  } finally {
    src?.close();
    if (existsSync(temp)) unlinkSync(temp);
    unlock();
  }
}
