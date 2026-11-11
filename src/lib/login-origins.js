import { PLACEHOLDER_PATH } from './storage.js';
import { normalizeOriginPatterns, checkUrl } from './origins.js';

// Shared by both ways a person logs in: `devtools-fleet login` in a terminal,
// and state_login, where the agent opens the window and the person types.

/**
 * Record every top-level http(s) origin a page passes through (login page, SSO
 * provider, the app) into `visited`. Needs Target.setDiscoverTargets on.
 * Returns a function that stops recording.
 */
export function trackVisitedOrigins(cdp, visited) {
  const note = ({ targetInfo }) => {
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
  const offCreated = cdp.on('Target.targetCreated', note);
  const offChanged = cdp.on('Target.targetInfoChanged', note);
  return () => { offCreated(); offChanged(); };
}

/**
 * The allowlist a login proposes: where it started and where it ended up (tabs
 * still open), plus anything asked for. Origins only passed through (an SSO
 * provider, usually) are left out: saving their cookies would hand agents the
 * whole SSO session. They come back as `passedThrough` so they can be shown.
 */
export function proposeLoginAllowlist({ startOrigin, landed, extra = [], visited }) {
  const proposed = normalizeOriginPatterns([startOrigin, ...landed, ...extra]);
  const passedThrough = visited.filter((o) => !checkUrl(proposed, o).allowed);
  return { proposed, passedThrough };
}

/** Origins whose localStorage a login saves: the allowlist's exact origins plus allowed ones visited. */
export function loginStorageOrigins(allowedOrigins, visited) {
  return [...new Set([
    ...allowedOrigins.filter((p) => !p.includes('*')),
    ...visited.filter((o) => checkUrl(allowedOrigins, o).allowed),
  ])];
}
