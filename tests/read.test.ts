import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../packages/database/src/index.ts";
import {
  Secrets,
  PAGE_SIZE,
  readAllPages,
  readSpec,
} from "../packages/fanvil-core/src/index.ts";
import {
  insertDevice,
  stage,
  reconcile,
  collectEvents,
  type DeviceReader,
} from "../apps/api/src/services.ts";
const secrets = new Secrets(randomBytes(32).toString("hex"));
const realDevice = (s: Store, model = "i62") =>
  insertDevice(s, secrets, {
    name: "Reale",
    model,
    host: "x.invalid",
    port: 80,
    protocol: "http",
    mode: "real",
    approved: true,
  });
// Synthetic firmware: serves card/pin/log lists by the requested index window.
function fakeFirmware(data: {
  cards?: any[];
  pins?: any[];
  logs?: any[];
  total?: boolean;
}) {
  const calls: string[] = [];
  const reader: DeviceReader = async (operation, page) => {
    calls.push(operation + ":" + page);
    const slice = (a: any[] = []) =>
      a.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const total = (a: any[] = []) =>
      data.total === false ? {} : { total: String(a.length) };
    if (operation === "cardsRead")
      return {
        status: 200,
        body: { code: "200", card: slice(data.cards), ...total(data.cards) },
      };
    if (operation === "pinsRead")
      return {
        status: 200,
        body: { code: "200", password: slice(data.pins), ...total(data.pins) },
      };
    return {
      status: 200,
      body: { code: "200", data: slice(data.logs), ...total(data.logs) },
    };
  };
  return { reader, calls };
}
describe("Lettura paginata", () => {
  it("richiede la finestra di indice successiva senza alterare il resto della richiesta", () => {
    expect(readSpec("cardsRead", 1).body.card.index).toBe("1-100");
    expect(readSpec("cardsRead", 3).body.card.index).toBe("201-300");
    expect(readSpec("eventsRead", 2).body.deviceLog.index).toBe("101-200");
    expect(readSpec("cardsRead", 2).body.type).toEqual({
      cmd: "get",
      condition: "index",
    });
    expect(readSpec("deviceInfo", 2).body.type.item).toBe("device info");
    expect(readSpec("peopleRead").method).toBe("GET");
  });
  it("si ferma su pagina breve, totale, ripetizione e limite pagine", async () => {
    const page = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({ id: from + i }));
    const all = page(250);
    const byIndex = async (p: number) => ({
      items: all.slice((p - 1) * 100, p * 100),
      total: null,
    });
    const r = await readAllPages(byIndex);
    expect(r.items).toHaveLength(250);
    expect(r).toMatchObject({ pages: 3, complete: true });
    const exact = await readAllPages(async (p) => ({
      items: page(100, (p - 1) * 100),
      total: 200,
    }));
    expect(exact).toMatchObject({ pages: 2, stoppedBy: "total" });
    const ignored = await readAllPages(async () => ({
      items: page(100),
      total: null,
    }));
    expect(ignored).toMatchObject({ complete: false, stoppedBy: "repeat" });
    expect(ignored.items).toHaveLength(100);
    const endless = await readAllPages(
      async (p) => ({ items: page(100, p * 100), total: null }),
      3,
    );
    expect(endless).toMatchObject({ complete: false, stoppedBy: "page-limit" });
  });
});
describe("Import reale in staging", () => {
  it("importa carte e PIN su più pagine senza duplicati e senza esporre i valori", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s);
    const cards = Array.from({ length: 130 }, (_, i) => ({
      name: "Persona " + i,
      cardNumber: "SYNTH" + String(i).padStart(6, "0"),
    }));
    const pins = [
      { name: "Con refid", password: "123456", refid: "r1" },
      { name: "Senza refid", password: "654321", refid: "" },
      { name: "Illeggibile", refid: "r2" },
      { name: "Nulla" },
    ];
    const fw = fakeFirmware({ cards, pins });
    const batch = await stage(s, secrets, id, "actor", fw.reader);
    expect(fw.calls).toEqual(["cardsRead:1", "cardsRead:2", "pinsRead:1"]);
    expect(batch.summary).toMatchObject({
      cards: 130,
      pins: 4,
      skipped: 1,
      cardsComplete: true,
    });
    expect(batch.items).toHaveLength(133);
    expect(
      batch.items.find((i: any) => i.name === "Illeggibile").readability,
    ).toBe("unrecoverable");
    expect(JSON.stringify(batch)).not.toContain("SYNTH000001");
    expect(JSON.stringify(batch)).not.toContain("654321");
    const audit = JSON.stringify(s.all("SELECT * FROM audit_logs"));
    expect(audit).toContain("import.stage.real");
    expect(audit).not.toContain("SYNTH000001");
  });
  it("riconcilia come osservato reale e un reimport non crea duplicati", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s, "i60K");
    const fw = fakeFirmware({
      cards: [{ name: "Anna", cardNumber: "SYNTH-A" }],
    });
    const first = await stage(s, secrets, id, "actor", fw.reader);
    reconcile(s, first.id, {}, "actor");
    expect(s.all("SELECT * FROM people")).toHaveLength(1);
    expect(
      JSON.parse(
        s.get("SELECT observed_json FROM device_credentials")!.observed_json,
      ).source,
    ).toBe("real");
    const second = await stage(s, secrets, id, "actor", fw.reader);
    expect(second.items[0].existingPersonId).toBe(
      s.get("SELECT id FROM people")!.id,
    );
  });
  it("lista vuota con codice applicativo diverso da 200 = nessun elemento, non errore", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s, "i60K");
    const batch = await stage(s, secrets, id, "actor", async (op) =>
      op === "userlistRead"
        ? { status: 200, body: "Name,Status,Times,Card Number,Password\n" }
        : {
            status: 200,
            body: {
              type: {},
              code: "400",
              [op === "cardsRead" ? "card" : "password"]: [],
            },
          },
    );
    expect(batch.items).toHaveLength(0);
    expect(batch.summary).toMatchObject({
      cards: 0,
      pins: 0,
      cardsComplete: true,
    });
    await expect(
      stage(s, secrets, id, "actor", async () => ({
        status: 200,
        body: { code: "400", card: [{ name: "x", cardNumber: "1" }] },
      })),
    ).rejects.toMatchObject({ code: "FANVIL_RESPONSE_SCHEMA" });
  });
  it("non importa nulla se lo schema non è quello del manuale", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s);
    await expect(
      stage(s, secrets, id, "actor", async () => ({
        status: 200,
        body: { code: "200", card: [{ name: "x" }] },
      })),
    ).rejects.toMatchObject({
      code: "FANVIL_RESPONSE_SCHEMA",
      message: expect.stringContaining("card_info"),
    });
    expect(s.all("SELECT * FROM staging_batches")).toHaveLength(0);
  });
  it("propaga l’errore del dispositivo senza dati parziali", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s);
    const fw = fakeFirmware({
      cards: Array.from({ length: 150 }, (_, i) => ({
        name: "n",
        cardNumber: "S" + i,
      })),
      total: false,
    });
    const flaky: DeviceReader = async (op, page) => {
      if (page === 2) throw new Error("timeout");
      return fw.reader(op, page);
    };
    await expect(stage(s, secrets, id, "actor", flaky)).rejects.toThrow();
    expect(s.all("SELECT * FROM staging_batches")).toHaveLength(0);
  });
});
describe("Eventi reali", () => {
  it("acquisisce tutte le pagine, assegna il relay e deduplica al secondo passaggio", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s);
    const logs = Array.from({ length: 120 }, (_, i) => ({
      id: String(i + 1),
      relay: i === 0 ? "0" : i % 2 ? "2" : "1",
      openResult: i === 5 ? "1" : "0",
      openTime: String(1_800_000_000 + i * 60),
      extra: "must-be-dropped",
    }));
    const fw = fakeFirmware({ logs });
    const first = await collectEvents(s, id, "actor", fw.reader);
    expect(first).toMatchObject({ read: 120, added: 120, complete: true });
    const again = await collectEvents(s, id, "actor", fw.reader);
    expect(again).toMatchObject({ read: 120, added: 0 });
    const rows = s.all("SELECT * FROM access_events WHERE device_id=?", id);
    expect(rows).toHaveLength(120);
    expect(rows.every((r) => r.source === "real" && r.person_id === null)).toBe(
      true,
    );
    expect(rows.filter((r) => r.relay_id === null)).toHaveLength(1);
    expect(rows.filter((r) => r.outcome === "denied")).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("must-be-dropped");
  });
  const windowReader =
    (logs: () => any[], total: "window" | "none"): DeviceReader =>
    async (_op, page) => {
      // Positional ids: the firmware numbers entries inside each returned window.
      const data = logs()
        .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
        .map((l, i) => ({ ...l, id: String(i + 1) }));
      return {
        status: 200,
        body: {
          code: "200",
          data,
          ...(total === "window" ? { total: String(data.length) } : {}),
        },
      };
    };
  const log = (i: number, extra: Record<string, string> = {}) => ({
    relay: "1",
    openResult: "0",
    openTime: String(Math.floor(Date.now() / 1000) - 86400 * 10 + i * 60),
    ...extra,
  });
  it("legge oltre un total pari alla finestra e non perde eventi con id posizionali", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s);
    let logs = Array.from({ length: 250 }, (_, i) => log(i));
    const reader = windowReader(() => logs, "window");
    expect(await collectEvents(s, id, "actor", reader)).toMatchObject({
      read: 250,
      added: 250,
      complete: true,
    });
    logs = [...logs, log(300)];
    expect(await collectEvents(s, id, "actor", reader)).toMatchObject({
      read: 251,
      added: 1,
    });
    expect(
      s.get("SELECT COUNT(*) n FROM access_events WHERE device_id=?", id)!.n,
    ).toBe(251);
  });
  it("associa la persona da nome o credenziale, anche su eventi già acquisiti", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s);
    const person = (name: string) => {
      const pid = "p-" + name.replace(/\W/g, "");
      s.run(
        "INSERT INTO people VALUES(?,?,?,?,?,?)",
        pid,
        name,
        "",
        1,
        1,
        new Date().toISOString(),
      );
      return pid;
    };
    const anna = person("Anna Rossi");
    const logs = [
      log(1, { userName: "anna rossi" }),
      log(2, { userName: "Unknown", extra: "P:4242" }),
      log(3, { userName: "Sconosciuto" }),
    ];
    const reader = windowReader(() => logs, "none");
    const first = await collectEvents(s, id, "actor", reader, { secrets });
    expect(first).toMatchObject({ added: 3, attributed: 1 });
    const marco = person("Marco Bianchi");
    s.run(
      "INSERT INTO credentials VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      "c1",
      marco,
      "pin",
      null,
      secrets.fingerprint("pin", "4242"),
      "••••••",
      "readable",
      null,
      0,
      "import",
      1,
      new Date().toISOString(),
    );
    const again = await collectEvents(s, id, "actor", reader, { secrets });
    expect(again).toMatchObject({ added: 0, attributed: 1 });
    const rows = s.all(
      "SELECT person_id FROM access_events ORDER BY occurred_at",
    );
    expect(rows.map((r) => r.person_id)).toEqual([anna, marco, null]);
    expect(JSON.stringify(s.all("SELECT * FROM access_events"))).not.toContain(
      "4242",
    );
  });
  it("non importa eventi oltre la conservazione e migra le vecchie chiavi", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s);
    const old = {
      relay: "1",
      openResult: "0",
      openTime: String(Math.floor(Date.now() / 1000) - 86400 * 200),
    };
    const logs = [old, log(1)];
    const relay = s.get(
      "SELECT id FROM relays WHERE device_id=? AND number=1",
      id,
    )!;
    // Row stored by the previous version, keyed by the device id.
    s.run(
      "INSERT INTO access_events VALUES(?,?,?,?,?,?,?,?,?)",
      "legacy",
      id,
      null,
      relay.id,
      "2",
      new Date(Number(log(1).openTime) * 1000).toISOString(),
      "granted",
      "real",
      "real:" + id + ":2",
    );
    const r = await collectEvents(
      s,
      id,
      "actor",
      windowReader(() => logs, "none"),
      { retentionDays: 90 },
    );
    expect(r).toMatchObject({ read: 2, added: 0, expired: 1, count: 1 });
  });
  it("il demo resta sincrono e non usa il lettore", async () => {
    const s = new Store(":memory:");
    const id = insertDevice(s, secrets, {
      name: "Demo",
      model: "i60K",
      host: "d.invalid",
      port: 80,
      protocol: "http",
      mode: "demo",
      approved: false,
    });
    expect(await collectEvents(s, id, "actor")).toEqual({ count: 6 });
  });
});
describe("Import da userlist CSV (sintetico)", () => {
  const csv =
    "﻿Name,Status,Times,Relay,Period,Owner,Card Type,Card Number,Password Type,Number,Call ForWard,Password,Location,Floors,Picture,Feature,Source,Issuing Time\r\n" +
    "Anna Demo,Enable,0,1,,,Normal,0000000001,Local,,,,,,,,0,2026/01/01 10:00:00\r\n" +
    "Marco Demo,Enable,0,1,,,Normal,0000000002,Local,,,4242,,,,,0,2026/01/01 10:00:00\r\n" +
    '"Solo, PIN",Enable,5,1,,,Normal,,Local,,,5151,,,,,0,2026/01/01 10:00:00\r\n' +
    ",Enable,0,1,,,Normal,0000000003,Local,,,,,,,,0,2026/01/01 10:00:00\r\n" +
    "Remoto,Enable,0,1,,,Normal,,Remote,,,*,,,,,0,2026/01/01 10:00:00\r\n" +
    "Spento,Disable,0,1,,,Normal,0000000004,Local,,,,,,,,0,2026/01/01 10:00:00\r\n" +
    ",Enable,0,1,,,Normal,,Local & Remote,,,,,,,,100,2026/01/01 10:00:00\r\n";
  const emptyJson: DeviceReader = async (op) =>
    op === "userlistRead"
      ? { status: 200, body: csv }
      : {
          status: 200,
          body: {
            code: "400",
            [op === "cardsRead" ? "card" : "password"]: [],
          },
        };
  it("legge carte e PIN dal CSV, ignora spenti/vuoti/placeholder e unisce carta+PIN sulla stessa persona", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s, "i60K");
    const batch = await stage(s, secrets, id, "actor", emptyJson);
    expect(batch.summary).toMatchObject({
      cards: 3,
      pins: 2,
      userlist: { rows: 7, disabled: 1, empty: 2, limited: 1 },
    });
    const text = JSON.stringify(batch);
    for (const secret of ["0000000001", "4242", "5151"])
      expect(text).not.toContain(secret);
    expect(
      batch.items.filter((i: any) => i.name.startsWith("Senza nome")),
    ).toHaveLength(1);
    reconcile(s, batch.id, {}, "actor");
    expect(
      s.all("SELECT name FROM people ORDER BY name").map((p) => p.name),
    ).toHaveLength(4);
    expect(s.all("SELECT * FROM credentials")).toHaveLength(5);
    const marco = s.get("SELECT id FROM people WHERE name='Marco Demo'")!;
    expect(
      s.all(
        "SELECT kind FROM credentials WHERE person_id=? ORDER BY kind",
        marco.id,
      ),
    ).toHaveLength(2);
    const again = await stage(s, secrets, id, "actor", emptyJson);
    expect(again.items.every((i: any) => i.existingPersonId)).toBe(true);
  });
  it("intestazione sconosciuta: errore con i nomi attesi, nessun import", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s, "i60K");
    await expect(
      stage(s, secrets, id, "actor", async (op) =>
        op === "userlistRead"
          ? { status: 200, body: "A,B\n1,2" }
          : { status: 200, body: { code: "400", card: [], password: [] } },
      ),
    ).rejects.toMatchObject({
      code: "FANVIL_RESPONSE_SCHEMA",
      message: expect.stringContaining("Card Number"),
    });
  });
});
describe("Applicazione dell'importazione", () => {
  const csv =
    "Name,Status,Times,Card Number,Password\n" +
    "Anna Demo,Enable,0,0000000011,\n" +
    "Bruno Demo,Enable,0,0000000012,7788\n" +
    "Carla Demo,Enable,0,0000000013,\n";
  const reader: DeviceReader = async (op) =>
    op === "userlistRead"
      ? { status: 200, body: csv }
      : { status: 200, body: { code: "404", card: [], password: [] } };
  it("nome già presente: errore che indica la voce, nessuna modifica parziale; poi associa o salta", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s, "i60K");
    s.run(
      "INSERT INTO people VALUES('00000000-0000-4000-8000-000000000001','Anna Demo','',1,1,'2026-01-01')",
    );
    const batch = await stage(s, secrets, id, "actor", reader);
    const anna = batch.items.find((i: any) => i.name === "Anna Demo");
    expect(anna.candidates).toHaveLength(1);
    expect(() => reconcile(s, batch.id, {}, "actor")).toThrow(
      /«Anna Demo» ••••0011: nome già presente/,
    );
    expect(s.all("SELECT * FROM people")).toHaveLength(1);
    const carla = batch.items.find((i: any) => i.name === "Carla Demo");
    const done = reconcile(
      s,
      batch.id,
      { [anna.id]: anna.candidates[0].id, [carla.id]: "skip" },
      "actor",
    );
    expect(done.result).toEqual({ people: 1, credentials: 3, skipped: 1 });
    expect(
      s.all(
        "SELECT * FROM credentials WHERE person_id=?",
        anna.candidates[0].id,
      ),
    ).toHaveLength(1);
    expect(
      s.get("SELECT * FROM people WHERE name='Carla Demo'"),
    ).toBeUndefined();
    expect(reconcile(s, batch.id, {}, "actor").result.people).toBe(0);
    // A later import proposes the skipped item again, the others as already reconciled.
    const again = await stage(s, secrets, id, "actor", reader);
    expect(
      again.items
        .filter((i: any) => !i.existingPersonId)
        .map((i: any) => i.name),
    ).toEqual(["Carla Demo"]);
  });
});
