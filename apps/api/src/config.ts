import { resolve } from "node:path";
export type Config = {
  databasePath: string;
  encryptionKey: string;
  sessionSecret: string;
  production: boolean;
  origin: string;
  demo: boolean;
  realRead: boolean;
  cidrs: string[];
  timeoutMs: number;
  retentionDays: number;
  eventCollectMinutes: number;
  webRoot?: string;
};
export function configFromEnv(): Config {
  const key = process.env.ENCRYPTION_KEY ?? "",
    secret = process.env.SESSION_SECRET ?? "";
  if (!/^[a-f0-9]{64}$/i.test(key) || secret.length < 32)
    throw Error(
      "Configurare ENCRYPTION_KEY (64 hex) e SESSION_SECRET (almeno 32 caratteri)",
    );
  const production = process.env.NODE_ENV === "production";
  const origin = process.env.PUBLIC_ORIGIN ?? "http://localhost:3000";
  if (production && !origin.startsWith("https://"))
    throw Error("PUBLIC_ORIGIN deve usare HTTPS in produzione");
  const timeoutMs = Number(process.env.FANVIL_TIMEOUT_MS ?? 5000),
    retentionDays = Number(process.env.EVENT_RETENTION_DAYS ?? 90),
    eventCollectMinutes = Number(process.env.EVENT_COLLECT_MINUTES ?? 5);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60000 ||
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3650 ||
    !Number.isInteger(eventCollectMinutes) ||
    eventCollectMinutes < 0 ||
    eventCollectMinutes > 1440
  )
    throw Error(
      "Timeout, retention o intervallo acquisizione eventi non validi",
    );
  return {
    databasePath: process.env.DATABASE_PATH ?? "data/fanvil.sqlite",
    encryptionKey: key,
    sessionSecret: secret,
    production,
    origin,
    demo: process.env.DEMO_MODE === "true",
    realRead: process.env.FANVIL_READ_ENABLED === "true",
    cidrs: (process.env.FANVIL_ALLOWED_CIDRS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    timeoutMs,
    retentionDays,
    eventCollectMinutes,
    webRoot: resolve("apps/web/dist"),
  };
}
