# Runbook: hire inbox DNS (one-time)

Hire inboxes live at `hires.museaiteam.com`. Until DNS points there,
the worker code is live but no mail arrives (outbound also needs the
Resend verification).

1. In Cloudflare DNS for `museaiteam.com`, add MX records for the
   `hires` subdomain pointing at Cloudflare Email Routing
   (dashboard: Email → Email Routing → enable for the zone, add
   `hires` as a custom address destination to worker
   `museaiteam-api`).
2. In Resend, add + verify `hires.museaiteam.com` (DKIM/SPF records
   from the Resend dashboard) so hires can send as themselves.
3. Verify: send any email to a seat address (visible in Setup →
   Team step) and check `seat_mail` for the row + the `mail.received`
   notification.

No code deploy needed after DNS — the `email()` handler is already
live on the worker.
