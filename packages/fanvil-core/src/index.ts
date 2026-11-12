import { FanvilReadError, httpReadError, safeReadError } from "./errors.ts";
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
  // Collection and reported i60K request use a space; the response uses an underscore.
  deviceInfo: {
    method: "POST",
    path: "/api/device_info",
    body: {
      type: { item: "device info", cmd: "get" },
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
export const PAGE_SIZE = 100;
const indexed = {
  cardsRead: "card",
  pinsRead: "password",
  personsDetail: "persons",
  eventsRead: "deviceLog",
} as const;
export function isPagedOperation(
  operation: ReadOperation,
): operation is keyof typeof indexed {
  return Object.hasOwn(indexed, operation);
}
// Same documented request, with the index window replaced. Other fields are untouched.
export function readSpec(operation: ReadOperation, page = 1) {
  const spec: { method: string; path: string; body?: any } = structuredClone(
    readRequests[operation],
  );
  if (isPagedOperation(operation) && spec.body)
    spec.body[indexed[operation]].index =
      (page - 1) * PAGE_SIZE + 1 + "-" + page * PAGE_SIZE;
  return spec;
}
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
const safeKey = (k: string) => (/^[a-zA-Z_.]{1,60}$/.test(k) ? k : "[field]");
const kindOf = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
// Names and JS types only: never values, so card numbers, PINs and names cannot leak.
function shapeOf(v: unknown) {
  if (Array.isArray(v)) {
    const first = v.find((x) => x && typeof x === "object");
    return {
      type: "array",
      length: v.length,
      ...(first
        ? {
            itemFields: Object.fromEntries(
              Object.entries(first)
                .slice(0, 30)
                .map(([k, x]) => [safeKey(k), kindOf(x)]),
            ),
          }
        : {}),
    };
  }
  if (v && typeof v === "object")
    return {
      type: "object",
      fields: Object.fromEntries(
        Object.entries(v)
          .slice(0, 30)
          .map(([k, x]) => [safeKey(k), kindOf(x)]),
      ),
    };
  return { type: kindOf(v) };
}
// Protocol status codes are short tokens, not personal data: keep them to explain device answers.
const codeOf = (v: unknown) =>
  (typeof v === "string" || typeof v === "number") &&
  /^[\w-]{1,8}$/.test(String(v))
    ? String(v)
    : undefined;
export function metadata(body: unknown): Record<string, any> {
  if (typeof body === "string") {
    const lines = body
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter(Boolean);
    return {
      format: "csv",
      fields: [],
      columns: (lines[0] ?? "")
        .split(",")
        .slice(0, 30)
        .map((c) => safeKey(c.trim().replace(/\s+/g, "_"))),
      rows: Math.max(lines.length - 1, 0),
      verified: false,
    };
  }
  return {
    format:
      body === null ? "null" : Array.isArray(body) ? "array" : typeof body,
    fields:
      body && typeof body === "object"
        ? Object.keys(body).slice(0, 30).map(safeKey)
        : [],
    shape:
      body && typeof body === "object" && !Array.isArray(body)
        ? Object.fromEntries(
            Object.entries(body)
              .slice(0, 30)
              .filter(([k]) => k !== "info")
              .map(([k, v]) => [safeKey(k), shapeOf(v)]),
          )
        : {},
    ...(body && typeof body === "object" && codeOf((body as any).code)
      ? { deviceCode: codeOf((body as any).code) }
      : {}),
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
    page = 1,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.options.enabled)
      throw new FanvilReadError(
        "FANVIL_READ_DISABLED",
        "Letture reali disabilitate: impostare FANVIL_READ_ENABLED=true a runtime e ridistribuire il servizio",
      );
    if (!target.approved || !Object.hasOwn(readRequests, operation))
      throw new FanvilReadError(
        "FANVIL_NOT_APPROVED",
        "Dispositivo o operazione non approvati: abilitare l’approvazione per le letture nel dispositivo",
      );
    if (
      !/^[a-zA-Z0-9.-]{1,253}$/.test(target.host) ||
      !Number.isInteger(target.port) ||
      target.port < 1 ||
      target.port > 65535 ||
      !["http", "https"].includes(target.protocol)
    )
      throw new FanvilReadError(
        "FANVIL_TARGET",
        "Destinazione non valida: inserire solo IP o hostname, con protocollo e porta nei rispettivi campi",
      );
    if (this.active >= (this.options.concurrency ?? 2))
      throw new FanvilReadError(
        "FANVIL_BUSY",
        "Limite concorrenza raggiunto: attendere il termine delle letture in corso",
      );
    if (!this.options.cidrs.length)
      throw new FanvilReadError(
        "FANVIL_LAN_NOT_CONFIGURED",
        "LAN non configurata: impostare FANVIL_ALLOWED_CIDRS con la rete autorizzata o il singolo IP /32",
      );
    this.active++;
    try {
      const addresses = await Promise.race([
        lookup(target.host, { all: true }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new FanvilReadError(
                  "FANVIL_DNS_TIMEOUT",
                  "Timeout DNS: usare un IP LAN o verificare il DNS del container",
                ),
              ),
            this.options.timeoutMs,
          );
          timer.unref();
        }),
      ]).catch((error) => {
        if (error instanceof FanvilReadError) throw error;
        throw new FanvilReadError(
          "FANVIL_DNS",
          "Nome dispositivo non risolto: verificare hostname e DNS del container",
        );
      });
      if (
        !addresses.length ||
        addresses.some((a) => !addressAllowed(a.address, this.options.cidrs))
      )
        throw new FanvilReadError(
          "FANVIL_LAN_DENIED",
          "Indirizzo fuori dalla LAN autorizzata: verificare FANVIL_ALLOWED_CIDRS; sono esclusi IP pubblici, loopback e link-local",
        );
      const address = addresses[0];
      const spec = readSpec(operation, page);
      const body =
        spec.body === undefined ? undefined : JSON.stringify(spec.body);
      return await new Promise((resolve, reject) => {
        const req = (target.protocol === "https" ? https : http).request(
          {
            hostname: target.host,
            port: target.port,
            family: address.family,
            path: spec.path,
            method: spec.method,
            auth: target.username + ":" + target.password,
            headers: {
              "content-type": "application/json",
              ...(body !== undefined
                ? { "content-length": Buffer.byteLength(body) }
                : {}),
            },
            lookup: (_host, _opts: any, cb: any) =>
              _opts.all
                ? cb(null, [address])
                : cb(null, address.address, address.family),
          },
          (res) => {
            if ((res.statusCode ?? 500) >= 300) {
              res.resume();
              reject(
                httpReadError(
                  res.statusCode ?? 500,
                  String(res.headers["www-authenticate"] ?? ""),
                ),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > (this.options.maxBytes ?? 1_048_576)) {
                reject(
                  new FanvilReadError(
                    "FANVIL_RESPONSE_SIZE",
                    "Risposta troppo grande: superato il limite della diagnostica",
                  ),
                );
                req.destroy();
                res.destroy();
              } else chunks.push(chunk);
            });
            res.on("end", () => {
              try {
                const raw = Buffer.concat(chunks).toString();
                resolve({
                  status: res.statusCode ?? 200,
                  // /api/userlist answers CSV text, every other read answers JSON.
                  body:
                    operation === "userlistRead"
                      ? raw
                      : raw
                        ? JSON.parse(raw)
                        : null,
                });
              } catch {
                reject(
                  new FanvilReadError(
                    "FANVIL_RESPONSE_FORMAT",
                    "Risposta JSON non valida: l’endpoint potrebbe restituire HTML o non essere supportato dal firmware",
                  ),
                );
              }
            });
            res.on("error", () =>
              reject(
                new FanvilReadError(
                  "FANVIL_CONNECTION",
                  "Lettura risposta interrotta dal dispositivo",
                ),
              ),
            );
          },
        );
        const timer = setTimeout(
          () =>
            req.destroy(
              new FanvilReadError(
                "FANVIL_TIMEOUT",
                "Connessione Fanvil: timeout; verificare rete del container, firewall, protocollo e porta",
              ),
            ),
          this.options.timeoutMs,
        );
        timer.unref();
        req.on("close", () => clearTimeout(timer));
        req.on("error", (error: NodeJS.ErrnoException) => {
          if (
            [
              "CERT_HAS_EXPIRED",
              "DEPTH_ZERO_SELF_SIGNED_CERT",
              "ERR_TLS_CERT_ALTNAME_INVALID",
              "SELF_SIGNED_CERT_IN_CHAIN",
              "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            ].includes(error.code ?? "")
          )
            reject(
              new FanvilReadError(
                "FANVIL_TLS",
                "Certificato HTTPS non valido o non attendibile: configurare un certificato e una CA validi",
              ),
            );
          else reject(safeReadError(error));
        });
        if (body) req.write(body);
        req.end();
      });
    } finally {
      this.active--;
    }
  }
}
export const MAX_PAGES = 50;
export type PagedRead<T> = {
  items: T[];
  pages: number;
  total: number | null;
  complete: boolean;
  stoppedBy: "short-page" | "total" | "repeat" | "page-limit";
};
// Sequential, bounded read of every index window. Stops when the device returns a short page,
// the declared total is reached, a page repeats (firmware ignoring the index) or the page cap hits.
// `complete` is false when the result may not be the whole list.
export async function readAllPages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; total: number | null }>,
  maxPages = MAX_PAGES,
): Promise<PagedRead<T>> {
  const items: T[] = [];
  let total: number | null = null,
    previousFirst: string | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const r = await fetchPage(page);
    total = r.total ?? total;
    const first = r.items.length ? JSON.stringify(r.items[0]) : null;
    if (page > 1 && first !== null && first === previousFirst)
      return {
        items,
        pages: page,
        total,
        complete: false,
        stoppedBy: "repeat",
      };
    previousFirst = first;
    items.push(...r.items);
    if (total !== null && items.length >= total)
      return { items, pages: page, total, complete: true, stoppedBy: "total" };
    if (r.items.length < PAGE_SIZE)
      return {
        items,
        pages: page,
        total,
        complete: total === null || items.length >= total,
        stoppedBy: "short-page",
      };
  }
  return {
    items,
    pages: maxPages,
    total,
    complete: false,
    stoppedBy: "page-limit",
  };
}
export function assertRealWriteBlocked(): never {
  throw Object.assign(
    Error("Scritture reali bloccate: adapter e firmware non verificati"),
    { statusCode: 409 },
  );
}

export { FanvilReadError, safeReadError } from "./errors.ts";
