import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER = join(ROOT, 'src/index.js');
const CLI = join(ROOT, 'bin/cli.js');

export function makeHome() {
  return mkdtempSync(join(tmpdir(), 'fleet-it-'));
}

/** Kill every browser under a fleet home and delete it. */
export function cleanupHome(home) {
  try {
    execFileSync(process.execPath, [CLI, 'kill', '--all'], { env: { ...process.env, DEVTOOLS_FLEET_HOME: home }, stdio: 'ignore', timeout: 30_000 });
  } catch {
    // best effort
  }
  try {
    const pid = Number(readFileSync(join(home, 'reaper.pid'), 'utf8'));
    process.kill(pid);
  } catch {
    // no reaper
  }
  rmSync(home, { recursive: true, force: true });
}

export function registry(home) {
  try {
    return readdirSync(join(home, 'browsers')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(home, 'browsers', f), 'utf8')));
  } catch {
    return [];
  }
}

/** An MCP client driving one devtools-fleet-mcp process: one simulated agent session. */
export class FleetClient {
  static #open = new Set();

  /** Close every client still open (so a failed assertion can't leave the test process hanging). */
  static async closeAll() {
    await Promise.all([...FleetClient.#open].map((c) => c.close()));
  }

  /** @param {string[]} [roots] workspace directories this client reports over MCP roots */
  static async start({ home, env = {}, roots = null }) {
    const c = new FleetClient();
    FleetClient.#open.add(c);
    c.transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, DEVTOOLS_FLEET_HOME: home, ...env },
      stderr: 'pipe',
    });
    c.stderr = '';
    c.transport.stderr?.on('data', (d) => { c.stderr += d; });
    c.client = new Client({ name: 'fleet-test', version: '0' }, { capabilities: roots ? { roots: { listChanged: true } } : {} });
    if (roots) {
      c.client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href, name: r })) }));
    }
    await c.client.connect(c.transport);
    return c;
  }

  get pid() {
    return this.transport.pid;
  }

  async call(name, args = {}) {
    const r = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    return { text: (r.content ?? []).map((x) => x.text ?? '').join('\n'), isError: Boolean(r.isError) };
  }

  /** Simulate a crash or a client reconnect: the process dies without detaching. */
  hardKill() {
    process.kill(this.pid, 'SIGKILL');
  }

  async close() {
    FleetClient.#open.delete(this);
    await this.client.close().catch(() => {});
  }
}

export function runCli(home, args, { input, env = {}, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, DEVTOOLS_FLEET_HOME: home, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { p.kill(); reject(new Error(`CLI timed out: ${args.join(' ')}\n${stdout}\n${stderr}`)); }, timeout);
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input !== undefined) p.stdin.end(input);
  });
}

/** Spawn the CLI and return the live process (for interactive flows like login). */
export function spawnCli(home, args, env = {}) {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, DEVTOOLS_FLEET_HOME: home, ...env } });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; });
  p.stderr.on('data', (d) => { p.out += d; });
  p.done = new Promise((resolve) => p.on('exit', (code) => resolve(code)));
  return p;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 20_000, interval = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval);
  }
}

/**
 * Two local sites: `app` (a login form, a logged-in page, links out) and
 * `outside` (what the allowlist should keep the agent away from). Both count
 * hits per path so tests can prove what did and didn't reach the network.
 */
export async function startFixtures() {
  const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.hits = {};
    // Minimal WebSocket handshake, so tests can see whether a WebSocket got through.
    server.on('upgrade', (req, socket) => {
      server.hits[`WS ${req.url}`] = (server.hits[`WS ${req.url}`] ?? 0) + 1;
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const sessions = new Map();

  const outside = await listen((req, res) => {
    outside.hits[req.url] = (outside.hits[req.url] ?? 0) + 1;
    if (req.url.startsWith('/sso?back=')) {
      // A rendered SSO page (like a real provider's login screen), then back to the app.
      const back = decodeURIComponent(req.url.slice('/sso?back='.length));
      res.setHeader('set-cookie', 'sso_session=SSO-SECRET; Path=/; HttpOnly');
      res.setHeader('content-type', 'text/html');
      return res.end(`<title>SSO</title><script>setTimeout(() => location.replace(${JSON.stringify(back)}), 300)</script>`);
    }
    res.setHeader('content-type', 'text/html');
    res.setHeader('access-control-allow-origin', '*');
    res.end('<title>OUTSIDE</title>outside');
  });
  // A different host from the app, so cookies are separate too (they ignore ports).
  const outsideOrigin = `http://localhost:${outside.address().port}`;

  const app = await listen((req, res) => {
    const path = req.url.split('?')[0];
    app.hits[path] = (app.hits[path] ?? 0) + 1;
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')));
    const user = sessions.get(cookies.sid);
    res.setHeader('content-type', 'text/html');
    if (path === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('u') === 'admin' && form.get('p') === 'pw') {
          const sid = randomBytes(8).toString('hex');
          sessions.set(sid, 'admin');
          res.setHeader('set-cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
          res.end('<title>WELCOME</title><script>localStorage.setItem("ls", "from-login")</script><a href="/app">continue</a>');
        } else {
          res.statusCode = 401;
          res.end('<title>DENIED</title>');
        }
      });
      return;
    }
    if (path === '/sso-start') {
      res.statusCode = 302;
      res.setHeader('location', `${outsideOrigin}/sso?back=${encodeURIComponent(`${appOrigin}/login`)}`);
      return res.end();
    }
    if (path === '/login') {
      return res.end('<title>LOGIN</title><form method=post action=/login><input name=u id=u><input name=p id=p type=password><button id=go>go</button></form>');
    }
    if (path === '/app') {
      return res.end(`<title>pending</title><script>document.title = "user=${user ?? 'anon'} ls=" + (localStorage.getItem("ls") ?? "none")</script>
        <a id=out href="${outsideOrigin}/clicked">out</a>`);
    }
    if (path === '/beacon') {
      return res.end(`<title>pending</title><script>fetch("${outsideOrigin}/fetched").then(() => document.title = "fetch-ok").catch(() => document.title = "fetch-blocked")</script>`);
    }
    return res.end(`<title>APP ${path}</title>${path}`);
  });
  const appOrigin = `http://127.0.0.1:${app.address().port}`;

  return {
    app, outside, appOrigin, outsideOrigin, sessions,
    close: () => { app.close(); outside.close(); },
  };
}

/** Page id of the first tab whose line in list_pages output contains `needle`. */
export function pageId(listText, needle) {
  const line = listText.split('\n').find((l) => /^\d+:/.test(l) && l.includes(needle));
  return line ? Number(line.split(':')[0]) : undefined;
}

/** Pull the first quoted JSON value out of an evaluate_script response. */
export function evalValue(text) {
  const m = /```json\s*([\s\S]*?)\s*```/.exec(text);
  return m ? JSON.parse(m[1]) : undefined;
}
