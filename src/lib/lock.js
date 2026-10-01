import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './config.js';
import { ensurePrivateDir, isPidAlive, sleep } from './fs-utils.js';

const STALE_MS = 30_000;

/**
 * Run fn while holding a cross-process lock. mkdir is atomic on every
 * filesystem we care about, so the lock is a directory. A lock whose holder
 * died, or that is older than STALE_MS, is taken over.
 */
export async function withLock(name, fn, { timeoutMs = 20_000 } = {}) {
  ensurePrivateDir(PATHS.locks);
  const dir = join(PATHS.locks, `${name}.lock`);
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'owner'), String(process.pid));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (isStale(dir)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock "${name}" (${dir})`, { cause: err });
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 200);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isStale(dir) {
  try {
    const owner = Number(readFileSync(join(dir, 'owner'), 'utf8'));
    if (owner && !isPidAlive(owner)) return true;
    return Date.now() - statSync(dir).mtimeMs > STALE_MS;
  } catch {
    // Owner file not written yet: the holder is mid-acquire. Only stale if old.
    try {
      return Date.now() - statSync(dir).mtimeMs > STALE_MS;
    } catch {
      return false;
    }
  }
}
