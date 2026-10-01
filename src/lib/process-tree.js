import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { isPidAlive } from './fs-utils.js';

// Which AI client session owns this fleet process?
//
// MCP clients start servers through wrappers (npx → npm exec → node, sometimes
// a shell), and restart the whole chain on reconnect. The session itself (the
// `claude` process, Cursor's extension host, ...) survives the reconnect. So
// the anchor is the nearest ancestor that isn't a wrapper. A reconnect inside
// the same session finds the same anchor and re-adopts its browser; a second
// session in the same directory finds a different one and never shares.
//
// The anchor's start time is stored with its pid, so a recycled pid is never
// mistaken for the session.
//
// DEVTOOLS_FLEET_SESSION overrides the lookup (a stable label of your choice).
// On Windows there is no ps; the anchor falls back to this process, which
// means no re-adoption but everything else works.

const SHELLS_AND_LAUNCHERS = new Set([
  'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bunx', 'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'env', 'uv', 'uvx',
  'devtools-fleet-mcp',
]);
// A runtime (node, bun, deno) is only a wrapper when it's running a launcher
// or this package. A client written in Node (`node .../claude/cli.js`, an
// Agent SDK orchestrator) is a session, not a wrapper.
const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno']);
const LAUNCHER_ARGS = /\b(npx|npm|pnpm|pnpx|yarn|bunx|npx-cli|npm-cli)\b|devtools-fleet|\/_npx\//;

export function isWrapper(comm, args = '') {
  const exe = basename(comm).replace(/^-/, '').toLowerCase();
  const first = basename(args.trim().split(/\s+/)[0] || '').replace(/^-/, '').toLowerCase();
  if (SHELLS_AND_LAUNCHERS.has(exe) || SHELLS_AND_LAUNCHERS.has(first)) return true;
  // npm rewrites its process title ("npm exec foo").
  if (/^npm (exec|run|x)\b/.test(args)) return true;
  if (RUNTIMES.has(exe) || RUNTIMES.has(first)) return LAUNCHER_ARGS.test(args);
  return false;
}

function ps(pid, field) {
  return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
}

export function readProcess(pid) {
  try {
    // One field per call: with several, ps prints a header unless every field has "=".
    const ppid = Number(ps(pid, 'ppid'));
    const comm = linuxExe(pid) || ps(pid, 'comm');
    if (!Number.isInteger(ppid) || !comm) return null;
    return { ppid, comm, args: ps(pid, 'args') };
  } catch {
    return null;
  }
}

// On Linux, ps's comm is the main thread's name, and Node 24 renames its main
// thread to "MainThread". The executable is the reliable name there.
function linuxExe(pid) {
  if (process.platform !== 'linux') return null;
  try {
    return basename(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''));
  } catch {
    return null;
  }
}

/** Process start time as ps reports it; stable for the life of the process. */
export function processStartTime(pid) {
  if (process.platform === 'win32' || !pid) return null;
  try {
    return ps(pid, 'lstart') || null;
  } catch {
    return null;
  }
}

/** @returns {{ pid: number, start: string|null, label: string }} */
export function findSessionAnchor({ readProc = readProcess, startTime = processStartTime, startPid = process.ppid } = {}) {
  const override = process.env.DEVTOOLS_FLEET_SESSION;
  if (override) return { pid: 0, start: null, label: `session:${override}` };
  if (process.platform === 'win32') return { pid: process.pid, start: null, label: 'self' };

  let pid = startPid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const proc = readProc(pid);
    if (!proc) break;
    if (!isWrapper(proc.comm, proc.args)) return { pid, start: startTime(pid), label: basename(proc.comm) };
    pid = proc.ppid;
  }
  // Only wrappers all the way up (or ps failed): treat our parent as the anchor.
  return { pid: startPid, start: startTime(startPid), label: 'parent' };
}

/** Is the session a registry entry belongs to still running? */
export function anchorAlive(entry) {
  if (entry.anchorPid === 0) return true; // label-based: no process to watch
  if (!isPidAlive(entry.anchorPid)) return false;
  if (!entry.anchorStart) return true;
  const now = processStartTime(entry.anchorPid);
  return now === null || now === entry.anchorStart;
}

/** Does a registry entry belong to this session? */
export function anchorMatches(entry, anchor) {
  if (anchor.pid === 0) return entry.anchorPid === 0 && entry.anchorLabel === anchor.label;
  return entry.anchorPid === anchor.pid && (entry.anchorStart ?? null) === (anchor.start ?? null) && anchorAlive(entry);
}
