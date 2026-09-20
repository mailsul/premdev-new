---
name: Browser verification boundary
description: Rules for proving workspace web apps work without confusing HTTP checks with browser behavior.
---

The agent must treat HTTP preview checks as transport-only evidence. Claims about buttons, navigation, or client-side JavaScript require a browser check executed inside the target workspace runtime, with the result and console/page-error evidence available to the agent.

**Why:** A successful curl/HTTP 200 can coexist with null-element and undefined-handler errors that make the visible UI unusable.

**How to apply:** Keep browser automation workspace-scoped and declarative; fail on HTTP failures, console errors, page errors, or failed interaction expectations. Prefer the workspace's public preview URL for browser navigation; localhost is only a low-level diagnostic fallback. Report warnings separately instead of treating every browser warning as an application failure.