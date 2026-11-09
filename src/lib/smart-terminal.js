import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isPidAlive } from './fs-utils.js';

// Smart Terminal (a macOS terminal) has a Chromium of its own and shows each
// tab's browser in a pane beside the terminal. Run inside one of its tabs,
// fleet asks it for that tab's browser instead of launching Chrome: the agent
// works in a page you can watch, in the tab it was started from.
//
// The app tells its shells where to ask: SMART_TERMINAL_GATE names a JSON file
// (readable only by you) with the endpoint and a control token, and
// SMART_TERMINAL_TAB names the tab. Every browser it hands out has its own
// in-memory profile and a DevTools endpoint that shows that browser's pages only.

/**
 * Whether the process behind a registry entry's browser is alive. A Smart Terminal
 * browser's is the app itself, kept apart from chromePid (null for those) so that
 * nothing that signals a Chrome can ever reach it.
 */
export function browserProcessAlive(entry) {
  if (entry.smartTerminal) return Boolean(entry.smartTerminal.pid) && isPidAlive(entry.smartTerminal.pid);
  return Boolean(entry.chromePid) && isPidAlive(entry.chromePid);
}

/**
 * Inside tmux, which tab this process belongs to. SMART_TERMINAL_TAB in the process
 * environment can't be trusted there: tmux hands a session the environment of
 * whichever tab started its server. A session started for a tab (`cc-tmux`, Smart
 * Terminal's own tmux restore) carries the right one in its *session* environment,
 * so ask tmux for that. Also returns the session, so Smart Terminal can find the tab
 * showing it when the session carries no tab.
 * @returns {{ tab: string|null, tmux: { socket: string, session: string }|null }}
 */
export function tmuxTab(env = process.env, run = runTmux) {
  const socket = env.TMUX?.split(',')[0];
  if (!socket) return { tab: null, tmux: null };
  try {
    const target = env.TMUX_PANE ? ['-t', env.TMUX_PANE] : [];
    const session = run(['-S', socket, 'display-message', '-p', ...target, '#{session_name}']).trim();
    if (!session) return { tab: null, tmux: null };
    let tab = null;
    try {
      // Session environment only (no -g): "NAME=value", or "-NAME" when unset there.
      const line = run(['-S', socket, 'show-environment', '-t', `=${session}`, 'SMART_TERMINAL_TAB']).trim();
      if (line.startsWith('SMART_TERMINAL_TAB=')) tab = line.slice('SMART_TERMINAL_TAB='.length) || null;
    } catch { /* unknown variable: the session carries no tab */ }
    return { tab, tmux: { socket, session } };
  } catch {
    return { tab: null, tmux: null };
  }
}

function runTmux(args) {
  return execFileSync('tmux', args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The gate of the Smart Terminal this process runs in, or null. */
export function smartTerminalGate(env = process.env, run = runTmux) {
  if (env.DEVTOOLS_FLEET_SMART_TERMINAL === '0') return null;
  const file = env.SMART_TERMINAL_GATE;
  if (!file) return null;
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'));
    if (info.version !== 1 || !info.url || !info.token) return null;
    // A file left by a Smart Terminal that has quit points nowhere.
    if (info.pid && !isPidAlive(info.pid)) return null;
    // Inside tmux: the tab the tmux session was started for, else Smart Terminal
    // looks for the tab showing that session ("-"), else the tab you're in.
    let tab = env.SMART_TERMINAL_TAB || '-';
    let tmux = null;
    if (env.TMUX) {
      const found = tmuxTab(env, run);
      tab = found.tab ?? '-';
      tmux = found.tmux;
    }
    return { url: info.url, token: info.token, pid: info.pid ?? null, tab, ...(tmux ? { tmux } : {}) };
  } catch {
    return null;
  }
}

async function call(gate, method, path, body) {
  const res = await fetch(`${gate.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${gate.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Smart Terminal: ${data.error ?? `HTTP ${res.status}`}`);
  return data;
}

/**
 * A browser in the tab's pane for fleet browser `id`. Asking again with the same
 * id (a reconnect) gets the same browser, pages intact.
 * @returns {{ wsEndpoint: string, port: number, wsPath: string, tab: string }}
 */
export async function openSmartTerminalBrowser(gate, id) {
  const data = await call(gate, 'POST', '/v1/browsers', { id, tab: gate.tab, ...(gate.tmux ? { tmux: gate.tmux } : {}) });
  const ws = new URL(data.wsEndpoint);
  return { wsEndpoint: data.wsEndpoint, port: Number(ws.port), wsPath: ws.pathname, tab: data.tab };
}

/** Whether the Smart Terminal still has the browser of this registry entry. */
export async function isSmartTerminalBrowserAlive(entry) {
  const gate = entry.smartTerminal;
  if (!gate || (gate.pid && !isPidAlive(gate.pid))) return false;
  try {
    const { browsers } = await call(gate, 'GET', '/v1/browsers');
    return browsers.some((b) => b.id === entry.id);
  } catch {
    return false;
  }
}

/** Closes the entry's pane in Smart Terminal. Never a signal: the pid is the whole app's. */
export async function closeSmartTerminalBrowser(entry) {
  const gate = entry.smartTerminal;
  if (!gate || (gate.pid && !isPidAlive(gate.pid))) return;
  await call(gate, 'DELETE', `/v1/browsers/${encodeURIComponent(entry.id)}`).catch(() => {});
}
