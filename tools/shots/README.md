# shots

Screenshot harness for UX review: serves `apps/web/dist`, mocks the API
with fixtures, drives system Chrome via puppeteer-core.

```bash
npm install          # once (repo root wires the workspace)
node shoot.mjs hires # writes /tmp/shots/hires.png
```

Fixtures are mock data for layout judgment, not real state. Extend `FIX`
and the interaction script per tab as the UI grows.
