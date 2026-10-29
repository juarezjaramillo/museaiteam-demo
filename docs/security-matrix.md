# Security matrix: every route and its check

Audited 2026-10-29. Layers: `requireSession` middleware on
`/api/runs/*`, `/api/orgs/*`, `/api/me*`, `/api/invites/*` (401 without
a session), then a per-route org/role check. Org always resolves from
the session + URL id via `memberRole` — never from client input alone.

## Session routes (middleware + per-route check)

| Route | Check |
|---|---|
| POST /api/runs | session + DECIDERS in target org (orgId from body must be a member org) |
| GET /api/runs/:id, /detail, /events | session + EVERYONE via run.org_id |
| GET /api/runs/:id/ratings | session + member of run.org_id |
| POST /api/runs/:id/kill, /revert | session + OWNERS via run.org_id |
| POST /api/runs/:id/baseline | session + DECIDERS via run.org_id |
| POST /api/runs/:id/approve | session + approver (approvalDecider) |
| POST .../actions/:aid/approve, /rate | session + approver |
| POST .../actions/:aid/request-changes | session + approver + trial gate |
| GET /api/me, /api/me/orgs | session only (own data) |
| POST /api/invites/:token/accept | session + invite token |
| GET /api/orgs/:org/** reads | session + EVERYONE/OWNERS per row (billing, invites, config: OWNERS) |
| PUT/POST/PATCH writes under /orgs/:org | session + OWNERS or DECIDERS per row (see code) |
| POST /api/orgs/:org/approvals/approve-all | session + approver |

## Unsigned routes (authenticated another way)

| Route | Check |
|---|---|
| GET /api/health | none (static ok) |
| POST /api/sandbox/run, GET /api/sandbox/runs/:id | none; IP throttle 5/day; reads sandbox-kind-only |
| POST /api/slack/events | HMAC signature + 5-min timestamp window |
| POST /api/stripe/webhook | Stripe signature inside handler |
| GET /api/auth/:provider/connect | session + OWNER of ?org (fixed 2026-10-29) |
| GET /api/auth/:provider/callback | signed state + session + OWNER of state org (fixed 2026-10-29) |
| ALL /api/auth/* | Auth.js handler |

## OAuth scopes (least privilege review)

- GitHub `public_repo read:user`: public repos only, cannot touch
  private repos. Keep.
- Linear `read write`: coarsest useful pair; issues need write. Keep.
- Slack: post/read/join/history + `app_mentions:read,im:history,im:write`
  for inbound replies and owner DMs. Reconnect required to grant.
- Shopify `write_discounts,read_orders,read_products,write_products`:
  each feeds a used feature (discounts, metrics, product copy). Keep.
- HubSpot tickets read/write + notes write: triage, notes, theme
  mining. Keep, no contacts scope.
- Notion `owner=user`: page create/archive only. Keep.

## Findings fixed in this review

1. **Connect/callback had no session check**: anyone knowing an org id
   could bind their own provider accounts to it. Now owner-only both
   ends (dashboard connects always start signed-in, so no flow breaks).
2. **CORS allowed any *.pages.dev with credentials**: a stranger's
   Pages site could call the API as the victim. Now allowlisted to
   `*.museaiteam.pages.dev` + APP_URL + localhost.
3. **No key rotation path**: added `TOKEN_ENC_KEY_PREV` dual-read with
   rewrap-on-read (see runbook below).

## Standing notes (not findings)

- `POST /api/runs` takes `orgId` from the body but enforces deciding
  membership in it; omitting it provisions the caller's own org.
- `GET /api/orgs/:org/audit.csv` allows viewers (read-only audit).
- Sandbox rows live in the same tables; every sandbox read filters
  `kind = 'sandbox'` and every sandbox write forces the kind.
- Auth.js session secret (`AUTH_SECRET`) rotation invalidates all
  sessions by design; no dual-read (accept and announce).
- Secrets in errors: `reportError` truncates to 300 chars and never
  includes tokens; Spark prompts are never logged.
