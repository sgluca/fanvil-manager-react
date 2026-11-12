import { hash, argon2id } from "argon2";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { Store } from "../../../packages/database/src/index.ts";

export async function readAdminPassword() {
  if (!process.stdin.isTTY)
    return readFileSync(0, "utf8").replace(/\r?\n$/, "");
  // Readline manages raw mode and editing; terminal control and password echo go to a sink.
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const reader = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
  });
  process.stdout.write(
    "Password amministratore (12–200 caratteri, input nascosto): ",
  );
  try {
    return await Promise.race([
      reader.question(""),
      new Promise<never>((_resolve, reject) =>
        reader.once("SIGINT", () => reject(Error("Operazione annullata"))),
      ),
    ]);
  } finally {
    reader.close();
    muted.end();
    process.stdout.write("\n");
  }
}

export async function createAdmin(
  store: Store,
  username: string,
  password: string,
) {
  if (!/^[a-zA-Z0-9_.-]{3,80}$/.test(username))
    throw Error(
      "Nome utente: 3–80 caratteri, lettere, numeri, punto, trattino o underscore",
    );
  if (password.length < 12 || password.length > 200)
    throw Error("Password: 12–200 caratteri");
  const passwordHash = await hash(password, { type: argon2id });
  return store.transaction(() => {
    if (store.get("SELECT id FROM admin_users WHERE username=?", username))
      throw Error("Nome utente già esistente: scegliere un altro nome");
    const id = randomUUID();
    store.run(
      "INSERT INTO admin_users(id,username,password_hash,role) VALUES(?,?,?,?)",
      id,
      username,
      passwordHash,
      "admin",
    );
    store.audit(null, "admin.bootstrap", id);
    return id;
  });
}
