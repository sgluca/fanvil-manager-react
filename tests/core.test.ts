import deviceInfoI60k from "./fixtures/device-info-i60k-sanitized.json";
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  Secrets,
  masked,
  redact,
  readRequests,
  addressAllowed,
  normalizeDeviceInfo,
  assertRealWriteBlocked,
  FanvilHttpClient,
} from "../packages/fanvil-core/src/index.ts";
import {
  parseLogs,
  parseCredentials,
  documentedCardAdd,
  documentedPinAdd,
  documentedRelayOpen,
} from "../packages/fanvil-core/src/manual.ts";
import {
  canWrite,
  capabilitiesForModel,
} from "../packages/shared/src/index.ts";
describe("Sicurezza e contratto manuale", () => {
  it("cifra con nonce distinto, autenticazione e chiave esterna", () => {
    const s = new Secrets(randomBytes(32).toString("hex"));
    const a = s.encrypt("PIN-SENSITIVE-9988"),
      b = s.encrypt("PIN-SENSITIVE-9988");
    expect(a).not.toBe(b);
    expect(a).not.toContain("9988");
    expect(s.decrypt(a)).toBe("PIN-SENSITIVE-9988");
    expect(() =>
      new Secrets(randomBytes(32).toString("hex")).decrypt(a),
    ).toThrow();
    expect(s.fingerprint("pin", "9988")).not.toBe(
      s.fingerprint("rfid", "9988"),
    );
  });
  it("maschera e redige payload e segreti annidati", () => {
    expect(masked("pin", "112233")).not.toContain("33");
    expect(
      JSON.stringify(
        redact({
          info: { password: "secret", cardNumber: "112233", extra: "P:112233" },
          Authorization: "Basic secret",
        }),
      ),
    ).not.toContain("112233");
  });
  it("RBAC e compatibilità A10 non attribuiscono verifiche hardware", () => {
    expect(canWrite("lettura")).toBe(false);
    expect(canWrite("operatore")).toBe(true);
    expect(
      capabilitiesForModel("real", "A10").find(
        (c) => c.key === "credentialsRead",
      )?.state,
    ).toBe("unsupported");
    expect(
      capabilitiesForModel("demo", "i62").some((c) => c.state === "verified"),
    ).toBe(false);
  });
  it("tutti i probe sono get senza comandi di controllo", () => {
    for (const request of Object.values(readRequests)) {
      expect(JSON.stringify(request)).not.toMatch(
        /reboot|relayCtrl|dooropen|"cmd":"add"|delAll|"cmd":"set"/,
      );
      if ("body" in request) expect(request.body.type.cmd).toBe("get");
    }
  });
  it("blocca pubblici, loopback, metadata e CIDR non autorizzati", () => {
    for (const ip of [
      "127.0.0.1",
      "169.254.169.254",
      "8.8.8.8",
      "0.0.0.0",
      "::1",
      "224.0.0.1",
    ])
      expect(addressAllowed(ip, ["0.0.0.0/0", "::/0"])).toBe(false);
    expect(addressAllowed("192.168.42.9", ["192.168.42.0/24"])).toBe(true);
    expect(addressAllowed("192.168.43.9", ["192.168.42.0/24"])).toBe(false);
    expect(addressAllowed("::ffff:127.0.0.1", ["0.0.0.0/0"])).toBe(false);
  });
  it("client disattivato o destinazione non approvata non accedono alla rete", async () => {
    const t = {
      host: "localhost",
      port: 80,
      protocol: "http" as const,
      approved: false,
      username: "u",
      password: "s",
    };
    await expect(
      new FanvilHttpClient({ enabled: false, cidrs: [], timeoutMs: 100 }).read(
        t,
        "deviceInfo",
      ),
    ).rejects.toThrow("disabilitate");
    await expect(
      new FanvilHttpClient({ enabled: true, cidrs: [], timeoutMs: 100 }).read(
        t,
        "deviceInfo",
      ),
    ).rejects.toThrow("approvati");
    expect(() => assertRealWriteBlocked()).toThrow();
  });
  it("distingue approvazione e LAN mancante prima di qualsiasi richiesta di rete", async () => {
    const client = new FanvilHttpClient({
      enabled: true,
      cidrs: [],
      timeoutMs: 100,
    });
    const target = {
      host: "never-contact.invalid",
      port: 80,
      protocol: "http" as const,
      approved: false,
      username: "u",
      password: "s",
    };
    await expect(client.read(target, "deviceInfo")).rejects.toMatchObject({
      code: "FANVIL_NOT_APPROVED",
    });
    await expect(
      client.read({ ...target, approved: true }, "deviceInfo"),
    ).rejects.toMatchObject({ code: "FANVIL_LAN_NOT_CONFIGURED" });
  });
  it("normalizza solo risposte conformi, senza confondere lock e porta fisica", () => {
    expect(normalizeDeviceInfo({})).toMatchObject({ recognized: false });
    expect(
      normalizeDeviceInfo({
        type: { item: "device_info", cmd: "get" },
        code: "503",
        info: {},
      }),
    ).toMatchObject({ recognized: false });
    expect(
      normalizeDeviceInfo({
        type: { item: "device_info", cmd: "get" },
        code: "200",
        info: {
          "info.dev.Model": "Generic Intercom",
          "info.sys.FwVersion": "TEST-1",
          "info.io.DoorLook.1.Status": "open",
        },
      }),
    ).toMatchObject({
      recognized: true,
      firmware: "TEST-1",
      physicalDoorState: "unknown",
      hardwareVerified: false,
    });
  });
  it("normalizza la risposta i60K riportata da Bruno senza diffondere MAC o certificare lo stato porta", () => {
    expect(readRequests.deviceInfo.body.type.item).toBe("device info");
    expect(normalizeDeviceInfo(deviceInfoI60k)).toMatchObject({
      recognized: true,
      model: "i60k",
      firmware: "2.12.55",
      physicalDoorState: "unknown",
      hardwareVerified: false,
    });
    expect(JSON.stringify(normalizeDeviceInfo(deviceInfoI60k))).not.toContain(
      deviceInfoI60k.info["info.dev.Mac"],
    );
  });
  it("scarta segreti nei log e relay ambiguo, converte epoch", () => {
    const parsed = parseLogs({
      code: "200",
      data: [
        {
          id: "1",
          relay: "0",
          openResult: "1",
          openTime: "1687951138",
          extra: "P:SECRET",
          extraJson: "PIN-SECRET",
          userName: "Unknown",
        },
      ],
    });
    expect(parsed[0]).toMatchObject({
      remoteId: "1",
      relayNumber: null,
      personId: null,
      outcome: "denied",
      occurredAt: "2023-06-28T11:18:58.000Z",
    });
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });
  it("PIN senza refid non riceve una falsa identità stabile", () => {
    const r = parseCredentials(
      {
        code: "200",
        password: [
          { name: "Demo", password: "SYNTHETIC", refid: "" },
          { name: "Illeggibile" },
        ],
      },
      "pin",
    );
    expect(r[0].remoteId).toBeNull();
    expect(r[1].readability).toBe("unrecoverable");
  });
  it("serializzatori documentati puri non usano reboot", () => {
    expect(documentedRelayOpen("2")).toMatchObject({
      type: { cmd: "relayCtrl" },
      dooropen: { relay: "2", mode: "once" },
    });
    expect(
      documentedCardAdd({ name: "Demo", cardNumber: "DEMO", relay: "1" })
        .card[0].status,
    ).toBe("enable");
    expect(
      documentedPinAdd({
        name: "Demo",
        password: "DEMO",
        refid: "demo",
        relay: "2",
      }).password[0].type,
    ).toBe("local");
  });
});
