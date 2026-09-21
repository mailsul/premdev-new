---
name: Browser reload boot behavior
description: Reload latency was caused by boot-time auth/API retries, not by workspace tool navigation.
---

The workspace tools were responsive after opening; the reported lag was specific to a full browser reload. Treat reload boot as a separate path: render safe cached workspace state immediately, avoid retrying network timeouts, and keep critical auth/workspace requests short.

**Why:** The user confirmed all tools open normally and identified the delay as occurring only during reload.

**How to apply:** When diagnosing reload latency, inspect auth bootstrap and initial React Query requests before changing tool panels or editor navigation. A transport timeout or server error from `/auth/me` must preserve a cached user; only an explicit `401` should clear the session.