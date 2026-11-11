/**
 * runlock.mjs — one trading runner at a time.
 *
 * The desktop app's scheduler and the CLI runner (trader.mjs, PM2) both take
 * this lock before a trading cycle, so the two can never trade the same
 * signals at the same moment. The lock is a small file in data/ holding the
 * owner's pid. A lock whose owner process is gone, or that is older than
 * STALE_MS, is treated as abandoned.
 */

import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { resolve } from "path";
import { DATA_DIR } from "./paths.mjs";

const LOCK_PATH = resolve(DATA_DIR, "runner.lock");
const STALE_MS  = 15 * 60 * 1000;

function readLock() {
  try { return JSON.parse(readFileSync(LOCK_PATH, "utf8")); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Who holds the lock right now, or null. */
export function lockHolder() {
  const lock = readLock();
  if (!lock) return null;
  if (!pidAlive(lock.pid) || Date.now() - lock.at > STALE_MS) return null;
  return lock;
}

/** Try to take the lock. Returns true on success, false if another runner holds it. */
export function acquireRunLock(owner = "runner") {
  mkdirSync(DATA_DIR, { recursive: true });
  const holder = lockHolder();
  if (holder && holder.pid !== process.pid) return false;
  if (!holder) { try { unlinkSync(LOCK_PATH); } catch {} }   // clear an abandoned lock
  try {
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, owner, at: Date.now() }), { flag: holder ? "w" : "wx" });
    return true;
  } catch {
    return false; // another process created it in between
  }
}

export function releaseRunLock() {
  const lock = readLock();
  if (lock?.pid === process.pid) { try { unlinkSync(LOCK_PATH); } catch {} }
}
