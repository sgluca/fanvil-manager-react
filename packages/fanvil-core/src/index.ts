import { parseDeviceInfo } from "./manual.ts";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
export class Secrets {
  private key: Buffer;
  constructor(key: string) {
    this.key = Buffer.from(key, "hex");
    if (!/^[a-f0-9]{64}$/i.test(key))
      throw Error("ENCRYPTION_KEY deve contenere 64 caratteri esadecimali");
  }
  encrypt(value: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), enc]
      .map((v) => v.toString("base64"))
      .join(".");
  }
  decrypt<T = any>(value: string): T {
    const [iv, tag, data] = value
      .split(".")
      .map((v) => Buffer.from(v, "base64"));
    const c = createDecipheriv("aes-256-gcm", this.key, iv);
    c.setAuthTag(tag);
    return JSON.parse(Buffer.concat([c.update(data), c.final()]).toString());
  }
  fingerprint(kind: string, value: string) {
    return createHmac("sha256", this.key)
      .update(kind + "\0" + value)
      .digest("hex");
  }
}
export function masked(kind: string, value?: string) {
  return kind === "pin"
    ? "••••••"
    : value
      ? "••••" + value.slice(-4)
      : "Non recuperabile";
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|pin|cardnumber|authorization|secret|token|username|cookie|value/i.test(
          k,
        )
          ? "[REDACTED]"
          : redact(v),
      ]),
    );
  return typeof value === "string" ? "[text omitted]" : value;
}
export const readRequests = {
  deviceInfo: {
    method: "POST",
    path: "/api/device_info",
    body: {
      type: { item: "device_info", cmd: "get" },
      info: Object.fromEntries(
        [
          "info.dev.Model",
          "info.sys.FwVersion",
          "info.dev.Mac",
          "info.sys.UpTime",
          "info.sys.MemFree",
          "info.sip.line.1.registerCode",
          "info.sip.line.1.callStatus",
          "info.io.DoorLook.1.Status",
          "info.io.DoorLook.2.Status",
        ].map((k) => [k, ""]),
      ),
    },
  },
  cardsRead: {
    method: "POST",
    path: "/api/card_info",
    body: {
      type: { cmd: "get", condition: "index" },
      card: { index: "1-100" },
    },
  },
  pinsRead: {
    method: "POST",
    path: "/api/password_info",
    body: {
      type: { cmd: "get", condition: "index" },
      password: { index: "1-100" },
    },
  },
  personsDetail: {
    method: "POST",
    path: "/api/persons",
    body: {
      type: { cmd: "get", condition: "index" },
      persons: { index: "1-100" },
    },
  },
  peopleRead: { method: "GET", path: "/api/persons" },
  userlistRead: { method: "GET", path: "/api/userlist" },
  eventsRead: {
    method: "POST",
    path: "/api/device_log",
    body: {
      type: { cmd: "get", condition: "index" },
      deviceLog: { index: "1-100" },
    },
  },
} as const;
export type ReadOperation = keyof typeof readRequests;
export type Target = {
  host: string;
  port: number;
  protocol: "http" | "https";
  approved: boolean;
  username: string;
  password: string;
};
export function addressAllowed(address: string, cidrs: string[]) {
  try {
    const a = ipaddr.process(address);
    if (a.range() !== "private" && a.range() !== "uniqueLocal") return false;
    return cidrs.some((c) => {
      const [net, prefix] = ipaddr.parseCIDR(c);
      return a.kind() === net.kind() && a.match(net, prefix);
    });
  } catch {
    return false;
  }
}
export function metadata(body: unknown) {
  return {
    format:
      body === null ? "null" : Array.isArray(body) ? "array" : typeof body,
    fields:
      body && typeof body === "object"
        ? Object.keys(body)
            .slice(0, 30)
            .map((k) => (/^[a-zA-Z_.]{1,60}$/.test(k) ? k : "[field]"))
        : [],
    verified: false,
  };
}
// Parser verified against synthetic manual fixtures; hardware compatibility remains unknown.
export const normalizeDeviceInfo = parseDeviceInfo;
export class FanvilHttpClient {
  private active = 0;
  constructor(
    private options: {
      enabled: boolean;
      cidrs: string[];
      timeoutMs: number;
      maxBytes?: number;
      concurrency?: number;
    },
  ) {}
  async read(
    target: Target,
    operation: ReadOperation,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.options.enabled) throw Error("Letture reali disabilitate");
    if (!target.approved || !Object.hasOwn(readRequests, operation))
      throw Error("Dispositivo o operazione non approvati");
    if (
      !/^[a-zA-Z0-9.-]{1,253}$/.test(target.host) ||
      !Number.isInteger(target.port) ||
      target.port < 1 ||
      target.port > 65535 ||
      !["http", "https"].includes(target.protocol)
    )
      throw Error("Destinazione non valida");
    if (this.active >= (this.options.concurrency ?? 2))
      throw Error("Limite concorrenza raggiunto");
    this.active++;
    try {
      const addresses = await Promise.race([
        lookup(target.host, { all: true }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(Error("Timeout DNS")),
            this.options.timeoutMs,
          );
          timer.unref();
        }),
      ]);
      if (
        !addresses.length ||
        addresses.some((a) => !addressAllowed(a.address, this.options.cidrs))
      )
        throw Error("Indirizzo fuori dalla LAN autorizzata");
      const address = addresses[0];
      const spec = readRequests[operation];
      const body = "body" in spec ? JSON.stringify(spec.body) : undefined;
      return await new Promise((resolve, reject) => {
        const req = (target.protocol === "https" ? https : http).request(
          {
            hostname: target.host,
            port: target.port,
            family: address.family,
            path: spec.path,
            method: spec.method,
            auth: target.username + ":" + target.password,
            headers: { "content-type": "application/json" },
            lookup: (_host, _opts: any, cb: any) =>
              _opts.all
                ? cb(null, [address])
                : cb(null, address.address, address.family),
          },
          (res) => {
            if ((res.statusCode ?? 500) >= 300) {
              res.resume();
              reject(Error("Risposta HTTP non valida: " + res.statusCode));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > (this.options.maxBytes ?? 1_048_576)) {
                reject(Error("Risposta troppo grande"));
                req.destroy();
                res.destroy();
              } else chunks.push(chunk);
            });
            res.on("end", () => {
              try {
                const raw = Buffer.concat(chunks).toString();
                resolve({
                  status: res.statusCode ?? 200,
                  body: raw ? JSON.parse(raw) : null,
                });
              } catch {
                reject(Error("Risposta JSON non valida"));
              }
            });
            res.on("error", () => reject(Error("Lettura risposta interrotta")));
          },
        );
        const timer = setTimeout(
          () => req.destroy(Error("Timeout Fanvil")),
          this.options.timeoutMs,
        );
        timer.unref();
        req.on("close", () => clearTimeout(timer));
        req.on("error", () => reject(Error("Connessione Fanvil fallita")));
        if (body) req.write(body);
        req.end();
      });
    } finally {
      this.active--;
    }
  }
}
export function assertRealWriteBlocked(): never {
  throw Object.assign(
    Error("Scritture reali bloccate: adapter e firmware non verificati"),
    { statusCode: 409 },
  );
}
