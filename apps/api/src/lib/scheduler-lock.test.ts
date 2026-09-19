import assert from "node:assert/strict";
import test from "node:test";
import { schedulerLockAvailable } from "./scheduler-lock.js";

test("a fresh scheduler lock blocks a second execution", () => {
  const now = 1_000_000;
  const staleMs = 10_000;
  assert.equal(schedulerLockAvailable(null, null, now, staleMs), true);
  assert.equal(schedulerLockAvailable("active", now - staleMs + 1, now, staleMs), false);
  assert.equal(schedulerLockAvailable("active", now - staleMs - 1, now, staleMs), true);
});