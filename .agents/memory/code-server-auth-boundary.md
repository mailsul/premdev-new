---
name: Code Server authentication boundary
description: Authentication behavior for private Code Server and preview URLs.
---

Private Code Server and Code Preview paths must authenticate with the PremDev session before checking the workspace session or container state. Unauthenticated browser requests redirect to the configured PremDev app login and may return to the original private path; authenticated non-owners receive 403. An authenticated owner opening a Code Server URL may lazy-start its workspace-scoped Code Server container even when the primary workspace runtime is stopped, and startup must wait for the HTTP port rather than trusting Docker's Running state. Code Server 4.96.4 does not accept `--base-path` and serves UI assets from root paths, so each workspace Code Server uses a dedicated `code-<workspaceId>.<PRIMARY_DOMAIN>` host. The reserved `code` host remains the workspace picker.

**Why:** Checking workspace state first exposed a misleading “Workspace Not Running” page to logged-out users instead of the normal PremDev login flow.

**How to apply:** Keep the auth gate ahead of private-path routing for both HTTP requests and WebSocket upgrades. Use the configured app/deploy domain for the login URL and only accept same-origin relative return paths. Serialize lazy-start requests per workspace so parallel browser asset/WebSocket requests do not create duplicate containers.