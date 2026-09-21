---
name: Custom-domain redeploy invariant
description: The Caddy bind-mounted configuration path must remain a regular generated file across VPS redeploys.
---

The deployment must regenerate the Caddyfile before Compose starts and quarantine any accidental directory at that path. Custom-domain snippets remain separate persisted assets and are reconciled from the database by the API.

**Why:** Docker refuses to start Caddy when a directory is mounted onto `/etc/caddy/Caddyfile`, which takes every domain offline before Caddy can report a configuration or certificate error.

**How to apply:** Keep the root and VPS redeploy paths aligned: preserve `data/caddy/extra`, regenerate `data/caddy/Caddyfile`, then validate/reload Caddy whenever app routing changes, before treating the deployment as healthy. A soft app-only deploy is not sufficient for new host routes.