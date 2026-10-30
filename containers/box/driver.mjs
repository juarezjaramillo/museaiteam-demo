import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";

const PORT = Number(process.env.DRIVER_PORT ?? 8080);
const HOME = process.env.HIRE_HOME ?? "/home/hire";
const PROFILE = join(HOME, ".chromium");
const STEP_CAP = 25;
const BODY_LIMIT = 256 * 1024;

mkdirSync(HOME, { recursive: true });
mkdirSync(PROFILE, { recursive: true });

// --- helpers ---

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

/** Confine every file op under HOME. `..` escapes resolve outside and die. */
function confined(p) {
  const abs = resolve(HOME, String(p ?? "").replace(/^\/+/, ""));
  if (abs !== HOME && !abs.startsWith(HOME + "/")) throw new Error("path escapes the hire home");
  return abs;
}

// --- /run: argv only, no shell exists to inject into ---

const BINS = { node: process.execPath, python3: "python3", npx: "npx" };

function runCmd({ bin, args, timeoutSec }) {
  return new Promise((resolveRun) => {
    const exe = BINS[bin];
    if (!exe || !Array.isArray(args) || !args.every((a) => typeof a === "string" && !a.includes("\0"))) {
      resolveRun({ ok: false, error: "rejected command" });
      return;
    }
    execFile(
      exe,
      args,
      { cwd: HOME, timeout: Math.min(Math.max(timeoutSec ?? 60, 1), 300) * 1000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolveRun({
          ok: true,
          code: err?.code ?? 0,
          stdout: String(stdout ?? "").slice(0, 32768),
          stderr: String(stderr ?? "").slice(0, 32768),
        });
      },
    );
  });
}

// --- /files ---

function filesOp({ op, path, body }) {
  const abs = confined(path);
  if (op === "read") {
    return { ok: true, body: readFileSync(abs, "utf8").slice(0, 65536) };
  }
  if (op === "write") {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, String(body ?? "").slice(0, BODY_LIMIT));
    return { ok: true };
  }
  if (op === "list") {
    const names = readdirSync(abs);
    return {
      ok: true,
      entries: names.slice(0, 200).map((n) => ({ name: n, dir: statSync(join(abs, n)).isDirectory() })),
    };
  }
  return { ok: false, error: "unknown file op" };
}

// --- /browse: one chromium at a time, CDP steps under a cap ---

let browseQueue = Promise.resolve();

function cdpEval(ws, id, expression, awaitPromise = false) {
  return new Promise((resolveEval, reject) => {
    const timer = setTimeout(() => reject(new Error("cdp timeout")), 20000);
    const onMsg = (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off("message", onMsg);
      if (msg.error) reject(new Error(`cdp: ${msg.error.message ?? "error"}`.slice(0, 200)));
      else resolveEval(msg.result?.result?.value ?? null);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise, returnByValue: true } }));
  });
}

function cdpNavigate(ws, id, url) {
  return new Promise((resolveNav, reject) => {
    const timer = setTimeout(() => reject(new Error("navigation timeout")), 25000);
    const onMsg = (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.id === id && msg.error) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        reject(new Error(`navigate: ${msg.error.message ?? "error"}`.slice(0, 200)));
      }
      if (msg.method === "Page.loadEventFired") {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolveNav(null);
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Page.navigate", params: { url } }));
    ws.send(JSON.stringify({ id: id + 100000, method: "Page.enable" }));
  });
}

async function browseTask({ steps }) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > STEP_CAP) {
    return { ok: false, error: `steps must be 1..${STEP_CAP}` };
  }
  const run = async () => {
    const child = spawn(
      "chromium",
      ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--remote-debugging-port=9222", `--user-data-dir=${PROFILE}`, "about:blank"],
      { stdio: "ignore" },
    );
    const stop = () => {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
    };
    const deadline = Date.now() + 30000;
    let targets = null;
    try {
      while (Date.now() < deadline) {
        try {
          const res = await fetch("http://127.0.0.1:9222/json/list");
          targets = await res.json();
          if (Array.isArray(targets) && targets.length) break;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 400));
      }
      const page = (targets ?? []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (!page) return { ok: false, error: "chromium would not start" };
      const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 4 * 1024 * 1024 });
      await new Promise((resolveWs, rejectWs) => {
        ws.once("open", resolveWs);
        ws.once("error", rejectWs);
      });
      let id = 1;
      const snapshots = [];
      try {
        for (const step of steps) {
          if (step.op === "goto") {
            await cdpNavigate(ws, id++, String(step.url).slice(0, 2000));
          } else if (step.op === "click") {
            const sel = JSON.stringify(String(step.selector).slice(0, 500));
            const clicked = await cdpEval(ws, id++, `(!!document.querySelector(${sel}) && (document.querySelector(${sel}).click(), true))`);
            if (!clicked) throw new Error(`nothing to click: ${String(step.selector).slice(0, 100)}`);
          } else if (step.op === "fill" || step.op === "fillSecret") {
            const sel = JSON.stringify(String(step.selector).slice(0, 500));
            const val = JSON.stringify(String(step.op === "fill" ? step.text : step.secret).slice(0, 4000));
            const filled = await cdpEval(
              ws,
              id++,
              `(() => { const el = document.querySelector(${sel}); if (!el) return false; el.focus(); el.value = ${val}; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); return true; })()`,
            );
            if (!filled) throw new Error(`nothing to fill: ${String(step.selector).slice(0, 100)}`);
          } else if (step.op === "wait") {
            await new Promise((r) => setTimeout(r, Math.min(Math.max(step.ms ?? 1000, 0), 15000)));
          } else if (step.op === "snapshot") {
            const url = await cdpEval(ws, id++, "location.href");
            const title = await cdpEval(ws, id++, "document.title");
            const text = await cdpEval(ws, id++, "(document.body ? document.body.innerText : '').slice(0, 4000)");
            snapshots.push({ url: String(url ?? ""), title: String(title ?? ""), text: String(text ?? "") });
          } else {
            throw new Error("unknown browse op");
          }
        }
      } finally {
        try {
          ws.close();
        } catch { /* ignore */ }
      }
      return { ok: true, snapshots };
    } finally {
      stop();
    }
  };
  // Serialize: one chromium per box, so concurrent tasks queue, never collide.
  const p = browseQueue.then(run, run);
  browseQueue = p.catch(() => {});
  return p;
}

// --- /mcp: spawn per call, secrets in env memory only, handshake each time ---

const MCP_METHODS = new Set(["tools/list", "tools/call", "ping"]);

function mcpCall({ bin, args, method, params, secrets }) {
  return new Promise((resolveMcp) => {
    const exe = BINS[bin];
    if (!exe || !MCP_METHODS.has(method) || !Array.isArray(args)) {
      resolveMcp({ ok: false, error: "rejected mcp call" });
      return;
    }
    const child = spawn(exe, args, {
      cwd: HOME,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...(secrets ?? {}) },
    });
    let out = "";
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch { /* ignore */ }
      resolveMcp(res);
    };
    const timer = setTimeout(() => done({ ok: false, error: "mcp call timed out" }), 45000);
    child.on("error", () => {
      clearTimeout(timer);
      done({ ok: false, error: "mcp server would not start" });
    });
    child.stdout.on("data", (c) => {
      out += c.toString("utf8");
      if (out.length > BODY_LIMIT) {
        clearTimeout(timer);
        done({ ok: false, error: "mcp response too large" });
        return;
      }
      const lines = out.split("\n");
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) {
            clearTimeout(timer);
            if (msg.error) done({ ok: false, error: `mcp: ${String(msg.error.message ?? "error").slice(0, 300)}` });
            else done({ ok: true, result: msg.result ?? null });
            return;
          }
        } catch { /* partial line */ }
      }
    });
    const write = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    write({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hire-box", version: "0.1" } } });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    write({ jsonrpc: "2.0", id: 2, method, params: params ?? {} });
  });
}

// --- server ---

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://box");
    if (req.method === "GET" && (url.pathname === "/ping" || url.pathname === "/")) {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method !== "POST") {
      send(res, 404, { ok: false, error: "not found" });
      return;
    }
    const body = await readBody(req);
    if (url.pathname === "/run") send(res, 200, await runCmd(body));
    else if (url.pathname === "/files") send(res, 200, filesOp(body));
    else if (url.pathname === "/browse") send(res, 200, await browseTask(body));
    else if (url.pathname === "/mcp") send(res, 200, await mcpCall(body));
    else send(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    send(res, 200, { ok: false, error: String(err?.message ?? err).slice(0, 300) });
  }
});

server.listen(PORT, () => {
  process.stdout.write(`driver on ${PORT}\n`);
});
