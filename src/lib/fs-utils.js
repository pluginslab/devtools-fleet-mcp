import { mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Create a directory readable only by the current user. */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask and ignored for existing dirs.
  chmodSync(dir, 0o700);
}

/** Write JSON atomically (temp file + rename), mode 0600. */
export function writeJsonAtomic(file, data) {
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but owned by someone else. Still alive.
    return err.code === 'EPERM';
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
