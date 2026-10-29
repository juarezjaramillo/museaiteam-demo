# MCP spec: hires wield long-tail tools

Interview-settled. Hires today never touch tools — they output JSON and
hand-written code calls fixed APIs. MCP is the first tool loop: catalog
+ founder-added remote servers, per-service trust, sensitive tools ask
first, account creation approval-gated.

Hard constraints (design around, not through):

- Workers can't spawn processes: **remote servers only** (Streamable
  HTTP). No `npx` servers, ever. The UI says so where a URL is pasted.
- No browser automation: the hire cannot fill web signup forms. Signup
  means API signup where the service offers it, else approval-gated
  **guided connect** (founder creates the account following exact steps,
  pastes the key). Full auto-signup is a stated non-goal for v1.

## Settled decisions (from interview)

- Win: the long tail, not replacing bespoke clients.
- Setup: shipped catalog + founder-added servers.
- Secrets: pasted keys + approval-gated account creation (paid trials
  OK within a per-server cap).
- Agency: multi-step tool loop (~10 steps, metered).
- Control: per-service trust; sensitive tools always ask first.
- Approval: catalog servers pre-approved; founder-added ask on first use.

## 1. Registry + vault

- New table `mcp_servers`: id, org_id, name, url, transport
  ('streamable'), auth ('none'|'header'|'query'), auth_name,
  cred_ref (vault pointer, never the secret), source
  ('catalog'|'founder'), status ('pending'|'trusted'|'rejected'),
  added_at. Unique (org_id, url).
- New table `mcp_credentials`: id, org_id, server_id, secret_enc
  (same vault key + rotation path as OAuth tokens), label.
- Catalog in shared (`mcp-catalog.ts`): verified entries only — name,
  url, auth type, sensitive tool-name patterns on top of MCP hints
  (spend/subscription/billing/admin/share). No entry ships unverified.
- Founder flow (Setup): paste URL → worker `tools/list` probe →
  show tool count + names → Save as pending. First use opens an
  approval; approve → trusted, reject → rejected (never called).

## 2. Worker MCP client

- New `mcp.ts`: `listTools(env, server)` and `callTool(env, server,
  name, args)` over Streamable HTTP with `Accept:
  application/json, text/event-stream`, session-id handling, one retry
  on transport failure, 30s cap per call, args capped at 32KB.
- Auth: header (`Authorization: Bearer <secret>` or custom name) or
  query param, secret resolved from vault at call time, never logged.
- Failures return typed errors (unreachable, auth, tool, timeout) that
  become honest action proofs — never exceptions past the loop.

## 3. Tool loop in the act phase

- Proposals gain optional `mcpCalls: [{server, tool, args}]` (shared
  protocol + zod; prompts list catalog tools like playbook entries).
- New act branch executes them, then loops: model sees tool results
  and plans the next calls (`runMcpStep`), until done, 10 steps, or
  the idea allowance for unassigned runs. Every call is recorded as an
  `mcp.tool` action with proof (server, tool, summary of result).
- Budgets: step cap 10, args 32KB, words metered to the run like any
  Spark call. Loop state stays in the workflow step (no new tables).

## 4. Sensitive-tool gate

- A tool is sensitive when the server says so (MCP `destructiveHint`
  or `openWorldHint`), the catalog tags it, or the name matches
  spend/subscription/billing/admin/share/delete patterns. Unlisted
  founder tools with no hints default sensitive — unknown means ask.
- Sensitive calls pause for approval (approvals inbox, kind `post`,
  action `mcp.tool`, plus `mcp_server_id`/`mcp_tool`/`mcp_args`
  columns). v1 executes the single gated call on approve and does NOT
  auto-resume the loop — the hire's next session sees the result.
  Non-sensitive calls on trusted servers run free.
- Signup proposals are a `proposals_out` kind (`signup`) with
  service/tier/cost; approve → guided-connect task for the founder
  (or API signup where supported), never an autonomous web signup.

## 5. UI + API

- Setup: MCP server list (name, url, tool count, status) + add form +
  per-server spend cap input (`mcp_spend_cap_cents`, default 0 = paid
  asks; founder raises the cap to allow paid trials).
- Approvals: founder-server first-use approvals + sensitive-tool
  approvals render with server/tool/args in plain words.
- Session detail: `mcp.tool` actions show proof like any result.
- API: CRUD `/api/orgs/:org/mcp` (OWNERS), probe on add, credentials
  write-only (never read back).
- Per-server spend cap (`mcp_spend_cap_cents`, default 0 = paid asks):
  paid trials may proceed only within the cap, else they ask.

## Build order + non-goals

Client + registry → catalog (verified) → loop → gate → UI → signup
flow → live-prove against a real server, else a staged mock.

Non-goals: local/stdio servers, autonomous web-form signup, replacing
bespoke clients, per-tool allowlists (service + sensitive tags win).

## v1 bounds (shipped)

- No loop auto-resume after a gated approval (see §4).
- `mcp.tool` has no undo entry: revert skips it with an audit row
  (`revert.skipped`) — reads leave no footprint, and arbitrary remote
  writes have no generic inverse. Sensitive writes asked first.
- Read-only calls auto-pass review-after; write calls get a human
  review row like any un-undoable result.
