import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
const password = randomBytes(20).toString("hex");
const env = {
  ...process.env,
  ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  SESSION_SECRET: randomBytes(32).toString("hex"),
  PUBLIC_ORIGIN: "https://smoke.invalid",
  DEMO_MODE: "true",
  FANVIL_READ_ENABLED: "false",
};
const base = [
  "--host=unix:///var/run/docker.sock",
  "compose",
  "-p",
  "fanvil-smoke-" + randomBytes(4).toString("hex"),
];
const compose = (args, input) =>
  execFileSync("docker", [...base, ...args], {
    env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  });
const probe = (create) => {
  const code = `
 const assert=(v)=>{if(!v)throw Error('Smoke assertion failed')};
 const login=await fetch('http://127.0.0.1:3000/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'smoke-admin',password:${JSON.stringify(password)}})});assert(login.ok);
 const auth=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
 const headers={'content-type':'application/json',cookie,'x-csrf-token':auth.csrf};
 const devices=await fetch('http://127.0.0.1:3000/api/devices',{headers}).then(r=>r.json());assert(devices.length===4);assert(devices.find(d=>d.model==='i62').relays.length===2);
 if(${JSON.stringify(create)}){const res=await fetch('http://127.0.0.1:3000/api/people',{method:'POST',headers,body:JSON.stringify({name:'Persistenza Docker',notes:'synthetic'})});assert(res.status===201);}
 const people=await fetch('http://127.0.0.1:3000/api/people',{headers}).then(r=>r.json());assert(people.filter(p=>p.name==='Persistenza Docker').length===1);
 const health=await fetch('http://127.0.0.1:3000/api/health');assert(health.ok);console.log(JSON.stringify({devices:devices.length,people:people.length,persisted:true}));`;
  return JSON.parse(
    compose(["exec", "-T", "app", "node", "--input-type=module"], code),
  );
};
try {
  compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "60"]);
  compose(
    ["exec", "-T", "app", "node", "dist/cli.js", "admin:create", "smoke-admin"],
    password,
  );
  assert.equal(compose(["exec", "-T", "app", "id", "-u"]).trim(), "1000");
  const before = probe(true);
  compose(["kill", "-s", "SIGKILL", "app"]);
  compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "60"]);
  const after = probe(false);
  assert.deepEqual(before, after);
  compose(["stop", "app"]);
  compose([
    "run",
    "--rm",
    "-T",
    "app",
    "node",
    "dist/cli.js",
    "backup",
    "/app/data/backups/smoke.sqlite",
  ]);
  compose([
    "run",
    "--rm",
    "-T",
    "app",
    "node",
    "dist/cli.js",
    "restore",
    "/app/data/backups/smoke.sqlite",
  ]);
  compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "60"]);
  assert.deepEqual(probe(false), before);
  console.log(
    "Docker Compose: online admin creation, health, non-root, persistence after SIGKILL, backup and restore verified.",
  );
} catch (error) {
  console.error(error.message);
  if (error.stderr) console.error(error.stderr.toString());
  try {
    console.error(compose(["logs", "--tail", "30", "app"]));
  } catch {
    /* shutdown below */
  }
  process.exitCode = 1;
} finally {
  compose(["down", "-v", "--remove-orphans"]);
}
