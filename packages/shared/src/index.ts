import { z } from "zod";
export const models = ["i60K", "i60", "A10", "i62"] as const;
export const roles = ["admin", "operatore", "lettura"] as const;
export type Role = (typeof roles)[number];
export type CapabilityState =
  "supported" | "unsupported" | "unknown" | "verified";
export const id = z.uuid();
const text = z.string().trim().min(1).max(200);
export const schemas = {
  devices: z.object({
    name: text,
    model: z.enum(models),
    host: z
      .string()
      .trim()
      .max(253)
      .regex(/^[a-zA-Z0-9.-]+$/),
    port: z.number().int().min(1).max(65535).default(80),
    protocol: z.enum(["http", "https"]).default("http"),
    mode: z.enum(["demo", "real"]).default("demo"),
    approved: z.boolean().default(false),
    username: z.string().max(100).optional(),
    password: z.string().max(500).optional(),
  }),
  people: z.object({
    name: text,
    notes: z.string().max(4000).default(""),
    active: z.boolean().default(true),
  }),
  credentials: z.object({
    personId: id,
    kind: z.enum(["rfid", "pin"]),
    value: z.string().trim().min(1).max(128).optional(),
    readability: z.enum(["readable", "unrecoverable"]).default("readable"),
    expiresAt: z.iso.datetime().nullable().default(null),
    revoked: z.boolean().default(false),
    origin: z.enum(["local", "demo", "import"]).default("local"),
  }),
  groups: z.object({ name: text, notes: z.string().max(2000).default("") }),
  rules: z
    .object({
      personId: id.nullable().default(null),
      groupId: id.nullable().default(null),
      deviceId: id,
      relayId: id,
    })
    .refine(
      (v) => Boolean(v.personId) !== Boolean(v.groupId),
      "Scegli persona oppure gruppo",
    ),
  users: z.object({
    username: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[a-zA-Z0-9_.-]+$/),
    password: z.string().min(12).max(200),
    role: z.enum(roles),
  }),
};
export const confirmSchema = z.object({ confirm: z.literal(true) });
export const loginSchema = z.object({
  username: z.string().min(1).max(80),
  password: z.string().min(1).max(200),
});
export const relaySchema = z.object({ name: text });
export const membershipSchema = z.object({ personId: id });
export const reconciliationSchema = z.object({
  confirm: z.literal(true),
  mappings: z.record(z.string(), id).default({}),
});
export function canWrite(role: Role) {
  return role === "admin" || role === "operatore";
}
export const capabilityKeys = [
  "deviceInfo",
  "peopleRead",
  "credentialsRead",
  "eventsRead",
  "credentialWrite",
  "relayOpen",
  "timeWindows",
] as const;
export function defaultCapabilities(mode: "demo" | "real") {
  return capabilityKeys.map((key) => ({
    key,
    state: (mode === "demo" && key !== "timeWindows"
      ? "supported"
      : "unknown") as CapabilityState,
    reason:
      mode === "demo"
        ? "Simulazione locale; nessuna verifica hardware"
        : "Formato risposta e supporto firmware non verificati",
    source: mode === "demo" ? "mock-v1" : "collection-unverified",
  }));
}

export function capabilitiesForModel(mode: "demo" | "real", model: string) {
  return defaultCapabilities(mode).map((c) =>
    mode === "real" &&
    model === "A10" &&
    ["peopleRead", "credentialsRead", "eventsRead", "credentialWrite"].includes(
      c.key,
    )
      ? {
          ...c,
          state: "unsupported" as CapabilityState,
          reason:
            "A10 escluso dalla lista modelli per questo endpoint nel manuale 0.8.7 §3.1",
          source: "manual-0.8.7",
        }
      : c,
  );
}
export const patchSchemas = {
  devices: z.object({
    name: schemas.devices.shape.name.optional(),
    model: z.enum(models).optional(),
    host: schemas.devices.shape.host.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(["http", "https"]).optional(),
    mode: z.enum(["demo", "real"]).optional(),
    approved: z.boolean().optional(),
    username: z.string().max(100).optional(),
    password: z.string().max(500).optional(),
  }),
  people: z.object({
    name: schemas.people.shape.name.optional(),
    notes: z.string().max(4000).optional(),
    active: z.boolean().optional(),
  }),
  groups: z.object({
    name: schemas.groups.shape.name.optional(),
    notes: z.string().max(2000).optional(),
  }),
};

export const relayDto = z.object({
  id,
  device_id: id,
  number: z.number().int(),
  name: z.string(),
  physical_state: z.literal("unknown"),
});
export const capabilityDto = z.object({
  device_id: id,
  key: z.string(),
  state: z.enum(["supported", "unsupported", "unknown", "verified"]),
  reason: z.string(),
  source: z.string(),
});
export const deviceDto = z.object({
  id,
  name: z.string(),
  model: z.enum(models),
  host: z.string(),
  port: z.number().int(),
  protocol: z.enum(["http", "https"]),
  mode: z.enum(["demo", "real"]),
  approved: z.boolean(),
  hasCredentials: z.boolean(),
  firmware: z.string().nullable(),
  last_contact: z.string().nullable(),
  revision: z.number().int(),
  created_at: z.string(),
  relays: z.array(relayDto),
  capabilities: z.array(capabilityDto),
});
export const credentialDto = z.object({
  id,
  person_id: id,
  person_name: z.string().optional(),
  kind: z.enum(["rfid", "pin"]),
  masked: z.string(),
  readability: z.enum(["readable", "unrecoverable"]),
  expires_at: z.string().nullable(),
  revoked: z.boolean(),
  origin: z.enum(["local", "demo", "import"]),
  revision: z.number().int(),
  created_at: z.string(),
});
export const personDto = z.object({
  id,
  name: z.string(),
  notes: z.string(),
  active: z.boolean(),
  revision: z.number().int(),
  created_at: z.string(),
});
export type DeviceDto = z.infer<typeof deviceDto>;
export type CredentialDto = z.infer<typeof credentialDto>;
export type PersonDto = z.infer<typeof personDto>;
