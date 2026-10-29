# MuseAITeam

Zero-config AI employees for tech businesses. Connect the org, state a goal
(e.g. "lift onboarding activation 15%"), approve the auto-hired lineup, and
watch senior roles debate, vote, and ship — a manager breaks ties.

Built for the Meta Global AI Developer Hackathon (Startup track, solo).

## Stack

- Hono API Worker + Vite SPA, all on Cloudflare
- One Cloudflare Workflow per goal run (propose → vote → rule → act)
- D1 (normalized tables), Vectorize + Workers AI (org memory), R2 (artifacts)
- Durable Object WebSocket broadcast for the live debate feed
- Spark models via Meta Model API through Cloudflare AI Gateway
- Auth.js + GitHub login, sessions in D1

Full decision record: [docs/decisions.md](docs/decisions.md).

## Layout

- `apps/api` — Hono worker, run Workflow, feed Durable Object, Spark client
- `apps/web` — dashboard SPA (debate + ruling feed hero)
- `packages/shared` — protocol schemas (proposals, votes, rulings, actions)
- `db/schema.sql` — D1 schema, applies to local + remote
- `docs/` — decisions, 10-day plan, demo script

## Quickstart

```sh
npm install
npx wrangler d1 create museaiteam        # paste id into apps/api/wrangler.toml
npm run db:apply:local
npx wrangler vectorize create org-memory --dimensions=768 --metric=cosine
npx wrangler r2 bucket create museaiteam-artifacts
```

Secrets (never commit; use `.dev.vars` locally, `wrangler secret put` remote):

- `AUTH_SECRET`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (user login)
- `RESEND_API_KEY` (magic links; `MAIL_FROM` var, test domain until DNS lands)
- `TOKEN_ENC_KEY` (encrypts per-org integration tokens in D1)
- `META_MODEL_API_KEY` (direct Meta Model API calls, no gateway)
- `GITHUB_CLIENT_ID/SECRET`, `LINEAR_CLIENT_ID/SECRET`, `SLACK_CLIENT_ID/SECRET`

```sh
npm run dev:api   # wrangler dev, API + Workflow + DO
npm run dev:web   # Vite dashboard
```

## Docs

- [10-day plan](docs/plan-10-day.md) — 3-4-3 split, day-by-day, cut list
- [Demo script](docs/demo-script.md) — 3-minute forward arc + backup plan

## Status

Scaffold stage: repo layout, configs, schema, skeletons, docs. No provider
OAuth flows or role prompts implemented yet — see the plan for build order.
