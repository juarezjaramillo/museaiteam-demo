# MuseAITeam

AI employees for small businesses and solo founders. Give the team a goal, even as a voice note. The hires debate, vote, do the work in your real tools (Shopify, HubSpot, Slack, Notion, Linear, GitHub), and prove it's done.

Built for the Meta Global AI Developer Hackathon (Startup track, solo).

## Built during the hackathon

All code in this repository was written during the Meta Global AI Developer Hackathon by Muse Code, Meta's coding agent. No code from before the event is used.

- Oct 26, 2026, 2:37 PM ET: Muse Code's first code edit, after the kickoff stream began (12:00 PM ET).
- Oct 27: this repository was created (`229a312`, "initial commit").
- Oct 29: commit `d4bccb6` ("product source") adds Muse Code's work from Oct 26 to Oct 29 in one commit. Every commit after it is the day-by-day history.
- In total, Muse Code made more than 2,400 code edits in 3 sessions. The session logs, with a timestamp on every edit, are available to the judges on request.

What was built, all during the event:

- Voice goals: Muse Voice Transcribe streams the owner's voice note live, in English or Spanish; Muse Spark turns it into a goal with a number to move.
- The team: a manager and four hires (marketer, analyst, PM, engineer) propose, push back and vote, and the manager rules. One Cloudflare Workflow per run; the debate streams live through a Durable Object.
- Real work in real tools: Shopify, HubSpot, Slack, Notion, Linear and GitHub, each through the login of the hire who owns it.
- Campaign images with Muse Image, made from the store's real product photos.
- Checks with Muse Spark vision: every image and product description is read back and boxed before it ships; wrong ones are fixed with Muse Image edits.
- Live store proof: Cloudflare Browser Rendering opens the storefront, applies the code at checkout, and Muse Spark vision checks the screenshots.
- One cloud computer per hire (Cloudflare Containers with Chromium), asleep when idle, with cost tracked per hire.
- Slack: mention the team and the manager answers from team memory (Vectorize).
- Safety: approvals, a kill switch, and one-click revert of every write.
- Demo data for the fictional store Tres Cumbres Coffee Co. in `demo/coffee-store/`.

## Stack

- Hono API Worker + Vite SPA, all on Cloudflare
- One Cloudflare Workflow per goal run (propose → vote → rule → act)
- D1 (normalized tables), Vectorize + Workers AI (org memory), R2 (artifacts)
- Durable Object WebSocket broadcast for the live debate feed
- Spark models via Meta Model API through Cloudflare AI Gateway
- Auth.js (Google login or email magic link), sessions in D1
- Muse Image (`muse-image-1.0`): the marketer makes campaign images anchored on the store's real product photos.
- Muse Spark vision: every image and product description is read back and checked against the run's real facts (with bounding boxes) before it ships; wrong ones are fixed with Muse Image edits.
- Muse Voice Transcribe (`muse-voice-transcribe-1.0`): owners dictate goals and team briefs, streamed live, in English or Spanish; Muse Spark shapes the words into a draft while the original audio is kept.
- "Cloudflare Browser Rendering + Muse Spark vision: after shipping, the team opens the live store like a customer, applies the new code at checkout, and proves it works with annotated screenshots."

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
