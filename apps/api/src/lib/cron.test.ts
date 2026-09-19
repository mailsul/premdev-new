import assert from "node:assert/strict";
import test from "node:test";
import { nextCronRun, parseCron, validateCron } from "./cron.js";

test("parses five-field cron expressions and rejects malformed fields", () => {
  const parsed = parseCron("*/15 9-17 * * 1-5");
  assert.equal(parsed.fields[0].has(30), true);
  assert.equal(parsed.fields[1].has(9), true);
  assert.equal(parsed.fields[1].has(18), false);
  assert.equal(parseCron("0 0 * * 7").fields[4].has(0), true);
  assert.throws(() => parseCron("0 0 * *"), /exactly 5 fields/);
  assert.throws(() => parseCron("0 25 * * *"), /between 0 and 23/);
});

test("computes the next run in the requested timezone", () => {
  const after = Date.parse("2026-01-01T08:59:00.000Z");
  const next = nextCronRun("0 16 * * *", "Asia/Jakarta", after);
  assert.equal(new Date(next).toISOString(), "2026-01-01T09:00:00.000Z");
});

test("returns a clear validation error for invalid timezone or schedule", () => {
  assert.match(validateCron("0 * * * *", "Not/AZone") ?? "", /Unknown timezone/);
  assert.match(validateCron("0 99 * * *", "UTC") ?? "", /between 0 and 23/);
  assert.equal(validateCron("0 * * * *", "UTC"), null);
});