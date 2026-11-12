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
  it("non importa nulla se lo schema non è quello del manuale", async () => {
    const s = new Store(":memory:");
    const id = realDevice(s);
    await expect(
      stage(s, secrets, id, "actor", async () => ({
        status: 200,
        body: { code: "200", card: [{ name: "x" }] },
      })),
    ).rejects.toMatchObject({ code: "FANVIL_RESPONSE_SCHEMA" });
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
