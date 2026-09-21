---
name: Code Server authentication boundary
description: Authentication behavior for private Code Server and preview URLs.
---

Private Code Server and Code Preview paths must authenticate with the PremDev session before checking the workspace session or container state. Unauthenticated browser requests redirect to the configured PremDev app login and may return to the original private path; authenticated non-owners receive 403.

**Why:** Checking workspace state first exposed a misleading “Workspace Not Running” page to logged-out users instead of the normal PremDev login flow.

**How to apply:** Keep the auth gate ahead of private-path routing for both HTTP requests and WebSocket upgrades. Use the configured app/deploy domain for the login URL and only accept same-origin relative return paths.