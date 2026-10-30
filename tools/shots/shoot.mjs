// Screenshot harness: serves the built app, mocks the API with fixtures,
// screenshots tabs. Usage: node shoot.mjs [tab] — writes /tmp/shots/<tab>.png
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import puppeteer from "puppeteer-core";

const DIST = new URL("../../apps/web/dist", import.meta.url).pathname;
const API = "https://museaiteam-api.juarezjaramillo.workers.dev";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

const trial = { state: "active", daysLeft: null, endsAt: 0, graceUsed: false, subscribed: true };

const seats = [
  {
    id: "s-eng", role: "engineer", email: "engineer-abc123@hires.museaiteam.com",
    approved: true, keystone: "github", keystoneReady: true, sessionOne: true,
    on: ["github"], waiting: [{ tool: "linear", step: "invite", status: "waiting", detail: "opened the invite (Accept invite) — waiting on the account" }],
    box: "sleeping", spend: { seconds: 1500, cents: 6 },
    request: null,
    logins: [{ tool: "github", kind: "oauth", status: "ok", expires: null }],
  },
  {
    id: "s-pm", role: "pm", email: "pm-def456@hires.museaiteam.com",
    approved: true, keystone: "linear", keystoneReady: false, sessionOne: false,
    on: [], waiting: [],
    box: "none", spend: null,
    request: { id: "r1", status: "proposed", tools: ["linear", "github"], paid: ["linear", "github"] },
    logins: [],
  },
  {
    id: "s-des", role: "designer", email: "designer-ghi789@hires.museaiteam.com",
    approved: false, keystone: "figma", keystoneReady: false, sessionOne: false,
    on: [], waiting: [],
    box: "none", spend: null,
    request: { id: "r2", status: "proposed", tools: ["figma"], paid: ["figma"] },
    logins: [{ tool: "figma", kind: "session", status: "lost", expires: null }],
  },
];

const FIX = {
  "/api/me": { user: { id: "u1", email: "raul@example.com" }, orgId: "o1" },
  "/api/me/orgs": { orgs: [{ id: "o1", name: "Demo", role: "owner" }] },
  "/api/orgs/o1": { id: "o1", name: "Demo", trial, ideas: { cap: 250000, spent: 1200, left: 248800, graceHours: 72 }, boxMaxConcurrent: 3 },
  "/api/orgs/o1/teams": { teams: [{ id: "t1", name: "Team", seats: [] }] },
  "/api/orgs/o1/notifications?unread=1": { notifications: [{ id: "n1", kind: "seat.requested", title: "Moss (AI) asked for linear, github", body: "x", createdAt: "" }] },
  "/api/orgs/o1/team/seats": { seats, meanwhile: ["waiting on the hire's own Linear seat"] },
  "/api/orgs/o1/hires": { hires: [{ role: "engineer", runs: 4, proposals: 6, votes: 9, shipped: 5, up: 3, down: 0, tokens: 120000, tokensEstimated: false }] },
  "/api/orgs/o1/cutover": { cutOver: false, providers: ["github"], servers: [], kept: ["slack"] },
  "/api/orgs/o1/seat-requests": {
    requests: [
      { id: "r1", seatId: "s-pm", role: "pm", email: "pm-def456@hires.museaiteam.com", tools: ["linear", "github"], paid: ["linear", "github"], status: "proposed", createdAt: "" },
      { id: "r2", seatId: "s-des", role: "designer", email: "designer-ghi789@hires.museaiteam.com", tools: ["figma"], paid: ["figma"], status: "proposed", createdAt: "" },
    ],
  },
  "/api/orgs/o1/approvals": { approvals: [] },
  "/api/orgs/o1/proposals": { proposals: [] },
  "/api/orgs/o1/mcp": {
    servers: [
      { id: "srv-figma", name: "Figma", url: "https://mcp.figma.com", auth: "header", authName: "token", source: "founder", status: "trusted", spendCapCents: 0, hasSecret: true },
      { id: "srv-weird", name: "Acme Tracker", url: "https://acme.example/mcp", auth: "none", authName: "", source: "founder", status: "trusted", spendCapCents: 0, hasSecret: false },
    ],
    catalog: [],
  },
};

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/api/")) {
      // Normalize the org segment so fixtures match any org id.
      const key = (u.pathname + u.search).replace(/\/api\/orgs\/[^/]+\//, "/api/orgs/o1/");
      const hit = FIX[key] ?? null;
      if (!hit) console.log("UNMOCKED:", req.method, key);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(hit ?? {}));
      return;
    }
    const path = u.pathname;
    const file = path === "/" ? "/index.html" : path;
    const body = await readFile(join(DIST, file));
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(DIST, "/index.html"));
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  }
});
await new Promise((r) => server.listen(18923, "127.0.0.1", r));

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const CORS = {
  "Access-Control-Allow-Origin": "http://127.0.0.1:18923",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization",
};
await page.setRequestInterception(true);
page.on("request", (req) => {
  const url = req.url();
  if (url.startsWith(API + "/api/")) {
    if (req.method() === "OPTIONS") {
      req.respond({ status: 204, headers: CORS, body: "" });
      return;
    }
    const key = url.slice(API.length).replace(/\/api\/orgs\/[^/]+\//, "/api/orgs/o1/");
    const hit = FIX[key] ?? null;
    if (!hit) console.log("UNMOCKED:", req.method(), key);
    req.respond({
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify(hit ?? {}),
    });
    return;
  }
  req.continue();
});

const tab = process.argv[2] ?? "hires";
await page.goto(`http://127.0.0.1:18923/#/${tab}`, { waitUntil: "networkidle0", timeout: 20000 });
// Dismiss the onboarding wizard if it opens.
for (const text of ["Skip guide", "Skip for now"]) {
  const btns = await page.$$(`button`);
  for (const b of btns) {
    const t = await b.evaluate((el) => el.textContent);
    if (t?.includes(text)) {
      await b.click();
      await new Promise((r) => setTimeout(r, 400));
      break;
    }
  }
}
await new Promise((r) => setTimeout(r, 1200));
// Interaction script per tab: expand rows, open menus.
if (tab === "hires") {
  const rows = await page.$$(".hire-row");
  if (rows[1]) {
    await rows[1].click();
    await new Promise((r) => setTimeout(r, 400));
  }
  const btns = await page.$$("button");
  for (const b of btns) {
    const t = await b.evaluate((el) => el.textContent);
    if (t?.trim() === "give tools") {
      await b.click();
      await new Promise((r) => setTimeout(r, 400));
      break;
    }
  }
  const menus = await page.$$(".hire .icon-btn");
  if (menus[1]) {
    await menus[1].click();
    await new Promise((r) => setTimeout(r, 400));
  }
}
await page.screenshot({ path: `/tmp/shots/${tab}.png` });
// Fixtures always describe a signed-in founder: a Sign in link means the
// mocks silently stopped applying and the shot would prove nothing.
const signedOut = await page.evaluate(() =>
  [...document.querySelectorAll("a")].some((a) => a.textContent?.trim() === "Sign in"),
);
await browser.close();
server.close();
if (signedOut) {
  console.error("SHOT VOID: app rendered signed-out, fixtures did not apply");
  process.exit(1);
}
console.log(`wrote /tmp/shots/${tab}.png`);
