# Morning handoff — wire credentials, prove vendors, record

Overnight (§§4–8) is code-complete, tested (63/63), typechecked, and
deployed. Everything below needs your accounts/keys; nothing needs code.

API base for all redirect URIs and webhooks:

- `https://museaiteam-api.juarezjaramillo.workers.dev`

## 1. Credential files + secrets (15 min)

Save each pair as two lines (client ID, client secret) in
`~/.config/museaiteam/`, mode 600:

- `shopify-oauth`, `hubspot-oauth`, `notion-oauth`
- `stripe-test` (secret key line 1, webhook secret line 2)

Then, from `~/Projects/museaiteam/apps/api` (token env as usual):

```sh
for p in SHOPIFY HUBSPOT NOTION; do
  f=~/.config/museaiteam/$(echo $p | tr 'A-Z' 'a-z')-oauth
  printf '%s' "$(sed -n '1p' $f)" | npx wrangler secret put ${p}_CLIENT_ID
  printf '%s' "$(sed -n '2p' $f)" | npx wrangler secret put ${p}_CLIENT_SECRET
done
printf '%s' "$(sed -n '1p' ~/.config/museaiteam/stripe-test)" | npx wrangler secret put STRIPE_SECRET_KEY
printf '%s' "$(sed -n '2p' ~/.config/museaiteam/stripe-test)" | npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Secrets take effect immediately — no deploy needed. Until they exist,
connect buttons fail closed (503) and checkout shows "unlocks once
Stripe keys are set".

## 2. OAuth apps (30–45 min)

Redirect URI pattern (one per provider):

- `https://museaiteam-api.juarezjaramillo.workers.dev/api/auth/shopify/callback`
- `.../api/auth/hubspot/callback`
- `.../api/auth/notion/callback`

**Shopify** (dev store): create the app in the Shopify Developer
Dashboard, set the redirect URI, request scope `write_discounts`,
install it on your dev store, copy the API key + secret. Connect from
our dashboard asks for the store domain first
(`your-store.myshopify.com`).

**HubSpot** (dev account → public app): Auth tab gets the redirect URI
plus exactly these scopes: `crm.objects.tickets.read`,
`crm.objects.tickets.write`, `crm.objects.notes.write`. Install on
your portal. Park ≥1 ticket in the portal first — the triage note
pins to the newest ticket.

**Notion** (public integration at notion.so/my-integrations):
redirect URI, capabilities Read + Insert + Update content. After
connecting, open any workspace page, copy its 32-char page ID from
the URL, paste it in our Setup → "Notion parent page ID" → Save.
Share that page with the integration or page creation 403s.

## 3. Vendor proof (20 min, counts as rehearsal)

Per vendor: Connect on the dashboard → Start team (5 s window) →
artifact lands → Revert all → artifact gone.

- Shopify: discount code `AITEAM-XXXXXXXX` in Discounts; revert deletes it
- HubSpot: triage note on the newest ticket; revert deletes the note
- Notion: decision page under your parent; revert archives it

Then run the full 3-minute arc from `docs/demo-script.md` once and
record it — that recording is the backup video.

## 4. Stripe proof (10 min)

Test mode. API keys → secret key; Developers → Webhooks → add
endpoint `https://museaiteam-api.juarezjaramillo.workers.dev/api/stripe/webhook`
with events `checkout.session.completed` +
`customer.subscription.deleted` → signing secret. Set both secrets
(§1), open Pricing → Subscribe → pay with `4242 4242 4242 4242` →
billing flips to active. Cancel the subscription in Stripe to watch
it flip back.

## 5. Resend domain (whenever DNS allows)

Add the domain in Resend, set the SPF/DKIM/DMARC records it shows,
then tell me the sender address — I flip `MAIL_FROM` and redeploy
(1 min). Until then digests send from the test sender to your inbox
only (already proven: two probe digests landed overnight).

## 6. Local dev catch-up (2 min, your terminal only)

My sandbox blocks loopback, so remote has migrations 0005–0013 and
local does not. Run once:

```sh
cd ~/Projects/museaiteam/apps/api
for m in 0005_provider_config 0006_digest_sent 0007_teams_seats 0008_billing 0009_goals 0010_approvals 0011_learning 0012_invites 0013_sandbox; do
  npx wrangler d1 execute museaiteam --local --file=../../db/migrations/$m.sql
done
```

## 7. Known gaps (not demo-blockers)

- Token refresh isn't built: HubSpot tokens live ~30 min, Linear's
  expire too — connect, then run within minutes for the demo.
- Shopify token shape is changing upstream (expiring + refresh
  tokens); we capture `refresh_token`/`expires_in` when present but
  don't rotate yet. If the morning connect shows odd expiry, say so.
- Fair-use throttle (1 run/day over 25M×seats) is unit-tested, not
  live-fired — nobody can burn 25M tokens before judging.
- Your org is pristine: classic 4-seat Team 1, zero runs, trial at
  14 days. Two digest emails from overnight probes are in your inbox;
  everything else was deleted after proving.
