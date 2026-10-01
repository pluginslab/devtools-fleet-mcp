import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FLEET_HOME = process.env.DEVTOOLS_FLEET_HOME || join(homedir(), '.devtools-fleet');

export const PATHS = {
  home: FLEET_HOME,
  browsers: join(FLEET_HOME, 'browsers'),
  profiles: join(FLEET_HOME, 'profiles'),
  states: join(FLEET_HOME, 'states'),
  locks: join(FLEET_HOME, 'locks'),
  config: join(FLEET_HOME, 'config.json'),
  reaperPid: join(FLEET_HOME, 'reaper.pid'),
  reaperLog: join(FLEET_HOME, 'reaper.log'),
};

export const DEFAULTS = {
  headless: true,
  viewport: null,
  channel: 'stable',
  chromePath: null,
  maxBrowsers: 10,
  orphanTimeoutMinutes: 15,
  launchTimeoutSeconds: 30,
  // Extra flags for chrome-devtools-mcp, e.g. ["--no-usage-statistics"].
  upstreamArgs: [],
  // Extra flags for Chrome itself.
  chromeArgs: [],
};

// Flags fleet owns. Passing them through would hand browser lifecycle back to
// chrome-devtools-mcp and defeat the point.
const RESERVED_UPSTREAM_FLAGS = [
  'browserUrl', 'browser-url', 'u', 'wsEndpoint', 'ws-endpoint', 'w', 'wsHeaders', 'ws-headers',
  'autoConnect', 'auto-connect', 'isolated', 'userDataDir', 'user-data-dir', 'headless',
  'channel', 'executablePath', 'executable-path', 'e', 'viewport', 'chromeArg', 'chrome-arg',
];

const ENV = {
  headless: ['DEVTOOLS_FLEET_HEADLESS', parseBool],
  viewport: ['DEVTOOLS_FLEET_VIEWPORT', String],
  channel: ['DEVTOOLS_FLEET_CHANNEL', String],
  chromePath: ['DEVTOOLS_FLEET_CHROME_PATH', String],
  maxBrowsers: ['DEVTOOLS_FLEET_MAX_BROWSERS', parsePositiveInt],
  orphanTimeoutMinutes: ['DEVTOOLS_FLEET_ORPHAN_TIMEOUT_MINUTES', parsePositiveInt],
  launchTimeoutSeconds: ['DEVTOOLS_FLEET_LAUNCH_TIMEOUT_SECONDS', parsePositiveInt],
};

export function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(PATHS.config, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Invalid ${PATHS.config}: ${err.message}`, { cause: err });
  }
  const config = { ...DEFAULTS, ...file };
  for (const [key, [name, parse]] of Object.entries(ENV)) {
    if (process.env[name] !== undefined && process.env[name] !== '') config[key] = parse(process.env[name], name);
  }
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!['stable', 'beta', 'dev', 'canary'].includes(config.channel)) {
    throw new Error(`channel must be stable, beta, dev or canary (got "${config.channel}")`);
  }
  if (config.viewport !== null) parseViewport(config.viewport);
  for (const key of ['maxBrowsers', 'orphanTimeoutMinutes', 'launchTimeoutSeconds']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  for (const key of ['upstreamArgs', 'chromeArgs']) {
    if (!Array.isArray(config[key]) || !config[key].every((a) => typeof a === 'string')) {
      throw new Error(`${key} must be an array of strings`);
    }
  }
  for (const arg of config.upstreamArgs) {
    const flag = arg.replace(/^--?(no-)?/, '').split('=')[0];
    if (RESERVED_UPSTREAM_FLAGS.includes(flag)) {
      throw new Error(`upstreamArgs may not include "${arg}": devtools-fleet manages the browser itself`);
    }
  }
}

/** "1280x720" → { width: 1280, height: 720 } */
export function parseViewport(value) {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(String(value));
  if (!match) throw new Error(`viewport must look like 1280x720 (got "${value}")`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseBool(value, name) {
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function parsePositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
