import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PATHS } from './config.js';
import { ensurePrivateDir, writeJsonAtomic } from './fs-utils.js';
import { normalizeOriginPatterns, cookieMatchesAllowlist, checkUrl } from './origins.js';

// A state is a saved login: cookies + localStorage in Playwright's
// storageState shape, plus fleet metadata. Playwright can load a fleet state
// file as-is (it ignores the extra keys).
//
// {
//   cookies: [...], origins: [{ origin, localStorage: [{ name, value }] }],
//   devtoolsFleet: { version: 1, name, allowedOrigins, strict, createdBy: 'cli' | 'agent', savedAt }
// }

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function assertStateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Invalid state name "${name}": letters, digits, dot, dash, underscore; max 64; must start with a letter or digit`);
  }
}

export function statePath(name) {
  assertStateName(name);
  return join(PATHS.states, `${name}.json`);
}

/** States hold live session tokens. Never write them where git could pick them up. */
function assertNotInGitRepo(dir) {
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    if (inside === 'true') {
      throw new Error(`Refusing to store login states inside a git work tree (${dir}). Point DEVTOOLS_FLEET_HOME somewhere outside any repository.`);
    }
  } catch (err) {
    if (err.message.startsWith('Refusing')) throw err;
    // git missing or not a repo: fine
  }
}

export function stateExists(name) {
  return existsSync(statePath(name));
}

export function readState(name) {
  const file = statePath(name);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No state named "${name}". List them with state_list or \`devtools-fleet states\`.`, { cause: err });
    throw new Error(`State "${name}" is unreadable: ${err.message}`, { cause: err });
  }
  if (!data.devtoolsFleet?.allowedOrigins?.length) {
    throw new Error(`State "${name}" has no allowedOrigins. Re-save it with \`devtools-fleet login\` or \`devtools-fleet state import --allow ...\`.`);
  }
  return data;
}

export function writeState({ name, cookies, origins, allowedOrigins, strict = false, createdBy }) {
  assertStateName(name);
  const allow = normalizeOriginPatterns(allowedOrigins);
  if (!allow.length) throw new Error('A state needs at least one allowed origin');
  ensurePrivateDir(PATHS.states);
  assertNotInGitRepo(PATHS.states);
  const data = {
    cookies,
    origins,
    devtoolsFleet: { version: 1, name, allowedOrigins: allow, strict: Boolean(strict), createdBy, savedAt: new Date().toISOString() },
  };
  writeJsonAtomic(statePath(name), data);
  return summarizeState(data);
}

export function deleteState(name) {
  const file = statePath(name);
  if (!existsSync(file)) throw new Error(`No state named "${name}"`);
  rmSync(file);
}

/** Metadata only. Never cookie or storage values. */
export function summarizeState(data) {
  const meta = data.devtoolsFleet;
  const now = Date.now() / 1000;
  const expiring = data.cookies.filter((c) => c.expires > 0);
  const soonest = expiring.length ? Math.min(...expiring.map((c) => c.expires)) : null;
  return {
    name: meta.name,
    allowedOrigins: meta.allowedOrigins,
    strict: meta.strict,
    createdBy: meta.createdBy,
    savedAt: meta.savedAt,
    cookies: data.cookies.length,
    sessionCookies: data.cookies.filter((c) => c.expires === -1).length,
    expiredCookies: expiring.filter((c) => c.expires < now).length,
    firstCookieExpiry: soonest ? new Date(soonest * 1000).toISOString() : null,
    localStorageOrigins: data.origins.map((o) => o.origin),
  };
}

export function listStates() {
  let files;
  try {
    files = readdirSync(PATHS.states);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -5);
    try {
      out.push(summarizeState(readState(name)));
    } catch (err) {
      out.push({ name, error: err.message });
    }
  }
  return out;
}

/** Import a Playwright / agent-browser storageState file. */
export function importState({ name, file, allowedOrigins, strict = false }) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data.cookies)) throw new Error(`${file} is not a storageState file (no cookies array)`);
  const allow = normalizeOriginPatterns(allowedOrigins ?? data.devtoolsFleet?.allowedOrigins ?? []);
  if (!allow.length) throw new Error('Pass --allow <origin> at least once: imported states need an allowlist');
  const cookies = data.cookies.filter((c) => cookieMatchesAllowlist(c.domain, allow));
  const origins = (data.origins ?? []).filter((o) => checkUrl(allow, o.origin).allowed);
  return {
    summary: writeState({ name, cookies, origins, allowedOrigins: allow, strict, createdBy: 'cli' }),
    droppedCookies: data.cookies.length - cookies.length,
  };
}
