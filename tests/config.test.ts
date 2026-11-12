import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../apps/api/src/config.ts";

afterEach(() => vi.unstubAllEnvs());
function production() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("SESSION_SECRET", "cd".repeat(32));
  vi.stubEnv("PUBLIC_ORIGIN", "https://fanvil.test.invalid");
}
describe("Validazione runtime indipendente dalla build Compose", () => {
  it("rifiuta chiave o segreto vuoti anche quando Compose permette il parsing", () => {
    production();
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(() => configFromEnv()).toThrow("ENCRYPTION_KEY");
    vi.stubEnv("ENCRYPTION_KEY", "ab".repeat(32));
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => configFromEnv()).toThrow("SESSION_SECRET");
  });
  it("rifiuta origine mancante o HTTP in produzione", () => {
    production();
    vi.stubEnv("PUBLIC_ORIGIN", "");
    expect(() => configFromEnv()).toThrow("HTTPS");
    vi.stubEnv("PUBLIC_ORIGIN", "http://fanvil.test.invalid");
    expect(() => configFromEnv()).toThrow("HTTPS");
  });
  it("accetta configurazione di produzione completa senza attivare scritture reali", () => {
    production();
    vi.stubEnv("FANVIL_READ_ENABLED", "false");
    vi.stubEnv("FANVIL_WRITE_ENABLED", "true");
    const config = configFromEnv();
    expect(config.production).toBe(true);
    expect(config.realRead).toBe(false);
    expect(config).not.toHaveProperty("realWrite");
  });
});
