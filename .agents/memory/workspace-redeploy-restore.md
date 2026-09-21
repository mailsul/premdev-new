---
name: Workspace redeploy restore
description: Ordering constraint between redeploy cleanup and persisted workspace auto-restore.
---

Redeploy scripts must remove stale workspace and secondary IDE containers before restarting the API. The API restores persisted active sessions during boot.

**Why:** Cleaning containers after the API starts can delete containers that the boot reconciler has just recreated, leaving active workspaces and Code Server sessions unavailable.

**How to apply:** Keep container cleanup before app restart in full redeploy flows; preserve desired-running/session state in SQLite so the subsequent API boot restores only sessions that were active before redeploy.