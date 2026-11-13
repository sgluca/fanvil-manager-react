import { randomUUID, createHash } from "node:crypto";
import { Store, now, type Row } from "../../../packages/database/src/index.ts";
import {
  Secrets,
  masked,
  assertRealWriteBlocked,
  readAllPages,
  type ReadOperation,
} from "../../../packages/fanvil-core/src/index.ts";
import {
  parseCredentialsPage,
  parseLogCardsPage,
  parseLogsPage,
  parseUserlist,
} from "../../../packages/fanvil-core/src/manual.ts";
import { FanvilReadError } from "../../../packages/fanvil-core/src/errors.ts";
export type DeviceReader = (
  operation: ReadOperation,
  page: number,
) => Promise<{ status: number; body: unknown }>;
import {
  capabilitiesForModel,
  deviceDto,
  credentialDto,
} from "../../../packages/shared/src/index.ts";
// A parser failure means the firmware answered something other than the documented schema.
// The message names the endpoint, top-level keys and failing field paths only (never values).
function parsed<T>(label: string, body: unknown, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const keys =
      body && typeof body === "object"
        ? Object.keys(body)
            .slice(0, 12)
            .map((k) => (/^[\w.]{1,40}$/.test(k) ? k : "[campo]"))
            .join(", ")
        : typeof body;
    const issues = Array.isArray((error as any)?.issues)
      ? (error as any).issues
          .slice(0, 4)
          .map(
            (i: any) =>
              (i.path.join(".") || "(radice)") +
              ": " +
              String(i.code) +
              (i.expected ? " atteso " + i.expected : ""),
          )
          .join("; ")
      : "errore di lettura";
    throw new FanvilReadError(
      "FANVIL_RESPONSE_SCHEMA",
      "Risposta " +
        label +
        " non conforme al manuale 0.8.7, nessun dato importato. Campi ricevuti: " +
        (keys || "nessuno") +
        ". Problemi: " +
        issues,
    );
  }
}
export function fail(message: string, statusCode = 400): never {
  throw Object.assign(Error(message), { statusCode });
}
const failItem = (message: string, statusCode: number) =>
  fail(message, statusCode);
export function required(store: Store, table: string, id: string) {
  const r = store.get(`SELECT * FROM ${table} WHERE id=?`, id);
  if (!r) fail("Elemento non trovato", 404);
  return r;
}
export function insertDevice(s: Store, secrets: Secrets, v: Row) {
  const id = randomUUID();
  s.run(
    "INSERT INTO devices(id,name,model,host,port,protocol,mode,approved,secret,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id,
    v.name,
    v.model,
    v.host,
    v.port,
    v.protocol,
    v.mode,
    +v.approved,
    v.username || v.password
      ? secrets.encrypt({
          username: v.username ?? "",
          password: v.password ?? "",
        })
      : null,
    now(),
  );
  for (let i = 1; i <= (v.model === "i62" ? 2 : 1); i++)
    s.run(
      "INSERT INTO relays(id,device_id,number,name) VALUES(?,?,?,?)",
      randomUUID(),
      id,
      i,
      "Relay " + i,
    );
  for (const c of capabilitiesForModel(v.mode, v.model))
    s.run(
      "INSERT INTO device_capabilities VALUES(?,?,?,?,?)",
      id,
      c.key,
      c.state,
      c.reason,
      c.source,
    );
  if (v.mode === "demo")
    s.run(
      "INSERT INTO mock_remote(device_id,data) VALUES(?,?)",
      id,
      secrets.encrypt([
        {
          remoteId: "demo-existing-001",
          name: "Custode demo",
          kind: "rfid",
          value: "DEMO-EXISTING-001",
          relayNumbers: [1],
        },
      ]),
    );
  return id;
}
export function publicDevice(s: Store, r: Row) {
  const { secret: _secret, ...v } = r;
  return deviceDto.parse({
    ...v,
    approved: !!v.approved,
    hasCredentials: !!r.secret,
    relays: s.all(
      "SELECT * FROM relays WHERE device_id=? ORDER BY number",
      r.id,
    ),
    capabilities: s.all(
      "SELECT * FROM device_capabilities WHERE device_id=?",
      r.id,
    ),
  });
}
export function publicCredential(r: Row) {
  const { secret: _s, fingerprint: _f, ...v } = r;
  return credentialDto.parse({ ...v, revoked: !!v.revoked });
}
export function remote(s: Store, secrets: Secrets, deviceId: string): Row[] {
  const r = s.get("SELECT data FROM mock_remote WHERE device_id=?", deviceId);
  return r ? secrets.decrypt(r.data) : [];
}
export function snapshot(s: Store, deviceId: string) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        device: s.get("SELECT * FROM devices WHERE id=?", deviceId),
        credentials: s.all(
          "SELECT id,person_id,fingerprint,readability,expires_at,revoked,revision FROM credentials ORDER BY id",
        ),
        people: s.all("SELECT * FROM people ORDER BY id"),
        rules: s.all("SELECT * FROM access_rules ORDER BY id"),
        memberships: s.all(
          "SELECT * FROM group_memberships ORDER BY group_id,person_id",
        ),
        observed: s.all(
          "SELECT * FROM device_credentials WHERE device_id=? ORDER BY id",
          deviceId,
        ),
        remote: s.get("SELECT * FROM mock_remote WHERE device_id=?", deviceId),
      }),
    )
    .digest("hex");
}
export function preview(
  s: Store,
  secrets: Secrets,
  deviceId: string,
  actor: string,
) {
  const device = required(s, "devices", deviceId),
    jobId = randomUUID();
  s.transaction(() => {
    s.run(
      "INSERT INTO sync_jobs VALUES(?,?,?,?,?,?)",
      jobId,
      deviceId,
      "preview",
      snapshot(s, deviceId),
      now(),
      null,
    );
    const desired = s.all(
      `SELECT DISTINCT c.* FROM credentials c JOIN people p ON p.id=c.person_id WHERE p.active=1 AND c.revoked=0 AND c.readability='readable' AND (c.expires_at IS NULL OR c.expires_at>?) AND EXISTS (SELECT 1 FROM access_rules r WHERE r.device_id=? AND (r.person_id=p.id OR r.group_id IN (SELECT group_id FROM group_memberships WHERE person_id=p.id)))`,
      now(),
      deviceId,
    );
    const known = s.all(
      "SELECT * FROM device_credentials WHERE device_id=?",
      deviceId,
    );
    const existing = device.mode === "demo" ? remote(s, secrets, deviceId) : [];
    for (const c of desired) {
      const mapping = known.find((k) => k.credential_id === c.id);
      const remoteId = mapping?.remote_id ?? "managed-" + c.id;
      const relayNumbers = s
        .all(
          `SELECT DISTINCT l.number FROM access_rules r JOIN relays l ON l.id=r.relay_id WHERE r.device_id=? AND (r.person_id=? OR r.group_id IN(SELECT group_id FROM group_memberships WHERE person_id=?)) ORDER BY l.number`,
          deviceId,
          c.person_id,
          c.person_id,
        )
        .map((r) => r.number);
      const value = secrets.decrypt<string>(c.secret);
      const old = existing.find((r) => r.remoteId === remoteId);
      if (
        old &&
        old.kind === c.kind &&
        old.value === value &&
        JSON.stringify(old.relayNumbers) === JSON.stringify(relayNumbers)
      )
        continue;
      s.run(
        "INSERT INTO sync_operations VALUES(?,?,?,?,?,?,?)",
        randomUUID(),
        jobId,
        c.id,
        remoteId,
        "upsert",
        "pending",
        secrets.encrypt({
          remoteId,
          name: required(s, "people", c.person_id).name,
          kind: c.kind,
          value,
          relayNumbers,
        }),
      );
    }
    for (const k of known) {
      if (!k.credential_id) continue;
      const c = required(s, "credentials", k.credential_id);
      if (desired.some((v) => v.id === c.id)) continue;
      if (k.state !== "synced" && !c.revoked) continue;
      if (!existing.some((v) => v.remoteId === k.remote_id)) continue;
      s.run(
        "INSERT INTO sync_operations VALUES(?,?,?,?,?,?,?)",
        randomUUID(),
        jobId,
        c.id,
        k.remote_id,
        "remove",
        "pending",
        secrets.encrypt({ remoteId: k.remote_id }),
      );
    }
    s.audit(actor, "sync.preview", jobId, { deviceId, mode: device.mode });
  });
  return jobView(s, jobId);
}
export function jobView(s: Store, id: string) {
  return {
    ...required(s, "sync_jobs", id),
    operations: s.all(
      "SELECT id,credential_id,remote_id,action,status FROM sync_operations WHERE job_id=?",
      id,
    ),
  };
}
export function apply(s: Store, secrets: Secrets, id: string, actor: string) {
  const job = required(s, "sync_jobs", id),
    device = required(s, "devices", job.device_id);
  if (device.mode !== "demo") assertRealWriteBlocked();
  if (job.status === "applied") return jobView(s, id);
  if (!["preview", "failed"].includes(job.status))
    fail("Anteprima non applicabile", 409);
  if (job.snapshot_hash !== snapshot(s, device.id)) {
    s.run(
      "UPDATE sync_jobs SET status='conflict',error=? WHERE id=?",
      "Stato cambiato: rigenerare anteprima",
      id,
    );
    s.audit(actor, "sync.conflict", id);
    fail("Stato cambiato: rigenerare anteprima", 409);
  }
  try {
    s.transaction(() => {
      let data = remote(s, secrets, device.id);
      for (const op of s.all(
        "SELECT * FROM sync_operations WHERE job_id=?",
        id,
      )) {
        data = data.filter((v) => v.remoteId !== op.remote_id);
        if (op.action === "upsert") data.push(secrets.decrypt(op.payload));
        s.run(
          "INSERT INTO device_credentials VALUES(?,?,?,?,?,?) ON CONFLICT(device_id,remote_id) DO UPDATE SET credential_id=excluded.credential_id,state=excluded.state,observed_json=excluded.observed_json",
          randomUUID(),
          device.id,
          op.credential_id,
          op.remote_id,
          "synced",
          JSON.stringify({ present: op.action === "upsert", source: "mock" }),
        );
        s.run("UPDATE sync_operations SET status='verified' WHERE id=?", op.id);
      }
      s.run(
        "UPDATE mock_remote SET data=?,revision=revision+1 WHERE device_id=?",
        secrets.encrypt(data),
        device.id,
      );
      const readback = remote(s, secrets, device.id);
      for (const op of s.all(
        "SELECT * FROM sync_operations WHERE job_id=?",
        id,
      )) {
        const actual = readback.find((v) => v.remoteId === op.remote_id);
        if (
          (op.action === "upsert" &&
            JSON.stringify(actual) !==
              JSON.stringify(secrets.decrypt(op.payload))) ||
          (op.action === "remove" && actual)
        )
          fail("Verifica mock fallita", 409);
      }
      s.run("UPDATE sync_jobs SET status='applied',error=NULL WHERE id=?", id);
      s.audit(actor, "sync.apply.demo", id, {
        operations: s.all("SELECT id FROM sync_operations WHERE job_id=?", id)
          .length,
      });
    });
  } catch {
    s.run(
      "UPDATE sync_jobs SET status='failed',error=? WHERE id=?",
      "Applicazione mock fallita; riprovare o rigenerare anteprima",
      id,
    );
    s.audit(actor, "sync.failed.demo", id);
    fail("Applicazione mock fallita", 409);
  }
  return jobView(s, id);
}
export async function stage(
  s: Store,
  secrets: Secrets,
  deviceId: string,
  actor: string,
  reader?: DeviceReader,
): Promise<Row> {
  const device = required(s, "devices", deviceId);
  let items: {
    remoteId: string;
    name: string;
    kind: string;
    value: string | null;
  }[];
  let summary: Row | undefined;
  if (device.mode === "demo") {
    items = remote(s, secrets, deviceId) as any;
  } else {
    if (!reader) fail("Lettura reale non disponibile", 409);
    const cards = await readAllPages((page) =>
      reader("cardsRead", page).then((r) =>
        parsed("card_info", r.body, () => parseCredentialsPage(r.body, "rfid")),
      ),
    );
    const pins = await readAllPages((page) =>
      reader("pinsRead", page).then((r) =>
        parsed("password_info", r.body, () =>
          parseCredentialsPage(r.body, "pin"),
        ),
      ),
    );
    const seen = new Set<string>();
    let skipped = 0;
    items = [];
    let userlist: Row | undefined;
    if (!cards.items.length && !pins.items.length) {
      // This firmware keeps its credentials in the CSV export, not in card_info/password_info.
      const csv = await reader("userlistRead", 1);
      const rows = parsed("userlist", csv.body, () => parseUserlist(csv.body));
      let disabled = 0,
        empty = 0,
        limited = 0;
      for (const r of rows) {
        if (r.status.toLowerCase() === "disable") {
          disabled++;
          continue;
        }
        if (!r.card && !r.pin) {
          empty++;
          continue;
        }
        // One person key per row (card first, else PIN), so card and PIN land on the same person.
        const rowKey =
          "row:" +
          secrets
            .fingerprint(r.card ? "rfid" : "pin", r.card || r.pin)
            .slice(0, 32);
        const name =
          r.name || "Senza nome " + masked("rfid", r.card || r.pin).slice(-8);
        if (r.status.toLowerCase() === "period" || r.times > 0) limited++;
        for (const [kind, value] of [
          ["rfid", r.card],
          ["pin", r.pin],
        ] as const)
          if (value) {
            const remoteId = rowKey + "#" + kind;
            if (seen.has(remoteId)) skipped++;
            else {
              seen.add(remoteId);
              items.push({ remoteId, name, kind, value });
            }
          }
      }
      userlist = { rows: rows.length, disabled, empty, limited };
    }
    for (const c of [...cards.items, ...pins.items]) {
      // A PIN without refid has no stable remote identity: derive one from the value only.
      // Card numbers are never exposed: the remote id is a keyed fingerprint, stable per key.
      const remoteId =
        c.kind === "rfid" && c.value
          ? "card:" + secrets.fingerprint("rfid", c.value).slice(0, 32)
          : (c.remoteId ??
            (c.value
              ? "pin-value:" + secrets.fingerprint("pin", c.value).slice(0, 32)
              : null));
      if (!remoteId || seen.has(remoteId)) {
        skipped++;
        continue;
      }
      seen.add(remoteId);
      items.push({ remoteId, name: c.name, kind: c.kind, value: c.value });
    }
    summary = {
      cards: userlist
        ? items.filter((i) => i.kind === "rfid").length
        : cards.items.length,
      pins: userlist
        ? items.filter((i) => i.kind === "pin").length
        : pins.items.length,
      skipped,
      cardsComplete: cards.complete,
      pinsComplete: pins.complete,
      cardsStoppedBy: cards.stoppedBy,
      pinsStoppedBy: pins.stoppedBy,
      ...(userlist ? { userlist } : {}),
    };
  }
  const batchId = randomUUID();
  s.transaction(() => {
    s.run(
      "INSERT INTO staging_batches VALUES(?,?,?,?)",
      batchId,
      deviceId,
      "pending",
      now(),
    );
    for (const item of items)
      s.run(
        "INSERT INTO staging_items VALUES(?,?,?,?,?,?,?,?,?)",
        randomUUID(),
        batchId,
        item.remoteId,
        item.name,
        item.kind,
        item.value ? secrets.encrypt(item.value) : null,
        item.value ? secrets.fingerprint(item.kind, item.value) : null,
        masked(item.kind, item.value ?? undefined),
        item.value ? "readable" : "unrecoverable",
      );
    s.audit(
      actor,
      device.mode === "demo" ? "import.stage.demo" : "import.stage.real",
      batchId,
      { deviceId, ...summary },
    );
    if (device.mode !== "demo")
      s.run(
        "INSERT INTO diagnostics VALUES(?,?,?,?,?)",
        randomUUID(),
        deviceId,
        "import",
        JSON.stringify({ source: "real", success: true, ...summary }),
        now(),
      );
  });
  return { ...batchView(s, batchId), ...(summary ? { summary } : {}) };
}
export function batchView(s: Store, id: string) {
  const b = required(s, "staging_batches", id);
  return {
    ...b,
    items: s
      .all(
        "SELECT id,remote_id,name,credential_kind,masked,readability FROM staging_items WHERE batch_id=?",
        id,
      )
      .map((item) => ({
        ...item,
        existingPersonId:
          s.get(
            "SELECT person_id FROM imported_people WHERE device_id=? AND remote_id=?",
            b.device_id,
            String(item.remote_id).split("#")[0],
          )?.person_id ??
          s.get(
            "SELECT person_id FROM credentials WHERE fingerprint=(SELECT fingerprint FROM staging_items WHERE id=?)",
            item.id,
          )?.person_id ??
          null,
        candidates: s.all("SELECT id,name FROM people WHERE name=?", item.name),
      })),
  };
}
export function reconcile(
  s: Store,
  batchId: string,
  mappings: Record<string, string>,
  actor: string,
) {
  const b = required(s, "staging_batches", batchId);
  if (b.status === "applied")
    return {
      ...batchView(s, batchId),
      result: { people: 0, credentials: 0, skipped: 0 },
    };
  const deviceMode = required(s, "devices", b.device_id).mode;
  const result = { people: 0, credentials: 0, skipped: 0 };
  s.transaction(() => {
    for (const i of s.all(
      "SELECT * FROM staging_items WHERE batch_id=?",
      batchId,
    )) {
      if (mappings[i.id] === "skip") {
        result.skipped++;
        continue;
      }
      // Every conflict names the item (name and masked value), so the operator knows what to fix.
      const fail = (message: string, status: number) =>
        failItem("«" + i.name + "» " + i.masked + ": " + message, status);
      // Items of one device row ("row:…#card", "row:…#pin") share one person.
      const personKey = String(i.remote_id).split("#")[0];
      const imported = s.get(
        "SELECT person_id FROM imported_people WHERE device_id=? AND remote_id=?",
        b.device_id,
        personKey,
      );
      const credential = i.fingerprint
        ? s.get("SELECT * FROM credentials WHERE fingerprint=?", i.fingerprint)
        : undefined;
      if (imported && credential && imported.person_id !== credential.person_id)
        fail("identità remota e credenziale in conflitto", 409);
      const requested = mappings[i.id];
      if (requested && !s.get("SELECT id FROM people WHERE id=?", requested))
        fail("persona selezionata inesistente", 404);
      if (credential && requested && requested !== credential.person_id)
        fail(
          "credenziale già associata a un'altra persona: selezionare quella o saltare la voce",
          409,
        );
      if (imported && requested && requested !== imported.person_id)
        fail(
          "voce già riconciliata con un'altra persona: selezionare quella o saltare la voce",
          409,
        );
      let personId = imported?.person_id ?? credential?.person_id ?? requested;
      if (!personId) {
        if (s.get("SELECT id FROM people WHERE name=?", i.name))
          fail(
            "nome già presente: selezionare la persona esistente o saltare la voce",
            409,
          );
        personId = randomUUID();
        result.people++;
        s.run(
          "INSERT INTO people VALUES(?,?,?,?,?,?)",
          personId,
          i.name,
          deviceMode === "demo" ? "Import demo" : "Import dal dispositivo",
          1,
          1,
          now(),
        );
      }
      s.run(
        "INSERT OR IGNORE INTO imported_people VALUES(?,?,?)",
        b.device_id,
        personKey,
        personId,
      );
      let credentialId =
        credential?.id ??
        s.get(
          "SELECT credential_id FROM device_credentials WHERE device_id=? AND remote_id=?",
          b.device_id,
          i.remote_id,
        )?.credential_id;
      if (!credentialId && i.credential_kind) {
        credentialId = randomUUID();
        result.credentials++;
        s.run(
          "INSERT INTO credentials VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          credentialId,
          personId,
          i.credential_kind,
          i.secret,
          i.fingerprint,
          i.masked,
          i.readability,
          null,
          0,
          "import",
          1,
          now(),
        );
      }
      s.run(
        "INSERT INTO device_credentials VALUES(?,?,?,?,?,?) ON CONFLICT(device_id,remote_id) DO UPDATE SET credential_id=excluded.credential_id",
        randomUUID(),
        b.device_id,
        credentialId ?? null,
        i.remote_id,
        "observed",
        JSON.stringify({
          source: deviceMode === "demo" ? "mock" : "real",
          readability: i.readability,
        }),
      );
    }
    s.run("UPDATE staging_batches SET status='applied' WHERE id=?", batchId);
    s.audit(actor, "import.reconcile", batchId, result);
    observedGroup(s, b.device_id, actor);
  });
  return { ...batchView(s, batchId), result };
}
// What the device already grants: one local group per device whose members are the people
// owning credentials observed there, with a rule on every relay of the device. The userlist and
// card_info do not state a usable relay, so all relays are assumed (exact for 1-relay models).
// Additive: never removes members or rules the operator changed afterwards.
export function observedGroup(s: Store, deviceId: string, actor: string) {
  const device = required(s, "devices", deviceId);
  let groupId = s.get(
    "SELECT group_id FROM device_groups WHERE device_id=?",
    deviceId,
  )?.group_id as string | undefined;
  let createdGroup = false;
  if (!groupId) {
    groupId = randomUUID();
    createdGroup = true;
    s.run(
      "INSERT INTO access_groups VALUES(?,?,?)",
      groupId,
      "Accesso rilevato · " + device.name,
      "Generato dall’import: persone le cui credenziali sono presenti sul dispositivo." +
        (device.model === "i62"
          ? " Il dispositivo non indica il relay: assegnati entrambi, correggere se necessario."
          : ""),
    );
    s.run("INSERT INTO device_groups VALUES(?,?)", deviceId, groupId);
  }
  let rules = 0;
  if (createdGroup)
    for (const relay of s.all(
      "SELECT id FROM relays WHERE device_id=?",
      deviceId,
    )) {
      s.run(
        "INSERT INTO access_rules VALUES(?,?,?,?,?)",
        randomUUID(),
        null,
        groupId,
        deviceId,
        relay.id,
      );
      rules++;
    }
  let members = 0;
  for (const p of s.all(
    "SELECT DISTINCT c.person_id FROM device_credentials k JOIN credentials c ON c.id=k.credential_id WHERE k.device_id=? AND k.state IN ('observed','synced')",
    deviceId,
  ))
    members += Number(
      s.run(
        "INSERT OR IGNORE INTO group_memberships VALUES(?,?)",
        groupId,
        p.person_id,
      ).changes,
    );
  s.audit(actor, "group.observed", groupId, { deviceId, members, rules });
  return { groupId, members, rules, created: createdGroup };
}
// Card capture: the operator swipes a new card on the reader; the device logs the attempt and
// we read the card number back from the open-door log. Read only: nothing is written on the
// device. A baseline of log ids taken at start isolates new swipes from device clock skew.
const captures = new Map<
  string,
  { deviceId: string; baseline: Set<string>; startedAt: number; demo: boolean }
>();
const CAPTURE_TTL = 10 * 60_000;
async function readLogCards(reader: DeviceReader) {
  return readAllPages((page) =>
    reader("eventsRead", page).then((r) =>
      parsed("device_log", r.body, () => parseLogCardsPage(r.body)),
    ),
  );
}
export async function startCardCapture(
  s: Store,
  deviceId: string,
  actor: string,
  reader?: DeviceReader,
) {
  const d = required(s, "devices", deviceId);
  for (const [k, v] of captures)
    if (Date.now() - v.startedAt > CAPTURE_TTL) captures.delete(k);
  let baseline = new Set<string>(),
    complete = true;
  if (d.mode !== "demo") {
    if (!reader) fail("Lettura reale non disponibile", 409);
    const log = await readLogCards(reader);
    baseline = new Set(log.items.map((e) => e.remoteId));
    complete = log.complete;
  }
  const captureId = randomUUID();
  captures.set(captureId, {
    deviceId,
    baseline,
    startedAt: Date.now(),
    demo: d.mode === "demo",
  });
  s.audit(actor, "card.capture.start", deviceId, { logEntries: baseline.size });
  return { captureId, logEntries: baseline.size, complete };
}
export async function pollCardCapture(
  s: Store,
  secrets: Secrets,
  captureId: string,
  actor: string,
  reader?: DeviceReader,
) {
  const c = captures.get(captureId);
  if (!c || Date.now() - c.startedAt > CAPTURE_TTL)
    fail("Lettura scaduta o inesistente: riavviarla", 404);
  let entries: ReturnType<typeof parseLogCardsPage>["items"];
  let complete = true;
  if (c.demo) {
    entries =
      Date.now() - c.startedAt > 3000
        ? [
            {
              remoteId: "demo-capture",
              occurredAt: now(),
              outcome: "denied",
              relayNumber: 1,
              card: "DE40" + String(c.startedAt % 10000).padStart(4, "0"),
              extraShape: null,
              fields: [],
            },
          ]
        : [];
  } else {
    if (!reader) fail("Lettura reale non disponibile", 409);
    const log = await readLogCards(reader);
    entries = log.items.filter((e) => !c.baseline.has(e.remoteId));
    complete = log.complete;
  }
  const cards = entries
    .filter((e) => e.card)
    .map((e) => {
      const fp = secrets.fingerprint("rfid", e.card!);
      const known = s.get(
        "SELECT c.id,p.name FROM credentials c JOIN people p ON p.id=c.person_id WHERE c.fingerprint=?",
        fp,
      );
      return {
        value: e.card!,
        masked: masked("rfid", e.card!),
        occurredAt: e.occurredAt,
        outcome: e.outcome,
        knownPerson: known?.name ?? null,
      };
    });
  const unrecognized = entries
    .filter((e) => !e.card)
    .map((e) => ({
      occurredAt: e.occurredAt,
      outcome: e.outcome,
      extraShape: e.extraShape,
      fields: e.fields,
    }));
  if (cards.length)
    s.audit(actor, "card.capture.found", c.deviceId, { cards: cards.length });
  return { newEntries: entries.length, cards, unrecognized, complete };
}
function collectDemoEvents(s: Store, deviceId: string, actor: string) {
  const relays = s.all(
    "SELECT id,number FROM relays WHERE device_id=? ORDER BY number",
    deviceId,
  );
  for (let i = 0; i < 6; i++)
    s.run(
      "INSERT OR IGNORE INTO access_events VALUES(?,?,?,?,?,?,?,?,?)",
      randomUUID(),
      deviceId,
      null,
      relays[0].id,
      "demo-event-" + i,
      new Date(Date.UTC(2026, 10, 12, 8, i * 5)).toISOString(),
      i === 4 ? "denied" : "granted",
      "mock",
      "mock:" + deviceId + ":" + i,
    );
  s.audit(actor, "events.collect.demo", deviceId);
  return {
    count: s.get(
      "SELECT COUNT(*) n FROM access_events WHERE device_id=?",
      deviceId,
    )!.n,
  };
}
export async function collectEvents(
  s: Store,
  deviceId: string,
  actor: string,
  reader?: DeviceReader,
) {
  const d = required(s, "devices", deviceId);
  if (d.mode === "demo") return collectDemoEvents(s, deviceId, actor);
  if (!reader) fail("Lettura reale non disponibile", 409);
  const relays = s.all(
    "SELECT id,number FROM relays WHERE device_id=? ORDER BY number",
    deviceId,
  );
  const read = await readAllPages((page) =>
    reader("eventsRead", page).then((r) =>
      parsed("device_log", r.body, () => parseLogsPage(r.body)),
    ),
  );
  let added = 0;
  s.transaction(() => {
    for (const e of read.items) {
      // Relay 0/unknown stays unattributed; identity is never inferred from the log.
      const relay = relays.find((r) => r.number === e.relayNumber);
      added += Number(
        s.run(
          "INSERT OR IGNORE INTO access_events VALUES(?,?,?,?,?,?,?,?,?)",
          randomUUID(),
          deviceId,
          null,
          relay?.id ?? null,
          e.remoteId,
          e.occurredAt,
          e.outcome,
          "real",
          "real:" + deviceId + ":" + e.remoteId,
        ).changes,
      );
    }
    const summary = {
      read: read.items.length,
      added,
      pages: read.pages,
      complete: read.complete,
      stoppedBy: read.stoppedBy,
    };
    s.audit(actor, "events.collect.real", deviceId, summary);
    s.run(
      "INSERT INTO diagnostics VALUES(?,?,?,?,?)",
      randomUUID(),
      deviceId,
      "eventsCollect",
      JSON.stringify({ source: "real", success: true, ...summary }),
      now(),
    );
  });
  return {
    count: s.get(
      "SELECT COUNT(*) n FROM access_events WHERE device_id=?",
      deviceId,
    )!.n,
    read: read.items.length,
    added,
    complete: read.complete,
  };
}
export function seedDemo(s: Store, secrets: Secrets) {
  if (s.get("SELECT id FROM devices WHERE mode='demo'")) return;
  s.transaction(() => {
    for (const [model, name] of [
      ["i60K", "Ingresso principale"],
      ["i60", "Sala incontri"],
      ["A10", "Segreteria"],
      ["i62", "Cortile e salone"],
    ]) {
      const id = insertDevice(s, secrets, {
        name,
        model,
        host: model.toLowerCase() + ".demo.invalid",
        port: 80,
        protocol: "http",
        mode: "demo",
        approved: false,
      });
      collectEvents(s, id, "system");
    }
    for (const name of ["Anna Demo", "Marco Demo"])
      s.run(
        "INSERT INTO people VALUES(?,?,?,?,?,?)",
        randomUUID(),
        name,
        "Dati sintetici",
        1,
        1,
        now(),
      );
    s.run(
      "INSERT INTO access_groups VALUES(?,?,?)",
      randomUUID(),
      "Volontari",
      "Gruppo demo",
    );
    s.audit(null, "demo.seed");
  });
}
