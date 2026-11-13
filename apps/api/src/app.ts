import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import staticFiles from "@fastify/static";
import { z } from "zod";
import { hash, verify, argon2id } from "argon2";
import {
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Store, now, type Row } from "../../../packages/database/src/index.ts";
import {
  Secrets,
  masked,
  FanvilHttpClient,
  FanvilReadError,
  safeReadError,
  metadata,
  normalizeDeviceInfo,
  assertRealWriteBlocked,
  type ReadOperation,
} from "../../../packages/fanvil-core/src/index.ts";
import {
  schemas,
  personDto,
  deviceDto,
  credentialDto,
  patchSchemas,
  loginSchema,
  confirmSchema,
  relaySchema,
  membershipSchema,
  reconciliationSchema,
  canWrite,
  id,
  type Role,
} from "../../../packages/shared/src/index.ts";
import {
  fail,
  required,
  insertDevice,
  publicDevice,
  publicCredential,
  preview,
  apply,
  stage,
  batchView,
  reconcile,
  collectEvents,
  seedDemo,
  type DeviceReader,
  jobView,
} from "./services.ts";
import type { Config } from "./config.ts";
type User = { id: string; username: string; role: Role };
declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    csrf: string | null;
    sessionHash: string | null;
  }
}
const safeEqual = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function buildApp(config: Config, existingStore?: Store) {
  const s = existingStore ?? new Store(config.databasePath),
    secrets = new Secrets(config.encryptionKey);
  const app = Fastify({
    logger: {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
      ],
    },
    disableRequestLogging: true,
    bodyLimit: 65536,
  });
  app.decorateRequest("user", null);
  app.decorateRequest("csrf", null);
  app.decorateRequest("sessionHash", null);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Fanvil Manager",
        version: "0.1.0",
        description: "API locali. Scritture hardware non verificate bloccate.",
      },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "fanvil_session" },
          csrf: { type: "apiKey", in: "header", name: "x-csrf-token" },
        },
      },
      security: [{ session: [] }],
    },
  });
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    reply.header("cache-control", "no-store");
    if (
      req.url.split("?")[0] === "/api/health" ||
      req.url.split("?")[0] === "/api/auth/login"
    )
      return;
    const token = req.cookies.fanvil_session;
    if (token) {
      const tokenHash = createHmac("sha256", config.sessionSecret)
        .update(token)
        .digest("hex");
      const row = s.get(
        "SELECT u.id,u.username,u.role,se.csrf FROM sessions se JOIN admin_users u ON u.id=se.user_id WHERE se.token_hash=? AND se.expires_at>? AND u.active=1",
        tokenHash,
        now(),
      );
      if (row) {
        req.user = { id: row.id, username: row.username, role: row.role };
        req.csrf = row.csrf;
        req.sessionHash = tokenHash;
      }
    }
    if (!req.user)
      return reply.code(401).send({ error: "Autenticazione richiesta" });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const csrf = req.headers["x-csrf-token"];
      if (
        typeof csrf !== "string" ||
        !safeEqual(csrf, req.csrf ?? "") ||
        (req.headers.origin && req.headers.origin !== config.origin)
      )
        return reply.code(403).send({ error: "Protezione CSRF" });
      if (!canWrite(req.user.role) && req.url !== "/api/auth/logout")
        return reply
          .code(403)
          .send({ error: "Permesso di scrittura richiesto" });
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as any;
    const status =
      e instanceof z.ZodError
        ? 400
        : (e.statusCode ??
          (e.code?.startsWith("SQLITE") || e.code?.startsWith("ERR_SQLITE")
            ? 409
            : 500));
    if (status >= 500)
      app.log.error(
        { requestId: req.id, code: "INTERNAL_ERROR" },
        "Operazione fallita",
      );
    const message =
      e instanceof z.ZodError
        ? "Dati non validi: " +
          e.issues
            .map((v: any) => v.path.join(".") + ": " + v.message)
            .join("; ")
        : status >= 500
          ? "Errore interno"
          : e.code?.includes("SQLITE")
            ? "Operazione in conflitto con i dati esistenti"
            : e.message;
    return reply.code(status).send({
      error: message,
      ...(e instanceof FanvilReadError ? { code: e.code } : {}),
    });
  });
  const admin = (req: FastifyRequest) => {
    if (req.user?.role !== "admin")
      fail("Permesso amministratore richiesto", 403);
  };
  const audit = (
    req: FastifyRequest,
    action: string,
    entity: string | null = null,
    data: Record<string, unknown> = {},
  ) => s.audit(req.user?.id ?? null, action, entity, data);
  const route = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    summary: string,
    body: z.ZodType | undefined,
    handler: (
      req: FastifyRequest<{
        Params: Record<string, string>;
        Body: any;
        Querystring: any;
      }>,
      reply: FastifyReply,
    ) => any,
  ) =>
    app.route({
      method,
      url,
      ...(url === "/api/auth/login"
        ? { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }
        : {}),
      schema: {
        summary,
        tags: [url.split("/")[2]],
        ...(["/api/devices", "/api/credentials", "/api/people"].includes(url) &&
        method === "GET"
          ? {
              response: {
                200: z.toJSONSchema(
                  z.array(
                    url === "/api/devices"
                      ? deviceDto
                      : url === "/api/credentials"
                        ? credentialDto
                        : personDto,
                  ),
                  { target: "draft-7" },
                ),
              },
            }
          : {}),
        ...(body
          ? { body: z.toJSONSchema(body, { io: "input", target: "draft-7" }) }
          : {}),
      },
      handler,
    });
  const getId = (
    req: FastifyRequest<{
      Params: Record<string, string>;
      Body: any;
      Querystring: any;
    }>,
  ) => id.parse(req.params.id);
  route(
    "GET",
    "/api/health",
    "Stato applicazione",
    undefined,
    (_req, reply) => {
      const ok = s.get("PRAGMA quick_check")?.quick_check === "ok";
      return reply.code(ok ? 200 : 503).send({ status: ok ? "ok" : "error" });
    },
  );
  route("POST", "/api/auth/login", "Login", loginSchema, async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== config.origin)
      fail("Origine non consentita", 403);
    const v = loginSchema.parse(req.body),
      u = s.get(
        "SELECT * FROM admin_users WHERE username=? AND active=1",
        v.username,
      );
    const valid = await verify(u?.password_hash ?? dummyHash, v.password).catch(
      () => false,
    );
    if (!u || !valid) {
      s.audit(null, "auth.failed");
      return reply.code(401).send({ error: "Credenziali non valide" });
    }
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    s.run("DELETE FROM sessions WHERE expires_at<=?", now());
    s.run(
      "INSERT INTO sessions VALUES(?,?,?,?)",
      createHmac("sha256", config.sessionSecret).update(token).digest("hex"),
      u.id,
      csrf,
      new Date(Date.now() + 8 * 3600000).toISOString(),
    );
    reply.setCookie("fanvil_session", token, {
      httpOnly: true,
      secure: config.production,
      sameSite: "strict",
      path: "/",
      maxAge: 8 * 3600,
    });
    s.audit(u.id, "auth.login");
    return {
      user: { id: u.id, username: u.username, role: u.role },
      csrf,
      demo: config.demo,
      realRead: config.realRead,
      realWrite: false,
    };
  });
  route("GET", "/api/auth/me", "Sessione corrente", undefined, (req) => ({
    user: req.user,
    csrf: req.csrf,
    demo: config.demo,
    realRead: config.realRead,
    realWrite: false,
  }));
  route("POST", "/api/auth/logout", "Logout", confirmSchema, (req, reply) => {
    s.run("DELETE FROM sessions WHERE token_hash=?", req.sessionHash);
    reply.clearCookie("fanvil_session", { path: "/" });
    return { ok: true };
  });
  route("GET", "/api/dashboard", "Riepilogo", undefined, () => ({
    devices: s
      .all("SELECT * FROM devices ORDER BY name")
      .map((d) => publicDevice(s, d)),
    people: s.get("SELECT COUNT(*) count FROM people")!.count,
    pending: s.get(
      "SELECT COUNT(*) count FROM sync_jobs WHERE status IN ('preview','conflict','failed')",
    )!.count,
    events: s.all(
      "SELECT e.*,d.name device_name,r.name relay_name,p.name person_name FROM access_events e JOIN devices d ON e.device_id=d.id LEFT JOIN relays r ON r.id=e.relay_id LEFT JOIN people p ON p.id=e.person_id ORDER BY e.occurred_at DESC LIMIT 8",
    ),
    anomalies: s.all(
      "SELECT d.name,c.key,c.reason FROM device_capabilities c JOIN devices d ON d.id=c.device_id WHERE c.state IN ('unknown','unsupported') LIMIT 12",
    ),
  }));
  route("GET", "/api/devices", "Inventario", undefined, () =>
    s.all("SELECT * FROM devices ORDER BY name").map((d) => publicDevice(s, d)),
  );
  route(
    "POST",
    "/api/devices",
    "Registra dispositivo",
    schemas.devices,
    (req, reply) => {
      const v = schemas.devices.parse(req.body);
      if (v.mode === "real" || v.approved || v.username || v.password)
        admin(req);
      if (v.mode === "demo" && !config.demo) fail("Modalità demo disabilitata");
      const deviceId = s.transaction(() => {
        const key = insertDevice(s, secrets, v);
        audit(req, "device.create", key, { mode: v.mode });
        return key;
      });
      return reply
        .code(201)
        .send(publicDevice(s, required(s, "devices", deviceId)));
    },
  );
  route(
    "PATCH",
    "/api/devices/:id",
    "Modifica dispositivo",
    patchSchemas.devices,
    (req) => {
      const key = getId(req),
        d = required(s, "devices", key),
        v = patchSchemas.devices.parse(req.body);
      if (
        d.mode === "real" ||
        v.approved !== undefined ||
        v.username !== undefined ||
        v.password !== undefined
      )
        admin(req);
      if ((v.mode && v.mode !== d.mode) || (v.model && v.model !== d.model))
        fail(
          "Modello e modalità non modificabili: registrare un nuovo dispositivo",
        );
      const credentials = d.secret
        ? secrets.decrypt(d.secret)
        : { username: "", password: "" };
      s.transaction(() => {
        s.run(
          "UPDATE devices SET name=?,host=?,port=?,protocol=?,approved=?,secret=?,revision=revision+1 WHERE id=?",
          v.name ?? d.name,
          v.host ?? d.host,
          v.port ?? d.port,
          v.protocol ?? d.protocol,
          v.approved === undefined ? d.approved : +v.approved,
          v.username !== undefined || v.password !== undefined
            ? secrets.encrypt({
                username: v.username ?? credentials.username,
                password: v.password ?? credentials.password,
              })
            : d.secret,
          key,
        );
        audit(req, "device.update", key);
      });
      return publicDevice(s, required(s, "devices", key));
    },
  );
  route(
    "DELETE",
    "/api/devices/:id",
    "Rimuovi inventario locale",
    undefined,
    (req) => {
      admin(req);
      const key = getId(req);
      required(s, "devices", key);
      s.transaction(() => {
        s.run("DELETE FROM devices WHERE id=?", key);
        audit(req, "device.delete.local", key);
      });
      return { ok: true };
    },
  );
  route("PATCH", "/api/relays/:id", "Nome logico relay", relaySchema, (req) => {
    const key = getId(req);
    required(s, "relays", key);
    s.transaction(() => {
      s.run(
        "UPDATE relays SET name=? WHERE id=?",
        relaySchema.parse(req.body).name,
        key,
      );
      audit(req, "relay.rename", key);
    });
    return required(s, "relays", key);
  });
  route(
    "POST",
    "/api/relays/:id/open",
    "Apertura relay: bloccata",
    confirmSchema,
    (req) => {
      admin(req);
      const r = required(s, "relays", getId(req));
      audit(req, "relay.open.blocked", r.id);
      assertRealWriteBlocked();
    },
  );
  const client = new FanvilHttpClient({
    enabled: config.realRead,
    cidrs: config.cidrs,
    timeoutMs: config.timeoutMs,
  });
  // Single entry point for real reads: admin only, per-device approval and A10 limits enforced
  // here, failures stored as sanitized diagnostics and audited.
  // `actor` null = automatic collection: failures go to diagnostics only, not to the audit.
  const readerFor = (d: Row, actor: string | null): DeviceReader => {
    if (!d.secret) fail("Credenziali dispositivo mancanti", 409);
    const auth = secrets.decrypt(d.secret);
    return async (operation, page) => {
      if (d.model === "A10" && operation !== "deviceInfo")
        fail("Endpoint non supportato per A10 nel manuale 0.8.7", 409);
      try {
        return await client.read(
          { ...d, approved: !!d.approved, ...auth } as any,
          operation,
          page,
        );
      } catch (error) {
        const failure = safeReadError(error);
        s.transaction(() => {
          s.run(
            "INSERT INTO diagnostics VALUES(?,?,?,?,?)",
            randomUUID(),
            d.id,
            operation,
            JSON.stringify({
              source: "real",
              success: false,
              automatic: actor === null,
              code: failure.code,
              message: failure.message,
              ...(failure.remoteStatus ? { status: failure.remoteStatus } : {}),
            }),
            now(),
          );
          if (actor !== null)
            s.audit(actor, "inspector.failed", d.id, {
              operation,
              code: failure.code,
            });
        });
        throw failure;
      }
    };
  };
  // Single entry point for real reads from the API: admin only, per-device approval and A10
  // limits enforced, failures stored as sanitized diagnostics and audited.
  const deviceReader = (req: FastifyRequest, d: Row): DeviceReader => {
    admin(req);
    return readerFor(d, req.user?.id ?? null);
  };
  route(
    "POST",
    "/api/devices/:id/inspect",
    "Diagnostica di sola lettura",
    z.object({
      operation: z
        .enum([
          "deviceInfo",
          "peopleRead",
          "personsDetail",
          "cardsRead",
          "pinsRead",
          "eventsRead",
          "userlistRead",
        ])
        .default("deviceInfo"),
    }),
    async (req) => {
      const key = getId(req),
        d = required(s, "devices", key),
        operation = z.object({ operation: z.string() }).parse(req.body)
          .operation as ReadOperation;
      let result: any;
      if (d.mode === "demo") {
        result = {
          source: "mock",
          model: d.model,
          firmware: "demo-1.0",
          physicalDoorState: "unknown",
          verified: false,
        };
        s.run(
          "UPDATE devices SET firmware=?,last_contact=? WHERE id=?",
          "demo-1.0",
          now(),
          key,
        );
      } else {
        const response = await deviceReader(req, d)(operation, 1);
        result = {
          source: "real",
          status: response.status,
          ...metadata(response.body),
          ...(operation === "deviceInfo"
            ? normalizeDeviceInfo(response.body)
            : {}),
        };
        const parsed =
          operation === "deviceInfo"
            ? normalizeDeviceInfo(response.body)
            : null;
        s.run(
          "UPDATE devices SET last_contact=?,firmware=COALESCE(?,firmware) WHERE id=?",
          now(),
          parsed?.recognized ? parsed.firmware : null,
          key,
        );
      }
      s.transaction(() => {
        s.run(
          "INSERT INTO diagnostics VALUES(?,?,?,?,?)",
          randomUUID(),
          key,
          operation,
          JSON.stringify(result),
          now(),
        );
        audit(req, "inspector.read", key, { operation, mode: d.mode });
      });
      return result;
    },
  );
  route(
    "GET",
    "/api/devices/:id/diagnostics",
    "Metadati diagnostici sanitizzati",
    undefined,
    (req) =>
      s
        .all(
          "SELECT * FROM diagnostics WHERE device_id=? ORDER BY created_at DESC LIMIT 30",
          getId(req),
        )
        .map((d) => ({ ...d, metadata: JSON.parse(d.metadata) })),
  );
  route("GET", "/api/people", "Persone", undefined, () =>
    s
      .all("SELECT * FROM people ORDER BY name")
      .map((p) => ({ ...p, active: !!p.active })),
  );
  route("POST", "/api/people", "Crea persona", schemas.people, (req, reply) => {
    const v = schemas.people.parse(req.body),
      key = randomUUID();
    s.transaction(() => {
      s.run(
        "INSERT INTO people VALUES(?,?,?,?,?,?)",
        key,
        v.name,
        v.notes,
        +v.active,
        1,
        now(),
      );
      audit(req, "person.create", key);
    });
    return reply.code(201).send(
      personDto.parse({
        ...required(s, "people", key),
        active: !!required(s, "people", key).active,
      }),
    );
  });
  route(
    "PATCH",
    "/api/people/:id",
    "Aggiorna persona",
    patchSchemas.people,
    (req) => {
      const key = getId(req),
        p = required(s, "people", key),
        v = patchSchemas.people.parse(req.body);
      s.transaction(() => {
        s.run(
          "UPDATE people SET name=?,notes=?,active=?,revision=revision+1 WHERE id=?",
          v.name ?? p.name,
          v.notes ?? p.notes,
          v.active === undefined ? p.active : +v.active,
          key,
        );
        audit(req, "person.update", key);
      });
      return personDto.parse({
        ...required(s, "people", key),
        active: !!required(s, "people", key).active,
      });
    },
  );
  route(
    "DELETE",
    "/api/people/:id",
    "Disattiva persona senza cancellare credenziali",
    undefined,
    (req) => {
      const key = getId(req);
      required(s, "people", key);
      s.transaction(() => {
        s.run("UPDATE people SET active=0,revision=revision+1 WHERE id=?", key);
        audit(req, "person.deactivate", key);
      });
      return { ok: true };
    },
  );
  route("GET", "/api/credentials", "Credenziali mascherate", undefined, () =>
    s
      .all(
        "SELECT c.*,p.name person_name FROM credentials c JOIN people p ON p.id=c.person_id ORDER BY c.created_at DESC",
      )
      .map(publicCredential),
  );
  route(
    "POST",
    "/api/credentials",
    "Crea credenziale locale",
    schemas.credentials,
    (req, reply) => {
      const v = schemas.credentials.parse(req.body);
      required(s, "people", v.personId);
      if (v.readability === "readable" && !v.value) fail("Valore richiesto");
      if (v.readability === "unrecoverable" && v.value)
        fail("Credenziale illeggibile: omettere valore");
      const key = randomUUID();
      s.transaction(() => {
        s.run(
          "INSERT INTO credentials VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          key,
          v.personId,
          v.kind,
          v.value ? secrets.encrypt(v.value) : null,
          v.value ? secrets.fingerprint(v.kind, v.value) : null,
          masked(v.kind, v.value),
          v.readability,
          v.expiresAt,
          +v.revoked,
          v.origin,
          1,
          now(),
        );
        audit(req, "credential.create", key, { kind: v.kind });
      });
      return reply
        .code(201)
        .send(publicCredential(required(s, "credentials", key)));
    },
  );
  route(
    "PATCH",
    "/api/credentials/:id",
    "Revoca o scadenza locale",
    z.object({
      revoked: z.boolean().optional(),
      expiresAt: z.iso.datetime().nullable().optional(),
    }),
    (req) => {
      const key = getId(req),
        c = required(s, "credentials", key),
        v = z
          .object({
            revoked: z.boolean().optional(),
            expiresAt: z.iso.datetime().nullable().optional(),
          })
          .parse(req.body);
      s.transaction(() => {
        s.run(
          "UPDATE credentials SET revoked=?,expires_at=?,revision=revision+1 WHERE id=?",
          v.revoked === undefined ? c.revoked : +v.revoked,
          v.expiresAt === undefined ? c.expires_at : v.expiresAt,
          key,
        );
        audit(req, "credential.update", key);
      });
      return publicCredential(required(s, "credentials", key));
    },
  );
  route("GET", "/api/groups", "Gruppi e membri", undefined, () =>
    s.all("SELECT * FROM access_groups ORDER BY name").map((g) => ({
      ...g,
      members: s.all(
        "SELECT p.id,p.name FROM group_memberships m JOIN people p ON p.id=m.person_id WHERE group_id=?",
        g.id,
      ),
    })),
  );
  route("POST", "/api/groups", "Crea gruppo", schemas.groups, (req, reply) => {
    const v = schemas.groups.parse(req.body),
      key = randomUUID();
    s.transaction(() => {
      s.run("INSERT INTO access_groups VALUES(?,?,?)", key, v.name, v.notes);
      audit(req, "group.create", key);
    });
    return reply.code(201).send(required(s, "access_groups", key));
  });
  route(
    "PATCH",
    "/api/groups/:id",
    "Modifica gruppo",
    patchSchemas.groups,
    (req) => {
      const key = getId(req),
        g = required(s, "access_groups", key),
        v = patchSchemas.groups.parse(req.body);
      s.transaction(() => {
        s.run(
          "UPDATE access_groups SET name=?,notes=? WHERE id=?",
          v.name ?? g.name,
          v.notes ?? g.notes,
          key,
        );
        audit(req, "group.update", key);
      });
      return required(s, "access_groups", key);
    },
  );
  route(
    "DELETE",
    "/api/groups/:id",
    "Elimina gruppo locale",
    undefined,
    (req) => {
      const key = getId(req);
      s.transaction(() => {
        s.run("DELETE FROM access_rules WHERE group_id=?", key);
        s.run("DELETE FROM access_groups WHERE id=?", key);
        audit(req, "group.delete", key);
      });
      return { ok: true };
    },
  );
  route(
    "POST",
    "/api/groups/:id/members",
    "Aggiungi membro",
    membershipSchema,
    (req) => {
      const key = getId(req),
        v = membershipSchema.parse(req.body);
      required(s, "access_groups", key);
      required(s, "people", v.personId);
      s.transaction(() => {
        s.run(
          "INSERT OR IGNORE INTO group_memberships VALUES(?,?)",
          key,
          v.personId,
        );
        audit(req, "group.member.add", key, { personId: v.personId });
      });
      return { ok: true };
    },
  );
  route(
    "DELETE",
    "/api/groups/:id/members/:personId",
    "Rimuovi membro",
    undefined,
    (req) => {
      const key = getId(req),
        personId = id.parse(req.params.personId);
      s.transaction(() => {
        s.run(
          "DELETE FROM group_memberships WHERE group_id=? AND person_id=?",
          key,
          personId,
        );
        audit(req, "group.member.remove", key, { personId });
      });
      return { ok: true };
    },
  );
  route("GET", "/api/rules", "Regole desiderate", undefined, () =>
    s.all("SELECT * FROM access_rules"),
  );
  route(
    "POST",
    "/api/rules",
    "Crea permesso desiderato",
    schemas.rules,
    (req, reply) => {
      const v = schemas.rules.parse(req.body),
        relay = required(s, "relays", v.relayId);
      if (relay.device_id !== v.deviceId)
        fail("Relay non appartenente al dispositivo");
      const key = randomUUID();
      s.transaction(() => {
        s.run(
          "INSERT INTO access_rules VALUES(?,?,?,?,?)",
          key,
          v.personId,
          v.groupId,
          v.deviceId,
          v.relayId,
        );
        audit(req, "rule.create", key);
      });
      return reply.code(201).send(required(s, "access_rules", key));
    },
  );
  route(
    "DELETE",
    "/api/rules/:id",
    "Rimuovi regola desiderata",
    undefined,
    (req) => {
      const key = getId(req);
      s.transaction(() => {
        s.run("DELETE FROM access_rules WHERE id=?", key);
        audit(req, "rule.delete", key);
      });
      return { ok: true };
    },
  );
  route(
    "GET",
    "/api/device-credentials",
    "Stato osservato e sincronizzato",
    undefined,
    () =>
      s.all(
        "SELECT id,device_id,credential_id,remote_id,state,observed_json FROM device_credentials",
      ),
  );
  route(
    "POST",
    "/api/devices/:id/import",
    "Importa in staging",
    confirmSchema,
    async (req) => {
      const d = required(s, "devices", getId(req));
      return stage(
        s,
        secrets,
        d.id,
        req.user!.id,
        d.mode === "demo" ? undefined : deviceReader(req, d),
      );
    },
  );
  route("GET", "/api/imports", "Importazioni", undefined, () =>
    s
      .all("SELECT * FROM staging_batches ORDER BY created_at DESC LIMIT 100")
      .map((b) => batchView(s, b.id)),
  );
  route(
    "POST",
    "/api/imports/:id/reconcile",
    "Conferma riconciliazione locale",
    reconciliationSchema,
    (req) =>
      reconcile(
        s,
        getId(req),
        reconciliationSchema.parse(req.body).mappings,
        req.user!.id,
      ),
  );
  route(
    "POST",
    "/api/devices/:id/sync/preview",
    "Anteprima non distruttiva",
    confirmSchema,
    (req) => preview(s, secrets, getId(req), req.user!.id),
  );
  route("GET", "/api/sync", "Anteprime e applicazioni", undefined, () =>
    s
      .all("SELECT id FROM sync_jobs ORDER BY created_at DESC LIMIT 100")
      .map((j) => jobView(s, j.id)),
  );
  route(
    "POST",
    "/api/sync/:id/apply",
    "Applica esclusivamente nella demo",
    confirmSchema,
    (req) => {
      const key = getId(req);
      const d = required(s, "devices", required(s, "sync_jobs", key).device_id);
      if (d.mode === "real") {
        audit(req, "sync.apply.blocked", key);
        assertRealWriteBlocked();
      }
      return apply(s, secrets, key, req.user!.id);
    },
  );
  route(
    "POST",
    "/api/devices/:id/events/collect",
    "Acquisizione eventi",
    confirmSchema,
    async (req) => {
      const d = required(s, "devices", getId(req));
      return collectEvents(
        s,
        d.id,
        req.user!.id,
        d.mode === "demo" ? undefined : deviceReader(req, d),
        { retentionDays: config.retentionDays, secrets },
      );
    },
  );
  const eventQuery = z.object({
    deviceId: id.optional(),
    personId: id.optional(),
    relayId: id.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    outcome: z.enum(["granted", "denied", "unknown"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    format: z.enum(["json", "csv"]).optional(),
  });
  route(
    "GET",
    "/api/events",
    "Eventi paginati e filtri; esportazione pagina corrente",
    undefined,
    (req, reply) => {
      const q = eventQuery.parse(req.query),
        where: string[] = [],
        args: any[] = [];
      for (const [k, col] of [
        ["deviceId", "e.device_id"],
        ["personId", "e.person_id"],
        ["relayId", "e.relay_id"],
        ["outcome", "e.outcome"],
      ])
        if ((q as any)[k]) {
          where.push(col + "=?");
          args.push((q as any)[k]);
        }
      if (q.from) {
        where.push("e.occurred_at>=?");
        args.push(q.from);
      }
      if (q.to) {
        where.push("e.occurred_at<=?");
        args.push(q.to);
      }
      const clause = where.length ? " WHERE " + where.join(" AND ") : "";
      const total = s.get(
        "SELECT COUNT(*) count FROM access_events e" + clause,
        ...args,
      )!.count;
      const items = s.all(
        "SELECT e.*,d.name device_name,p.name person_name,r.name relay_name FROM access_events e JOIN devices d ON d.id=e.device_id LEFT JOIN people p ON p.id=e.person_id LEFT JOIN relays r ON r.id=e.relay_id" +
          clause +
          " ORDER BY e.occurred_at DESC,e.id LIMIT ? OFFSET ?",
        ...args,
        q.limit,
        (q.page - 1) * q.limit,
      );
      if (q.format) {
        audit(req, "events.export", null, {
          format: q.format,
          count: items.length,
        });
        reply.header(
          "content-disposition",
          `attachment; filename="eventi.${q.format}"`,
        );
        if (q.format === "csv") {
          const columns = [
            "id",
            "occurred_at",
            "device_name",
            "person_name",
            "relay_name",
            "outcome",
            "source",
          ];
          const cell = (v: any) =>
            '"' +
            String(v ?? "")
              .replace(/^[=+@-]/, "'" + "$&")
              .replaceAll('"', '""') +
            '"';
          return reply
            .type("text/csv; charset=utf-8")
            .send(
              "\uFEFF" +
                [
                  columns.join(","),
                  ...items.map((r) => columns.map((c) => cell(r[c])).join(",")),
                ].join("\r\n"),
            );
        }
        return reply.send({ items, total, page: q.page, limit: q.limit });
      }
      return { items, total, page: q.page, limit: q.limit };
    },
  );
  route("GET", "/api/audit", "Audit paginato", undefined, (req) => {
    admin(req);
    const q = z
      .object({ page: z.coerce.number().int().min(1).default(1) })
      .parse(req.query);
    return {
      items: s.all(
        "SELECT * FROM audit_logs ORDER BY created_at DESC,id LIMIT 100 OFFSET ?",
        (q.page - 1) * 100,
      ),
      total: s.get("SELECT COUNT(*) count FROM audit_logs")!.count,
    };
  });
  route("GET", "/api/users", "Utenti amministrativi", undefined, (req) => {
    admin(req);
    return s.all("SELECT id,username,role,active FROM admin_users");
  });
  route(
    "POST",
    "/api/users",
    "Crea utente",
    schemas.users,
    async (req, reply) => {
      admin(req);
      const v = schemas.users.parse(req.body),
        key = randomUUID(),
        passwordHash = await hash(v.password, { type: argon2id });
      s.transaction(() => {
        s.run(
          "INSERT INTO admin_users(id,username,password_hash,role) VALUES(?,?,?,?)",
          key,
          v.username,
          passwordHash,
          v.role,
        );
        audit(req, "user.create", key, { role: v.role });
      });
      return reply
        .code(201)
        .send({ id: key, username: v.username, role: v.role });
    },
  );
  route(
    "PATCH",
    "/api/users/:id",
    "Modifica ruolo, password o stato utente",
    z.object({
      role: z.enum(["admin", "operatore", "lettura"]).optional(),
      active: z.boolean().optional(),
      password: z.string().min(12).max(200).optional(),
    }),
    async (req) => {
      admin(req);
      const key = getId(req),
        u = required(s, "admin_users", key),
        v = z
          .object({
            role: z.enum(["admin", "operatore", "lettura"]).optional(),
            active: z.boolean().optional(),
            password: z.string().min(12).max(200).optional(),
          })
          .parse(req.body);
      const passwordHash = v.password
        ? await hash(v.password, { type: argon2id })
        : u.password_hash;
      s.transaction(() => {
        const current = required(s, "admin_users", key);
        if (
          current.role === "admin" &&
          current.active &&
          ((v.role && v.role !== "admin") || v.active === false) &&
          s.get(
            "SELECT COUNT(*) n FROM admin_users WHERE role='admin' AND active=1",
          )!.n <= 1
        )
          fail(
            "Non puoi disabilitare o declassare l’ultimo amministratore",
            409,
          );
        s.run(
          "UPDATE admin_users SET role=?,active=?,password_hash=? WHERE id=?",
          v.role ?? u.role,
          v.active === undefined ? u.active : +v.active,
          passwordHash,
          key,
        );
        s.run("DELETE FROM sessions WHERE user_id=?", key);
        audit(req, "user.update", key, {
          role: v.role ?? u.role,
          active: v.active ?? !!u.active,
          passwordChanged: !!v.password,
        });
      });
      return {
        id: key,
        username: u.username,
        role: v.role ?? u.role,
        active: v.active ?? !!u.active,
      };
    },
  );
  route(
    "POST",
    "/api/backup",
    "Backup SQLite consistente",
    confirmSchema,
    async (req, reply) => {
      admin(req);
      const file = join(
        dirname(config.databasePath),
        "backups",
        randomUUID() + ".sqlite",
      );
      audit(req, "backup.create");
      await s.backup(file);
      try {
        return reply
          .header(
            "content-disposition",
            'attachment; filename="fanvil-backup.sqlite"',
          )
          .header("x-fanvil-schema-version", "1")
          .type("application/vnd.sqlite3")
          .send(await readFile(file));
      } finally {
        await unlink(file);
      }
    },
  );
  route("GET", "/api/settings", "Configurazione sicura", undefined, (req) => ({
    demo: config.demo,
    realRead: config.realRead,
    realWrite: false,
    retentionDays: config.retentionDays,
    timezone: "Europe/Rome",
    role: req.user!.role,
    backupSchemaVersion: 1,
  }));
  await app.register(swaggerUi, { routePrefix: "/api/docs", staticCSP: true });
  if (config.webRoot && existsSync(config.webRoot)) {
    await app.register(staticFiles, { root: config.webRoot, prefix: "/" });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Endpoint non trovato" })
        : reply.sendFile("index.html"),
    );
  }
  const dummyHash = await hash(randomBytes(32), { type: argon2id });
  if (config.demo) seedDemo(s, secrets);
  const purge = () => {
    const cutoff = new Date(
      Date.now() - config.retentionDays * 86400000,
    ).toISOString();
    s.transaction(() => {
      const count = s.run(
        "DELETE FROM access_events WHERE occurred_at<?",
        cutoff,
      ).changes;
      s.run("DELETE FROM sessions WHERE expires_at<=?", now());
      s.run("DELETE FROM diagnostics WHERE created_at<?", cutoff);
      s.run(
        "UPDATE staging_items SET secret=NULL WHERE batch_id IN (SELECT id FROM staging_batches WHERE status='applied' AND created_at<?)",
        cutoff,
      );
      if (count)
        s.audit(null, "events.retention", null, { count: Number(count) });
    });
  };
  const timer = setInterval(purge, 3600000);
  timer.unref();
  // Automatic event collection from every approved real device (read-only).
  let collecting = false,
    collectTimer: NodeJS.Timeout | undefined,
    firstCollect: NodeJS.Timeout | undefined;
  const collectAll = async () => {
    if (collecting) return;
    collecting = true;
    try {
      const devices = s.all(
        "SELECT * FROM devices WHERE mode='real' AND approved=1 AND secret IS NOT NULL AND model<>'A10'",
      );
      for (const d of devices)
        try {
          await collectEvents(s, d.id, null, readerFor(d, null), {
            retentionDays: config.retentionDays,
            secrets,
          });
        } catch (error) {
          // Read failures are already in diagnostics; schema errors are stored here.
          if (!(error instanceof FanvilReadError)) continue;
          if (error.code === "FANVIL_RESPONSE_SCHEMA")
            s.run(
              "INSERT INTO diagnostics VALUES(?,?,?,?,?)",
              randomUUID(),
              d.id,
              "eventsCollect",
              JSON.stringify({
                source: "real",
                success: false,
                automatic: true,
                code: error.code,
                message: error.message,
              }),
              now(),
            );
        }
    } finally {
      collecting = false;
    }
  };
  if (config.realRead && config.eventCollectMinutes > 0) {
    firstCollect = setTimeout(() => void collectAll(), 15000);
    firstCollect.unref();
    collectTimer = setInterval(
      () => void collectAll(),
      config.eventCollectMinutes * 60000,
    );
    collectTimer.unref();
  }
  app.addHook("onClose", async () => {
    clearInterval(timer);
    clearInterval(collectTimer);
    clearTimeout(firstCollect);
    if (!existingStore) s.close();
  });
  return app;
}
