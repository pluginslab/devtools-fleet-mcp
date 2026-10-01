import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PATHS } from './config.js';
import { CdpConnection } from './cdp.js';
import { launchChrome, closeChrome, browserWsUrl, resolveChromePath } from './chrome.js';
import { newBrowserId, writeEntry, updateEntry, removeEntry } from './registry.js';
import { ensureReaper } from './reaper.js';
import { captureStorage, toPlaywrightCookie, openOrigins, PLACEHOLDER_PATH } from './storage.js';
import { writeState, stateExists, assertStateName } from './states.js';
import { normalizeOriginPatterns, checkUrl, cookieMatchesAllowlist } from './origins.js';

// `devtools-fleet login <name> <url>`: a person logs in by hand in a visible
// window (2FA, SSO, captchas all fine), fleet records every origin they pass
// through, and saves cookies + localStorage as a state.

const COOKIE_POLL_MS = 3000;

export async function login({ name, url, allow = [], strict = false, overwrite = false, yes = false, headless = false, config, io = defaultIo() }) {
  assertStateName(name);
  if (stateExists(name) && !overwrite) throw new Error(`State "${name}" already exists. Use --overwrite to replace it.`);
  const start = new URL(url);
  if (!['http:', 'https:'].includes(start.protocol)) throw new Error('The login URL must be http(s)');
  const extraAllow = normalizeOriginPatterns(allow);

  const id = newBrowserId();
  const entry = {
    id,
    kind: 'login',
    chromePid: null,
    port: null,
    wsPath: null,
    profileDir: join(PATHS.profiles, id),
    headless,
    viewport: null,
    channel: config.channel,
    // The CLI is both driver and owner: if it dies, the reaper closes the window.
    fleetPid: process.pid,
    anchorPid: process.pid,
    anchorLabel: 'devtools-fleet login',
    cwd: process.cwd(),
    state: name,
    allowedOrigins: null,
    strict,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };
  writeEntry(entry);
  ensureReaper();

  let cdp = null;
  let current = entry;
  let browserGone = false;
  let lastCookies = null;
  try {
    const chrome = await launchChrome({
      executablePath: resolveChromePath({ chromePath: config.chromePath, channel: config.channel }),
      profileDir: entry.profileDir,
      onSpawn: (pid) => { current = updateEntry(id, { chromePid: pid }) ?? current; },
      headless,
      viewport: null,
      extraArgs: config.chromeArgs,
      url,
      timeoutMs: config.launchTimeoutSeconds * 1000,
    });
    current = updateEntry(id, { chromePid: chrome.pid, port: chrome.port, wsPath: chrome.wsPath });
    cdp = await CdpConnection.connect(browserWsUrl(chrome));
    cdp.on('__close', () => { browserGone = true; });

    // Every top-level origin the person passes through (login page, SSO provider, the app).
    const visited = [start.origin];
    const note = (targetInfo) => {
      if (targetInfo.type !== 'page') return;
      try {
        const u = new URL(targetInfo.url);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.pathname !== PLACEHOLDER_PATH && !visited.includes(u.origin)) {
          visited.push(u.origin);
        }
      } catch {
        // about:blank etc.
      }
    };
    cdp.on('Target.targetCreated', ({ targetInfo }) => note(targetInfo));
    cdp.on('Target.targetInfoChanged', ({ targetInfo }) => note(targetInfo));
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    // Closing the last window quits Chrome on Linux and Windows; keep a recent
    // cookie snapshot so that still saves something.
    const poll = setInterval(async () => {
      try {
        lastCookies = (await cdp.send('Storage.getCookies')).cookies;
      } catch {
        // browser going away
      }
    }, COOKIE_POLL_MS);
    poll.unref();

    io.print(`\nA Chrome window is open at ${url}.`);
    io.print('Log in there (2FA and SSO are fine). When you are done, come back here and press Enter. Ctrl+C cancels.\n');
    await io.waitForEnter(() => browserGone);
    clearInterval(poll);

    // Default: where the login started and where it ended up (tabs still open),
    // plus --allow. Origins only passed through (an SSO provider, usually) are
    // left out: saving their cookies would hand agents the whole SSO session.
    const landed = browserGone ? [] : await openOrigins(cdp).catch(() => []);
    const proposed = normalizeOriginPatterns([start.origin, ...landed, ...extraAllow]);
    const passedThrough = visited.filter((o) => !checkUrl(proposed, o).allowed);
    let allowedOrigins = proposed;
    io.print(`\nThis state will only be usable on:\n${proposed.map((o) => `  ${o}`).join('\n')}`);
    if (passedThrough.length) {
      io.print(`Also visited during login, not included (add with --allow, or type your own list below):\n${passedThrough.map((o) => `  ${o}`).join('\n')}`);
    }
    if (!yes) {
      const answer = (await io.ask('Save with these allowed origins? [Y/n, or type a comma-separated list instead] ')).trim();
      if (/^n(o)?$/i.test(answer)) throw new Error('Cancelled; nothing saved.');
      if (answer && !/^y(es)?$/i.test(answer)) {
        allowedOrigins = normalizeOriginPatterns(answer.split(',').map((s) => s.trim()).filter(Boolean));
      }
    }

    let snapshot;
    if (!browserGone) {
      const storageOrigins = [...new Set([
        ...allowedOrigins.filter((p) => !p.includes('*')),
        ...visited.filter((o) => checkUrl(allowedOrigins, o).allowed),
      ])];
      snapshot = await captureStorage(cdp, { cookieAllowlist: allowedOrigins, storageOrigins });
    } else {
      if (!lastCookies) throw new Error('The browser closed before anything could be saved. Run login again and press Enter before closing the window.');
      io.print('The browser was closed, so localStorage could not be read. Saving cookies only.');
      snapshot = storageFromCookies(lastCookies, allowedOrigins);
    }

    const summary = writeState({ name, cookies: snapshot.cookies, origins: snapshot.origins, allowedOrigins, strict, createdBy: 'cli' });
    io.print(`\nSaved state "${summary.name}": ${summary.cookies} cookie(s), localStorage for ${summary.localStorageOrigins.length} origin(s)${summary.strict ? ', strict' : ''}.`);
    if (summary.cookies === 0) io.print('Warning: no cookies were saved for these origins. Did the login finish?');
    io.print(`Agents can now call browser_start({ state: "${summary.name}" }).`);
    return summary;
  } finally {
    await closeChrome(current, { cdp }).catch(() => {});
    cdp?.close();
    removeEntry(id);
    rmSync(entry.profileDir, { recursive: true, force: true });
  }
}

function storageFromCookies(cookies, allowedOrigins) {
  return {
    cookies: cookies.filter((c) => cookieMatchesAllowlist(c.domain, allowedOrigins)).map(toPlaywrightCookie),
    origins: [],
  };
}

function defaultIo() {
  const rl = () => createInterface({ input: process.stdin, output: process.stdout });
  return {
    print: (line) => console.log(line),
    ask: (question) => new Promise((resolve) => {
      const r = rl();
      r.question(question, (answer) => { r.close(); resolve(answer); });
    }),
    waitForEnter: (isGone) => new Promise((resolve) => {
      const r = rl();
      const timer = setInterval(() => {
        if (isGone()) {
          console.log('\nThe browser window was closed.');
          clearInterval(timer);
          r.close();
          resolve();
        }
      }, 500);
      r.once('line', () => { clearInterval(timer); r.close(); resolve(); });
    }),
  };
}

