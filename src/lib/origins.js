// Origin patterns for allowlists.
//
//   https://app.example.com      exact origin (scheme + host + port)
//   http://127.0.0.1:3000        ports matter
//   https://*.example.com        any subdomain of example.com (not example.com itself)
//
// No paths, no bare hosts: an allowlist entry is always a full origin, so
// "http vs https" and "which port" are never ambiguous.

// Never blocked: internal and inline pages that can't reach the network.
const ALWAYS_ALLOWED_SCHEMES = new Set(['about:', 'data:', 'blob:', 'chrome-error:', 'devtools:', 'javascript:']);

export function normalizeOriginPattern(input) {
  const raw = String(input).trim();
  const wildcard = /^(https?):\/\/\*\.(.+)$/i.exec(raw);
  if (wildcard) {
    const url = parseUrl(`${wildcard[1]}://${wildcard[2]}`, input);
    assertBareOrigin(url, input);
    if (url.hostname.split('.').length < 2) throw new Error(`Wildcard too broad: "${input}"`);
    return `${url.protocol}//*.${url.host}`;
  }
  const url = parseUrl(raw, input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Origin must be http(s): "${input}"`);
  assertBareOrigin(url, input);
  return url.origin;
}

export function normalizeOriginPatterns(list) {
  return [...new Set(list.map(normalizeOriginPattern))];
}

function parseUrl(value, original) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Not an origin: "${original}" (expected e.g. https://app.example.com)`);
  }
}

function assertBareOrigin(url, original) {
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash || url.username || url.password) {
    throw new Error(`Origin must not have a path, query or credentials: "${original}"`);
  }
}

/** Does one pattern cover this origin ("https://a.example.com")? */
export function patternMatchesOrigin(pattern, origin) {
  if (!pattern.includes('*')) return pattern === origin;
  const { scheme, host } = splitWildcard(pattern);
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === scheme && url.host.endsWith(`.${host}`);
}

function splitWildcard(pattern) {
  const [scheme, rest] = pattern.split('//*.');
  return { scheme, host: rest };
}

/** @returns {{ allowed: boolean, origin?: string }} */
export function checkUrl(allowlist, url) {
  if (!allowlist) return { allowed: true };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, origin: String(url) };
  }
  if (ALWAYS_ALLOWED_SCHEMES.has(parsed.protocol)) return { allowed: true };
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return { allowed: false, origin: parsed.protocol };
  // WebSockets follow the page's http(s) origin rules.
  const origin = parsed.origin.replace(/^ws(s?):/, 'http$1:');
  return { allowed: allowlist.some((p) => patternMatchesOrigin(p, origin)), origin };
}

/** Is every pattern in `narrower` covered by `wider`? (used so agents can't widen an allowlist) */
export function isSubset(narrower, wider) {
  return narrower.every((p) => {
    if (!p.includes('*')) return wider.some((w) => patternMatchesOrigin(w, p));
    // A wildcard is only covered by an equal or broader wildcard.
    const { scheme, host } = splitWildcard(p);
    return wider.some((w) => {
      if (!w.includes('*')) return false;
      const ww = splitWildcard(w);
      return ww.scheme === scheme && (host === ww.host || host.endsWith(`.${ww.host}`));
    });
  });
}

/** Does a cookie's domain belong to an allowlist? Cookies are only kept (and restored) if so. */
export function cookieMatchesAllowlist(cookieDomain, allowlist) {
  const domain = cookieDomain.replace(/^\./, '').toLowerCase();
  return allowlist.some((pattern) => {
    const host = pattern.includes('*')
      ? splitWildcard(pattern).host.split(':')[0]
      : new URL(pattern).hostname;
    // Cookie set for a parent domain (example.com) is sent to app.example.com; one set for the host itself too.
    return host === domain || host.endsWith(`.${domain}`) || (pattern.includes('*') && domain.endsWith(`.${host}`));
  });
}
