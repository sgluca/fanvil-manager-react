import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import {
  FanvilHttpClient,
  addressAllowed,
  type Target,
} from "../packages/fanvil-core/src/index.ts";
let behavior = "ok",
  received: {
    url: string;
    auth: string;
    body: string;
    method: string;
    contentLength: string;
    transferEncoding: string;
  }[] = [];
let target: Target, client: FanvilHttpClient;
const server = createServer(async (req: IncomingMessage, res) => {
  let body = "";
  for await (const chunk of req) body += chunk.toString();
  received.push({
    url: req.url!,
    auth: req.headers.authorization ?? "",
    body,
    method: req.method!,
    contentLength: String(req.headers["content-length"] ?? ""),
    transferEncoding: String(req.headers["transfer-encoding"] ?? ""),
  });
  if (behavior === "redirect") {
    res.writeHead(302, { location: "http://127.0.0.1/forbidden" }).end();
    return;
  }
  if (behavior === "auth" || behavior === "digest") {
    res
      .writeHead(401, {
        "www-authenticate":
          behavior === "digest"
            ? 'Digest realm="synthetic-sensitive", nonce="synthetic-token"'
            : 'Basic realm="synthetic-sensitive"',
      })
      .end("sensitive-body");
    return;
  }
  if (behavior === "html") {
    res.end("<html>sensitive-response</html>");
    return;
  }
  if (behavior === "large") {
    res.end(JSON.stringify({ large: "x".repeat(4096) }));
    return;
  }
  if (behavior === "busy") {
    res.writeHead(503).end();
    return;
  }
  if (behavior === "slow") {
    setTimeout(() => res.end("{}"), 1500).unref();
    return;
  }
  // Model the observed firmware distinction: request has a space, response an underscore.
  if (
    req.url === "/api/device_info" &&
    JSON.parse(body).type.item !== "device info"
  ) {
    res.writeHead(500).end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      type: { item: "device_info", cmd: "get" },
      info: { "info.sys.FwVersion": "TEST" },
      code: "200",
    }),
  );
});
beforeAll(async () => {
  const local = Object.values(networkInterfaces())
    .flat()
    .find(
      (i) =>
        i?.family === "IPv4" &&
        !i.internal &&
        addressAllowed(i.address, [
          "10.0.0.0/8",
          "172.16.0.0/12",
          "192.168.0.0/16",
        ]),
    );
  if (!local)
    throw Error("Manca interfaccia privata locale per il server HTTP mock");
  await new Promise<void>((r) => server.listen(0, local.address, r));
  target = {
    host: local.address,
    port: (server.address() as AddressInfo).port,
    protocol: "http",
    approved: true,
    username: "test-local",
    password: "synthetic-password",
  };
  client = new FanvilHttpClient({
    enabled: true,
    cidrs: [local.address + "/32"],
    timeoutMs: 2000,
    maxBytes: 1024,
    concurrency: 1,
  });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
describe("Trasporto su server locale, nessun dispositivo reale", () => {
  it("invia la richiesta Bruno verificata con Basic, spazio nel body e underscore nella risposta", async () => {
    behavior = "ok";
    received = [];
    const r = await client.read(target, "deviceInfo");
    expect(r.status).toBe(200);
    expect(received[0]).toMatchObject({
      url: "/api/device_info",
      method: "POST",
      auth:
        "Basic " +
        Buffer.from("test-local:synthetic-password").toString("base64"),
    });
    expect(JSON.parse(received[0].body).type).toEqual({
      item: "device info",
      cmd: "get",
    });
    expect((r.body as any).type.item).toBe("device_info");
    expect(received[0].contentLength).toBe(
      String(Buffer.byteLength(received[0].body)),
    );
    expect(received[0].transferEncoding).toBe("");
  });
  it("non segue redirect e limita dimensione e errori HTTP", async () => {
    behavior = "redirect";
    received = [];
    await expect(client.read(target, "deviceInfo")).rejects.toThrow("HTTP");
    expect(received).toHaveLength(1);
    behavior = "large";
    await expect(client.read(target, "deviceInfo")).rejects.toThrow();
    behavior = "busy";
    await expect(client.read(target, "deviceInfo")).rejects.toThrow("503");
  });
  it("timeout e limite concorrenza si rilasciano dopo errore", async () => {
    behavior = "slow";
    const timeoutClient = new FanvilHttpClient({
      enabled: true,
      cidrs: [target.host + "/32"],
      timeoutMs: 500,
      maxBytes: 1024,
      concurrency: 1,
    });
    const first = timeoutClient.read(target, "deviceInfo");
    await expect(timeoutClient.read(target, "peopleRead")).rejects.toThrow(
      "concorrenza",
    );
    await expect(first).rejects.toThrow("Connessione");
    behavior = "ok";
    expect((await timeoutClient.read(target, "deviceInfo")).status).toBe(200);
  });
  it("distingue autenticazione Basic/Digest e risposta non JSON senza esporre risposte o challenge", async () => {
    behavior = "auth";
    await expect(client.read(target, "deviceInfo")).rejects.toMatchObject({
      code: "FANVIL_AUTH",
      remoteStatus: 401,
    });
    behavior = "digest";
    let error: any;
    try {
      await client.read(target, "deviceInfo");
    } catch (e) {
      error = e;
    }
    expect(error.code).toBe("FANVIL_AUTH");
    expect(error.message).toContain("Digest");
    expect(error.message).not.toContain("synthetic-sensitive");
    expect(error.message).not.toContain("synthetic-token");
    behavior = "html";
    await expect(client.read(target, "deviceInfo")).rejects.toMatchObject({
      code: "FANVIL_RESPONSE_FORMAT",
    });
    behavior = "ok";
  });
  it("protegge IP risolto e operazioni arbitrarie", async () => {
    await expect(
      client.read({ ...target, host: "127.0.0.1" }, "deviceInfo"),
    ).rejects.toThrow("LAN");
    await expect(client.read(target, "reboot" as any)).rejects.toThrow(
      "approvati",
    );
  });
});
