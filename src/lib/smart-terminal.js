import { readFileSync } from 'node:fs';
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

/** The gate of the Smart Terminal this process runs in, or null. */
export function smartTerminalGate(env = process.env) {
  if (env.DEVTOOLS_FLEET_SMART_TERMINAL === '0') return null;
  const file = env.SMART_TERMINAL_GATE;
  if (!file) return null;
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'));
    if (info.version !== 1 || !info.url || !info.token) return null;
    // A file left by a Smart Terminal that has quit points nowhere.
    if (info.pid && !isPidAlive(info.pid)) return null;
    // Inside tmux the tab is whichever started the tmux server: ask for the tab you're in.
    const tab = env.TMUX ? '-' : (env.SMART_TERMINAL_TAB || '-');
    return { url: info.url, token: info.token, pid: info.pid ?? null, tab };
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
  const data = await call(gate, 'POST', '/v1/browsers', { id, tab: gate.tab });
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
