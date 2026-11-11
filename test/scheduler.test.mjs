import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import "./helpers.mjs";

const { DATA_DIR } = await import("../paths.mjs");
const { stockSlotDue, createScheduler } = await import("../scheduler.mjs");
const { acquireRunLock, releaseRunLock, lockHolder } = await import("../runlock.mjs");

const utc = (s) => new Date(s + "Z");

test("stock slot: weekdays, 13:31–20:00 UTC, once per day", () => {
  assert.equal(stockSlotDue(null, utc("2026-11-10T13:30:00")), false, "before open");
  assert.equal(stockSlotDue(null, utc("2026-11-10T13:31:00")), true);
  assert.equal(stockSlotDue("2026-11-09 13:31:05", utc("2026-11-10T15:00:00")), true, "woke late, yesterday's run does not count");
  assert.equal(stockSlotDue("2026-11-10 13:31:05", utc("2026-11-10T15:00:00")), false, "already ran today");
  assert.equal(stockSlotDue(null, utc("2026-11-10T20:00:00")), false, "after close");
  assert.equal(stockSlotDue(null, utc("2026-11-14T14:00:00")), false, "Saturday");
  assert.equal(stockSlotDue(null, utc("2026-11-15T14:00:00")), false, "Sunday");
});

test("run lock: second holder refused, stale and dead locks cleared", () => {
  assert.equal(acquireRunLock("a"), true);
  assert.equal(lockHolder().pid, process.pid);
  assert.equal(acquireRunLock("a"), true, "same process may re-take it");
  releaseRunLock();
  assert.equal(lockHolder(), null);

  mkdirSync(DATA_DIR, { recursive: true });
  const lockPath = resolve(DATA_DIR, "runner.lock");
  // held by another live process (pid 1 always exists)
  writeFileSync(lockPath, JSON.stringify({ pid: 1, owner: "cli", at: Date.now() }));
  assert.equal(acquireRunLock("b"), false);
  assert.equal(lockHolder().owner, "cli");
  // same lock but an hour old → abandoned
  writeFileSync(lockPath, JSON.stringify({ pid: 1, owner: "cli", at: Date.now() - 3600_000 }));
  assert.equal(acquireRunLock("b"), true);
  releaseRunLock();
  // owner process no longer exists
  writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, owner: "cli", at: Date.now() }));
  assert.equal(acquireRunLock("b"), true);
  releaseRunLock();
});

test("scheduler starts paused and remembers being switched on", async () => {
  const a = createScheduler();
  assert.equal(a.status().paused, true);
  assert.deepEqual(await a.poke(), { skipped: "paused" });
  a.setPaused(false);
  assert.equal(createScheduler().status().paused, false);
  a.setPaused(true);
  assert.equal(createScheduler().status().paused, true);
});

test("scheduler skips ticks while offline", async () => {
  let online = false;
  const sch = createScheduler({ isOnline: () => online });
  sch.setPaused(false);
  assert.deepEqual(await sch.poke(), { skipped: "offline" });
  assert.equal(sch.status().offline, true);
  online = true;
  assert.deepEqual(await sch.poke(), { ran: 0 });     // online, nothing due (no strategies)
  assert.equal(sch.status().offline, false);
  sch.setPaused(true);
});
