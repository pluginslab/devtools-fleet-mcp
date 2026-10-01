import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PATHS } from './config.js';
import { writeJsonAtomic, isPidAlive } from './fs-utils.js';
import { anchorAlive } from './process-tree.js';

// One JSON file per browser in ~/.devtools-fleet/browsers/. Writes are atomic
// renames; anything that must be consistent across processes (the cap check,
// adoption) happens under withLock('registry').
//
// Entry shape:
// {
//   id, kind: 'agent' | 'login',
//   chromePid, port, wsPath, profileDir, headless, viewport, channel,
//   fleetPid,          // the devtools-fleet process driving it (0 when detached)
//   anchorPid,         // the AI client session that owns it (see process-tree.js)
//   anchorStart,       // its start time, so a recycled pid doesn't count
//   anchorLabel,
//   cwd, state, allowedOrigins, strict,
//   createdAt, lastSeen, // ms epoch; lastSeen is the fleet heartbeat
// }

export function newBrowserId() {
  return randomBytes(4).toString('hex');
}

export function entryPath(id) {
  return join(PATHS.browsers, `${id}.json`);
}

export function writeEntry(entry) {
  writeJsonAtomic(entryPath(entry.id), entry);
}

export function readEntry(id) {
  try {
    return JSON.parse(readFileSync(entryPath(id), 'utf8'));
  } catch {
    return null;
  }
}

export function updateEntry(id, patch) {
  const entry = readEntry(id);
  if (!entry) return null;
  const next = { ...entry, ...patch };
  writeEntry(next);
  return next;
}

export function removeEntry(id) {
  rmSync(entryPath(id), { force: true });
}

export function listEntries() {
  let files;
  try {
    files = readdirSync(PATHS.browsers);
  } catch {
    return [];
  }
  const entries = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      entries.push(JSON.parse(readFileSync(join(PATHS.browsers, file), 'utf8')));
    } catch {
      // Half-written or corrupt; ignore. Temp files don't end in .json.
    }
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Where a browser stands, from the registry's point of view:
 *   active   – its fleet process is alive
 *   detached – fleet process gone, owning session alive (can be re-adopted)
 *   orphan   – fleet process and owning session both gone
 *   starting – still launching
 * Whether Chrome itself is alive is checked separately (chrome.js isChromeAlive).
 */
export function classify(entry) {
  if (entry.fleetPid && isPidAlive(entry.fleetPid)) return entry.port ? 'active' : 'starting';
  // anchorPid 0 = DEVTOOLS_FLEET_SESSION label: no process to watch, so it
  // stays detached until the orphan timeout.
  if (anchorAlive(entry)) return 'detached';
  return 'orphan';
}
