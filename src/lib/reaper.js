import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, readdirSync, statSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS } from './config.js';
import { listEntries, removeEntry, classify, readEntry } from './registry.js';
import { closeChrome } from './chrome.js';
import { withLock } from './lock.js';
import { ensurePrivateDir, isPidAlive, sleep } from './fs-utils.js';

// Browsers outlive their fleet process on purpose (re-adoption). Something has
// to close the ones nobody comes back for. That's the reaper: one small
// detached process per machine, started by whichever fleet process needs it,
// exiting on its own once the registry has been empty for a while.

const REAPER_MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'reaper-main.js');
const STRAY_PROFILE_MS = 60 * 60_000;

/** Close a deregistered browser and delete its profile. */
export async function closeEntryBrowser(entry) {
  if (entry.chromePid && isPidAlive(entry.chromePid)) await closeChrome(entry).catch(() => {});
  if (entry.profileDir) rmSync(entry.profileDir, { recursive: true, force: true });
}

/** Cheap, synchronous cleanup of entries whose Chrome is already gone. Safe under the registry lock. */
export function pruneRegistry() {
  for (const entry of listEntries()) {
    const status = classify(entry);
    if (status === 'starting') continue;
    if (!entry.chromePid || !isPidAlive(entry.chromePid)) {
      removeEntry(entry.id);
      if (entry.profileDir) rmSync(entry.profileDir, { recursive: true, force: true });
    }
  }
}

/**
 * One pass: close orphans, close detached browsers idle past the timeout,
 * forget dead ones, delete stray profile dirs.
 * @returns {Array<{ id: string, action: string }>}
 */
export async function reapOnce({ orphanTimeoutMinutes, now = Date.now(), closeDetached = false } = {}) {
  const actions = [];
  const reasonFor = (entry) => {
    const status = classify(entry);
    if (status === 'starting' || status === 'active') return null;
    if (!entry.chromePid || !isPidAlive(entry.chromePid)) return 'chrome already exited';
    if (!entry.port) return 'launch never finished';
    if (status === 'orphan') return 'owning session ended';
    if (closeDetached) return 'detached (forced)';
    if (now - entry.lastSeen > orphanTimeoutMinutes * 60_000) return `detached for over ${orphanTimeoutMinutes} min`;
    return null;
  };
  for (const candidate of listEntries()) {
    if (!reasonFor(candidate)) continue;
    // Decide and deregister under the lock, against the entry as it is now: a
    // session may have re-adopted it since the list was read. Once the entry is
    // gone nobody can adopt it, so closing Chrome can happen outside the lock.
    const claimed = await withLock('registry', async () => {
      const entry = readEntry(candidate.id);
      const reason = entry && reasonFor(entry);
      if (!reason) return null;
      removeEntry(entry.id);
      return { entry, reason };
    });
    if (!claimed) continue;
    await closeEntryBrowser(claimed.entry);
    actions.push({ id: claimed.entry.id, action: claimed.reason });
  }
  // Chromes and profile dirs with no registry entry: leftovers from a fleet
  // process that died between spawning Chrome and recording it.
  const known = new Set(listEntries().map((e) => e.id));
  for (const { pid, id } of strayChromes(known)) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
    actions.push({ id, action: `killed unregistered chrome ${pid}` });
  }
  let dirs = [];
  try {
    dirs = readdirSync(PATHS.profiles);
  } catch {
    // none yet
  }
  for (const id of dirs) {
    if (known.has(id)) continue;
    const dir = join(PATHS.profiles, id);
    try {
      if (now - statSync(dir).mtimeMs > STRAY_PROFILE_MS) {
        rmSync(dir, { recursive: true, force: true });
        actions.push({ id, action: 'removed stray profile dir' });
      }
    } catch {
      // raced with someone else
    }
  }
  return actions;
}

/** Chrome main processes on a fleet profile dir that the registry doesn't know. */
function strayChromes(known) {
  if (process.platform === 'win32') return [];
  let out;
  try {
    out = execFileSync('ps', ['-ax', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return [];
  }
  const marker = `--user-data-dir=${PATHS.profiles}/`;
  const found = [];
  for (const line of out.split('\n')) {
    const at = line.indexOf(marker);
    // Helpers (--type=renderer etc.) die with the main process; only target the main one.
    if (at === -1 || line.includes('--type=')) continue;
    const id = line.slice(at + marker.length).split(/[\s/]/)[0];
    const pid = Number(line.trim().split(/\s+/)[0]);
    // Re-check the registry: the entry is always written before Chrome is spawned.
    if (id && pid && !known.has(id) && !readEntry(id)) found.push({ pid, id });
  }
  return found;
}

function reaperRunning() {
  try {
    const pid = Number(readFileSync(PATHS.reaperPid, 'utf8'));
    if (!isPidAlive(pid)) return false;
    if (process.platform === 'win32') return true;
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    return args.includes('reaper-main.js');
  } catch {
    return false;
  }
}

/** Start the reaper if it isn't running. Never throws: a missing reaper only delays cleanup. */
export function ensureReaper() {
  try {
    if (reaperRunning()) return;
    ensurePrivateDir(PATHS.home);
    const log = openSync(PATHS.reaperLog, 'a', 0o600);
    const child = spawn(process.execPath, [REAPER_MAIN], { detached: true, stdio: ['ignore', log, log], env: process.env });
    child.unref();
  } catch (err) {
    console.error(`[devtools-fleet] could not start the reaper: ${err.message}`);
  }
}

function ownsPidFile() {
  try {
    return Number(readFileSync(PATHS.reaperPid, 'utf8')) === process.pid;
  } catch {
    return false;
  }
}

/** Body of the reaper process. */
export async function runReaper({ loadConfig, intervalMs = 10_000, idleExitMs = 2 * 60_000 }) {
  if (reaperRunning()) return;
  writeFileSync(PATHS.reaperPid, String(process.pid), { mode: 0o600 });
  // Two fleet processes can start a reaper at the same moment; last writer wins, the other leaves.
  await sleep(300);
  if (!ownsPidFile()) return;
  let emptySince = null;
  try {
    for (;;) {
      // Another reaper took over, or the fleet home was deleted: step aside.
      if (!ownsPidFile()) return;
      const config = loadConfig();
      const actions = await reapOnce({ orphanTimeoutMinutes: config.orphanTimeoutMinutes });
      for (const { id, action } of actions) console.log(`${new Date().toISOString()} ${id} ${action}`);
      if (listEntries().length === 0) {
        emptySince ??= Date.now();
        if (Date.now() - emptySince > idleExitMs) break;
      } else {
        emptySince = null;
      }
      await sleep(intervalMs);
    }
  } finally {
    if (ownsPidFile()) rmSync(PATHS.reaperPid, { force: true });
  }
}
