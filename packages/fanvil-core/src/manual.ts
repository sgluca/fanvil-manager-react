import { z } from "zod";
const scalar = z.union([z.string(), z.number()]);
const envelope = z.object({
  code: scalar.refine(
    (v) => String(v) === "200",
    "Codice applicativo Fanvil non valido",
  ),
});
export const deviceInfoResponse = envelope.extend({
  type: z.object({ item: z.literal("device_info"), cmd: z.literal("get") }),
  info: z.record(z.string(), scalar),
});
export function parseDeviceInfo(body: unknown) {
  const result = deviceInfoResponse.safeParse(body);
  if (!result.success)
    return {
      recognized: false as const,
      reason: "Risposta non conforme al manuale 0.8.7",
    };
  const info = result.data.info;
  return {
    recognized: true as const,
    model: info["info.dev.Model"]?.toString() ?? null,
    firmware: info["info.sys.FwVersion"]?.toString() ?? null,
    uptime: info["info.sys.UpTime"]?.toString() ?? null,
    physicalDoorState: "unknown",
    schemaSource: "manual-0.8.7",
    hardwareVerified: false,
  };
}
export const cardsResponse = envelope.extend({
  card: z.array(
    z.object({
      name: z.string().default(""),
      cardNumber: z.string(),
      status: scalar.optional(),
      relay: scalar.optional(),
      period: z.union([z.string(), z.array(z.string())]).optional(),
      times: scalar.optional(),
    }),
  ),
  total: scalar.optional(),
});
export const pinsResponse = envelope.extend({
  password: z.array(
    z.object({
      name: z.string().default(""),
      password: z.string().optional(),
      refid: z.string().optional(),
      relay: scalar.optional(),
      status: scalar.optional(),
    }),
  ),
  total: scalar.optional(),
});
export const logResponse = envelope.extend({
  data: z.array(
    z.object({
      id: scalar,
      relay: scalar,
      openResult: scalar,
      openTime: scalar,
      userName: scalar.optional(),
      name: scalar.optional(),
      cardNumber: scalar.optional(),
      extra: scalar.optional(),
    }),
  ),
  total: scalar.optional(),
});
const totalOf = (v: unknown) =>
  v !== undefined && Number.isInteger(Number(v)) && Number(v) >= 0
    ? Number(v)
    : null;
// Fingerprint of a credential seen in a log entry: computed inside the parser so the
// plaintext card number or PIN never leaves it.
export type LogFingerprint = (kind: "rfid" | "pin", value: string) => string;
export function parseLogsPage(body: unknown, fingerprint?: LogFingerprint) {
  if (emptyList(body, "data")) return { items: [], total: 0 };
  const r = logResponse.parse(body);
  return { items: parseLogs(body, fingerprint), total: totalOf(r.total) };
}
const placeholderNames = new Set(["", "unknown", "anonymous", "stranger", "-"]);
function logUserName(r: { userName?: unknown; name?: unknown }) {
  const v = String(r.userName ?? r.name ?? "").trim();
  return placeholderNames.has(v.toLowerCase()) ? null : v.slice(0, 200);
}
// The manual shows `extra` as "<type>:<value>" (e.g. "P:" for a PIN). Only prefixes that
// unambiguously name a card or a PIN are used; anything else is discarded.
function logCredential(
  r: { cardNumber?: unknown; extra?: unknown },
  fingerprint?: LogFingerprint,
) {
  if (!fingerprint) return null;
  const card = String(r.cardNumber ?? "").trim();
  if (/^[0-9A-Fa-f]{1,32}$/.test(card)) return fingerprint("rfid", card);
  const m = /^([A-Za-z]+):(.+)$/.exec(String(r.extra ?? "").trim());
  if (!m) return null;
  const kind = m[1].toUpperCase(),
    value = m[2].trim();
  if (kind === "P" || kind === "PIN" || kind === "PASSWORD")
    return /^\d{1,16}$/.test(value) ? fingerprint("pin", value) : null;
  if (kind === "C" || kind === "CARD" || kind === "R" || kind === "RFID")
    return /^[0-9A-Fa-f]{1,32}$/.test(value)
      ? fingerprint("rfid", value)
      : null;
  return null;
}
export function parseLogs(body: unknown, fingerprint?: LogFingerprint) {
  return logResponse.parse(body).data.map((r) => {
    const seconds = Number(r.openTime);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 4102444800)
      throw Error("Timestamp Fanvil non valido");
    return {
      remoteId: String(r.id),
      relayNumber: [1, 2].includes(Number(r.relay)) ? Number(r.relay) : null,
      occurredAt: new Date(seconds * 1000).toISOString(),
      outcome:
        String(r.openResult) === "0"
          ? "granted"
          : String(r.openResult) === "1"
            ? "denied"
            : "unknown",
      personId: null,
      // Hints used only to match an existing person; never stored with the event.
      userName: logUserName(r),
      credentialFingerprint: logCredential(r, fingerprint),
    };
  });
}
export function parseCredentials(body: unknown, kind: "rfid" | "pin") {
  return kind === "rfid"
    ? cardsResponse.parse(body).card.map((r) => ({
        name: r.name,
        kind,
        value: r.cardNumber,
        remoteId: "card:" + r.cardNumber,
        readability: "readable",
      }))
    : pinsResponse.parse(body).password.map((r) => ({
        name: r.name,
        kind,
        value: r.password ?? null,
        remoteId: r.refid ? "pin:" + r.refid : null,
        readability: r.password ? "readable" : "unrecoverable",
      }));
}
export type ParsedCredential = {
  name: string;
  kind: "rfid" | "pin";
  value: string | null;
  remoteId: string | null;
  readability: string;
};
// i60K 2.12.55 answers an empty list with a non-"200" application code: an empty array is
// "nothing configured", whatever the code. Non-empty lists still require code 200.
function emptyList(body: unknown, key: string) {
  const list = (body as any)?.[key];
  return Array.isArray(list) && list.length === 0;
}
export function parseCredentialsPage(
  body: unknown,
  kind: "rfid" | "pin",
): { items: ParsedCredential[]; total: number | null } {
  if (emptyList(body, kind === "rfid" ? "card" : "password"))
    return { items: [], total: 0 };
  const r =
    kind === "rfid" ? cardsResponse.parse(body) : pinsResponse.parse(body);
  return { items: parseCredentials(body, kind), total: totalOf(r.total) };
}
// Pure serializers only: no transport or production write capability is exposed.
export function documentedCardAdd(v: {
  name: string;
  cardNumber: string;
  relay: "1" | "2" | "all";
}) {
  return { type: { cmd: "add" }, card: [{ ...v, status: "enable" }] };
}
export function documentedPinAdd(v: {
  name: string;
  password: string;
  refid: string;
  relay: "1" | "2" | "all";
}) {
  return {
    type: { cmd: "add" },
    password: [{ ...v, type: "local", status: "enable", number: "" }],
  };
}
export function documentedRelayOpen(relay: "1" | "2") {
  return {
    type: { cmd: "relayCtrl" },
    dooropen: { relay, action: "on", mode: "once" },
  };
}

// GET /api/userlist (observed on i60K 2.12.55, not in the manual for this model): CSV export.
function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}
const userlistColumns = ["Name", "Status", "Times", "Card Number", "Password"];
export function parseUserlist(body: unknown) {
  const [header, ...rows] = csvRows(
    typeof body === "string" ? body.replace(/^\uFEFF/, "") : "",
  );
  const missing = userlistColumns.filter((c) => !header?.includes(c));
  if (!header || missing.length)
    throw Object.assign(Error("Intestazione CSV non riconosciuta"), {
      issues: missing.map((c) => ({
        path: ["colonna"],
        code: "colonna mancante",
        expected: c,
      })),
    });
  const col = (r: string[], name: string) =>
    (r[header.indexOf(name)] ?? "").trim();
  return rows.map((r) => ({
    name: col(r, "Name"),
    status: col(r, "Status"),
    times: Number(col(r, "Times")) || 0,
    card: col(r, "Card Number"),
    // "*" is a placeholder for the remote-control entry, not a PIN.
    pin: col(r, "Password") === "*" ? "" : col(r, "Password"),
  }));
}
