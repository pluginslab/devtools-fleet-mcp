import { statSync } from 'node:fs';
import { PATHS, loadConfig } from './config.js';
import { resolveChromePath } from './chrome.js';
import { UPSTREAM_VERSION } from './upstream.js';
import { listStates } from './states.js';
import { listEntries } from './registry.js';

/**
 * Health checks for Chrome, Node, permissions and configuration. Shared by
 * `devtools-fleet doctor` and the fleet_doctor tool.
 * @returns {{ label: string, ok: boolean, detail: string }[]}
 */
export function runChecks() {
  const results = [];
  const check = (label, fn) => {
    try {
      results.push({ label, ok: true, detail: fn() ?? '' });
    } catch (err) {
      results.push({ label, ok: false, detail: err.message });
    }
  };
  let config;
  check('config', () => { config = loadConfig(); return PATHS.config; });
  check('node', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) throw new Error(`${process.versions.node}; need 22.12 or newer`);
    return process.versions.node;
  });
  if (config) check(`chrome (${config.channel})`, () => resolveChromePath(config));
  check('chrome-devtools-mcp', () => UPSTREAM_VERSION);
  check('fleet home', () => {
    try {
      const mode = statSync(PATHS.home).mode & 0o777;
      if (mode & 0o077) throw new Error(`${PATHS.home} is readable by others (mode ${mode.toString(8)}); run chmod 700`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return `${PATHS.home} (created on first use)`;
    }
    return PATHS.home;
  });
  check('states', () => `${listStates().length} saved`);
  check('browsers', () => `${listEntries().length} registered${config ? ` (limit ${config.maxBrowsers})` : ''}`);
  return results;
}

export function formatChecks(results) {
  return results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}${r.detail ? `: ${r.detail}` : ''}`).join('\n');
}
