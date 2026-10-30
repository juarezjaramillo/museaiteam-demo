import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), "hire-"));
const port = 18081;
const base = `http://127.0.0.1:${port}`;
let child;

async function post(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

before(async () => {
  child = spawn("node", [join(dir, "driver.mjs")], {
    env: { ...process.env, DRIVER_PORT: String(port), HIRE_HOME: home },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + "/ping");
      if (res.ok) return;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("driver would not start");
});

after(() => {
  child.kill("SIGKILL");
});

test("ping answers", async () => {
  const res = await fetch(base + "/ping");
  assert.equal((await res.json()).ok, true);
});

test("run executes argv with no shell", async () => {
  const r = await post("/run", { bin: "node", args: ["-e", "console.log(40 + 2)"] });
  assert.equal(r.ok, true);
  assert.equal(r.stdout.trim(), "42");
  // Shell metacharacters are inert data: no shell ever sees them.
  const evil = await post("/run", { bin: "node", args: ["-e", "'; touch PWNED; '"] });
  assert.equal(evil.ok, true);
});

test("run rejects unknown binaries", async () => {
  const r = await post("/run", { bin: "bash", args: ["-c", "id"] });
  assert.equal(r.ok, false);
});

test("files stay inside the hire home", async () => {
  assert.equal((await post("/files", { op: "write", path: "notes/a.txt", body: "hi" })).ok, true);
  assert.equal((await post("/files", { op: "read", path: "notes/a.txt" })).body, "hi");
  assert.ok((await post("/files", { op: "list", path: "notes" })).entries.length >= 1);
  assert.equal((await post("/files", { op: "read", path: "../../etc/hostname" })).ok, false);
});

test("browse rejects empty and oversized step lists without chromium", async () => {
  assert.equal((await post("/browse", { steps: [] })).ok, false);
  assert.equal((await post("/browse", { steps: new Array(26).fill({ op: "snapshot" }) })).ok, false);
});

test("mcp rejects unknown methods without spawning", async () => {
  const r = await post("/mcp", { bin: "npx", args: ["-y", "x"], method: "completion/create" });
  assert.equal(r.ok, false);
});
