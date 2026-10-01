import { cookieMatchesAllowlist } from './origins.js';

// Moving logins in and out of a browser: cookies through the Storage domain,
// localStorage through a throwaway background tab.
//
// localStorage can only be touched from a page on that origin. Rather than
// load the real site (side effects, analytics, a service worker answering
// instead of the network), the tab navigates to <origin>/__devtools_fleet__
// and fleet answers that request itself with an empty page. The site's server
// is never contacted and its service worker is bypassed.

export const PLACEHOLDER_PATH = '/__devtools_fleet__';

const BLANK_HTML = Buffer.from('<!doctype html><link rel=icon href="data:,"><title>devtools-fleet</title>').toString('base64');

// Cookie fields as Playwright's storageState writes them.
export function toPlaywrightCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.session ? -1 : c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite ?? 'Lax',
    ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
  };
}

function toCdpCookieParam(c) {
  const param = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? '/',
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
  };
  if (c.sameSite) param.sameSite = c.sameSite;
  if (typeof c.expires === 'number' && c.expires > 0) param.expires = c.expires;
  if (c.partitionKey && typeof c.partitionKey === 'object') param.partitionKey = c.partitionKey;
  return param;
}

/** Answer a paused request with the empty placeholder page. */
export function fulfillPlaceholder(cdp, requestId, sessionId) {
  return cdp.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
    body: BLANK_HTML,
  }, sessionId).catch(() => {});
}

async function withBlankOrigin(cdp, origin, fn) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true, newWindow: false });
  let sessionId;
  try {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, sessionId);
    const off = cdp.on('Fetch.requestPaused', (params, sid) => {
      if (sid !== sessionId) return;
      fulfillPlaceholder(cdp, params.requestId, sid);
    });
    try {
      const loaded = cdp.waitFor('Page.loadEventFired', (_, sid) => sid === sessionId, 10_000);
      await cdp.send('Page.navigate', { url: `${origin}${PLACEHOLDER_PATH}` }, sessionId);
      await loaded;
    } finally {
      off();
    }
    return await fn(sessionId);
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

/** Every http(s) origin currently open in a tab. */
export async function openOrigins(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const origins = new Set();
  for (const t of targetInfos) {
    if (t.type !== 'page') continue;
    try {
      const url = new URL(t.url);
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin);
    } catch {
      // about:blank, chrome-error:// and friends
    }
  }
  return [...origins];
}

/**
 * Snapshot cookies and localStorage.
 * @param {object} opts
 * @param {string[]|null} opts.cookieAllowlist  keep only cookies for these origins (null = all)
 * @param {string[]} opts.storageOrigins        concrete origins to read localStorage from
 */
export async function captureStorage(cdp, { cookieAllowlist = null, storageOrigins = [] } = {}) {
  const { cookies } = await cdp.send('Storage.getCookies');
  const kept = cookieAllowlist ? cookies.filter((c) => cookieMatchesAllowlist(c.domain, cookieAllowlist)) : cookies;
  const origins = [];
  for (const origin of storageOrigins) {
    const entries = await withBlankOrigin(cdp, origin, (sid) => evaluate(cdp, sid, 'Object.entries(localStorage)'));
    if (entries.length) origins.push({ origin, localStorage: entries.map(([name, value]) => ({ name, value })) });
  }
  return { cookies: kept.map(toPlaywrightCookie), origins };
}

/** Load cookies and localStorage into a browser. Call before the first real navigation. */
export async function applyStorage(cdp, { cookies = [], origins = [] }) {
  if (cookies.length) await cdp.send('Storage.setCookies', { cookies: cookies.map(toCdpCookieParam) });
  for (const { origin, localStorage } of origins) {
    if (!localStorage?.length) continue;
    const payload = JSON.stringify(localStorage.map(({ name, value }) => [name, value]));
    await withBlankOrigin(cdp, origin, (sid) => evaluate(cdp, sid, `for (const [k, v] of ${payload}) localStorage.setItem(k, v); localStorage.length`));
  }
}

/** Tabs worth reopening after a relaunch. */
export async function openTabUrls(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos
    .filter((t) => t.type === 'page' && /^https?:/.test(t.url) && !t.url.includes(PLACEHOLDER_PATH))
    .map((t) => t.url);
}
