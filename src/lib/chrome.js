import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { Browser, computeSystemExecutablePath, detectBrowserPlatform } from '@puppeteer/browsers';
import { parseViewport } from './config.js';
import { ensurePrivateDir, isPidAlive, sleep } from './fs-utils.js';

// Flags close to what puppeteer/chrome-devtools-mcp use: quiet, no first-run
// UI, no background noise that would show up in the agent's network panel.
const BASE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
  '--export-tagged-pdf',
];

export function resolveChromePath({ chromePath, channel = 'stable' }) {
  if (chromePath) {
    if (!existsSync(chromePath)) throw new Error(`chromePath does not exist: ${chromePath}`);
    return chromePath;
  }
  try {
    return computeSystemExecutablePath({ browser: Browser.CHROME, channel, platform: detectBrowserPlatform() });
  } catch (err) {
    throw new Error(
      `Could not find Chrome (${channel} channel). Install it, or set chromePath / DEVTOOLS_FLEET_CHROME_PATH.\n${err.message}`,
      { cause: err },
    );
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Launch Chrome detached, in its own process group, so it survives the fleet
 * process (that is what makes re-adoption possible).
 *
 * The port is picked here rather than by Chrome (port 0) so that
 * --remote-allow-origins can name exactly the debugging server's own origin.
 * That lets the DevTools inspector Chrome serves on that port connect (what
 * `devtools-fleet show` opens), while no web page can.
 * @returns {Promise<{ pid: number, port: number, wsPath: string }>}
 */
export async function launchChrome(opts) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await getFreePort();
    try {
      return await launchOnPort({ ...opts, port });
    } catch (err) {
      lastError = err;
      // Someone grabbed the port between probe and launch: Chrome can't bind and exits. Try another.
      if (!/exited during startup|did not open/.test(err.message)) throw err;
    }
  }
  throw lastError;
}

async function launchOnPort({ executablePath, profileDir, headless, viewport, extraArgs = [], url = 'about:blank', timeoutMs = 30_000, port, onSpawn = () => {} }) {
  ensurePrivateDir(profileDir);

  const args = [
    ...BASE_ARGS,
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
    `--user-data-dir=${profileDir}`,
  ];
  if (headless) args.push('--headless=new', '--hide-scrollbars', '--mute-audio');
  if (viewport) {
    const { width, height } = parseViewport(viewport);
    args.push(`--window-size=${width},${height}`);
  }
  args.push(...extraArgs, url);

  const child = spawn(executablePath, args, { detached: true, stdio: 'ignore' });
  let spawnError = null;
  child.once('error', (err) => { spawnError = err; });
  let exitCode = null;
  child.once('exit', (code, signal) => { exitCode = code ?? signal; });
  child.unref();
  // Record the pid before waiting, so a launch that hangs or crashes is still cleaned up.
  if (child.pid) onSpawn(child.pid);

  // With a fixed port Chrome doesn't write DevToolsActivePort; ask the
  // debugging server itself for the browser endpoint.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Failed to start Chrome at ${executablePath}: ${spawnError.message}`);
    if (exitCode !== null) throw new Error(`Chrome exited during startup (${exitCode}). Profile: ${profileDir}`);
    const wsPath = await browserEndpoint(port);
    if (wsPath && exitCode === null) return { pid: child.pid, port, wsPath };
    await sleep(100);
  }
  await terminate(child.pid);
  throw new Error(`Chrome did not open its debugging port within ${timeoutMs / 1000}s`);
}

async function browserEndpoint(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    const info = await res.json();
    if (!/Chrome/i.test(info.Browser ?? '')) return null;
    return new URL(info.webSocketDebuggerUrl).pathname;
  } catch {
    return null;
  }
}

export function browserWsUrl({ port, wsPath }) {
  return `ws://127.0.0.1:${port}${wsPath}`;
}

/** Page targets as the debugging server lists them (no CDP connection needed). */
export async function listPages({ port }, timeoutMs = 2000) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  const targets = await res.json();
  return targets.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url, title: t.title }));
}

/**
 * The DevTools inspector Chrome serves itself, with a live screencast of the
 * page. Watching this way doesn't disturb the agent's own connection.
 */
export function inspectorUrl({ port }, targetId) {
  return `http://127.0.0.1:${port}/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/${targetId}&remoteFrontend=true`;
}

/** True when a Chrome answers on the port with the expected browser endpoint. */
export async function isChromeAlive({ port, wsPath, chromePid }, timeoutMs = 2000) {
  if (!port || (chromePid && !isPidAlive(chromePid))) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const info = await res.json();
    return !wsPath || String(info.webSocketDebuggerUrl || '').endsWith(wsPath);
  } catch {
    return false;
  }
}

/** True when pid is a Chrome started on this profile dir (guards against pid reuse). */
export function pidOwnsProfile(pid, profileDir) {
  if (!pid || !isPidAlive(pid)) return false;
  if (process.platform === 'win32') return true;
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    return args.includes(`--user-data-dir=${profileDir}`);
  } catch {
    return false;
  }
}

/**
 * Close a fleet browser: politely over CDP, then by signal. Only signals a pid
 * that is still a Chrome on this profile, so a recycled pid is never hit.
 */
export async function closeChrome({ port, wsPath, chromePid, profileDir }, { cdp = null, timeoutMs = 5000 } = {}) {
  const ours = pidOwnsProfile(chromePid, profileDir);
  if (ours && await isChromeAlive({ port, wsPath, chromePid })) {
    try {
      if (cdp && !cdp.closed) {
        await Promise.race([cdp.send('Browser.close'), sleep(2000)]);
      } else {
        const { CdpConnection } = await import('./cdp.js');
        const conn = await CdpConnection.connect(browserWsUrl({ port, wsPath }), { timeoutMs: 2000 });
        await Promise.race([conn.send('Browser.close').catch(() => {}), sleep(2000)]);
        conn.close();
      }
    } catch {
      // fall through to signals
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (chromePid && isPidAlive(chromePid) && Date.now() < deadline) await sleep(100);
  if (chromePid && isPidAlive(chromePid) && ours) await terminate(chromePid);
}

/** SIGTERM, then SIGKILL if Chrome is still there after a grace period. */
async function terminate(pid, graceMs = 3000) {
  killPid(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (isPidAlive(pid) && Date.now() < deadline) await sleep(100);
  if (isPidAlive(pid)) killPid(pid, 'SIGKILL');
}

function killPid(pid, signal = 'SIGTERM') {
  try {
    // Negative pid: the whole process group (Chrome's helpers included).
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}
