---
name: Git push authentication
description: Workspace-specific GitHub push authentication behavior.
---

When a GitHub push fails with invalid credentials even though the workspace GitHub CLI session is authenticated, configure Git to use the CLI credential helper before retrying the push.

**Why:** The configured HTTPS remote may contain stale or invalid credentials, while the authenticated CLI session remains valid.

**How to apply:** Prefer the workspace's existing GitHub CLI authentication for pushes; never print or persist access tokens in project files, memory, or remote URLs.