import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export type Row = Record<string, any>;
export const migration = `
CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,model TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,protocol TEXT NOT NULL,mode TEXT NOT NULL,approved INTEGER NOT NULL DEFAULT 0,secret TEXT,firmware TEXT,last_contact TEXT,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS device_capabilities(device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,key TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(device_id,key));
CREATE TABLE IF NOT EXISTS relays(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,number INTEGER NOT NULL,name TEXT NOT NULL,physical_state TEXT NOT NULL DEFAULT 'unknown',UNIQUE(device_id,number));
CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL,notes TEXT NOT NULL,active INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id),kind TEXT NOT NULL,secret TEXT,fingerprint TEXT UNIQUE,masked TEXT NOT NULL,readability TEXT NOT NULL,expires_at TEXT,revoked INTEGER NOT NULL DEFAULT 0,origin TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS access_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,notes TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS group_memberships(group_id TEXT NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,person_id TEXT NOT NULL REFERENCES people(id),PRIMARY KEY(group_id,person_id));
CREATE TABLE IF NOT EXISTS access_rules(id TEXT PRIMARY KEY,person_id TEXT REFERENCES people(id),group_id TEXT REFERENCES access_groups(id),device_id TEXT NOT NULL REFERENCES devices(id),relay_id TEXT NOT NULL REFERENCES relays(id),CHECK((person_id IS NULL)!=(group_id IS NULL)));
CREATE TABLE IF NOT EXISTS device_credentials(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,credential_id TEXT REFERENCES credentials(id),remote_id TEXT NOT NULL,state TEXT NOT NULL,observed_json TEXT NOT NULL,UNIQUE(device_id,remote_id));
CREATE TABLE IF NOT EXISTS access_events(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,person_id TEXT REFERENCES people(id),relay_id TEXT REFERENCES relays(id),remote_id TEXT,occurred_at TEXT NOT NULL,outcome TEXT NOT NULL,source TEXT NOT NULL,dedup_key TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS sync_jobs(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,status TEXT NOT NULL,snapshot_hash TEXT NOT NULL,created_at TEXT NOT NULL,error TEXT);
CREATE TABLE IF NOT EXISTS sync_operations(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,credential_id TEXT REFERENCES credentials(id),remote_id TEXT NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staging_batches(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staging_items(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES staging_batches(id) ON DELETE CASCADE,remote_id TEXT NOT NULL,name TEXT NOT NULL,credential_kind TEXT,secret TEXT,fingerprint TEXT,masked TEXT,readability TEXT NOT NULL,UNIQUE(batch_id,remote_id));
CREATE TABLE IF NOT EXISTS imported_people(device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,remote_id TEXT NOT NULL,person_id TEXT NOT NULL REFERENCES people(id),PRIMARY KEY(device_id,remote_id));
CREATE TABLE IF NOT EXISTS device_groups(device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS mock_remote(device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS diagnostics(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,endpoint TEXT NOT NULL,metadata TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY,actor_id TEXT,action TEXT NOT NULL,entity_id TEXT,metadata TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT,'audit immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT,'audit immutable'); END;
CREATE TABLE IF NOT EXISTS admin_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_time ON access_events(occurred_at);
CREATE INDEX IF NOT EXISTS events_device_time ON access_events(device_id,occurred_at);
CREATE INDEX IF NOT EXISTS sync_device_status ON sync_jobs(device_id,status);
CREATE INDEX IF NOT EXISTS audit_time ON audit_logs(created_at);
`;
export class Store {
  db: DatabaseSync;
  constructor(public path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    this.transaction(() => {
      this.db.exec(migration);
      this.run("INSERT OR IGNORE INTO migrations VALUES(1,?)", now());
    });
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  all(sql: string, ...args: any[]): Row[] {
    return this.db.prepare(sql).all(...args);
  }
  get(sql: string, ...args: any[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  audit(
    actor: string | null,
    action: string,
    entity: string | null = null,
    metadata: Row = {},
  ) {
    this.run(
      "INSERT INTO audit_logs VALUES(?,?,?,?,?,?)",
      randomUUID(),
      actor,
      action,
      entity,
      JSON.stringify(metadata),
      now(),
    );
  }
  async backup(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await sqliteBackup(this.db, path);
    return path;
  }
  close() {
    this.db.close();
  }
}
export function now() {
  return new Date().toISOString();
}
