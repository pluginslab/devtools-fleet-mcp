import { realpathSync } from 'node:fs';
import { dirname, resolve, sep, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS } from './config.js';
import { checkUrl } from './origins.js';

// Checks on arguments an agent passes to chrome-devtools-mcp's tools, before
// fleet forwards the call. The in-browser guard (guard.js) is the second
// layer for navigations; these catch what it can't see.

const NAVIGATION_TOOLS = new Set(['new_page', 'navigate_page']);
const OK_SCHEMES = new Set(['about:', 'data:', 'blob:']);

/** @returns {string|null} a reason to refuse the call, or null */
export function checkToolCall(name, args, { allowlist, stateName = null }) {
  if (NAVIGATION_TOOLS.has(name) && typeof args.url === 'string') {
    const reason = checkNavigation(args.url, allowlist, stateName);
    if (reason) return reason;
  }
  // A page in a separate browser context isn't covered by the guard's
  // auto-attach, so with an allowlist there are no extra contexts.
  if (name === 'new_page' && args.isolatedContext !== undefined && allowlist) {
    return 'isolatedContext is not available in a browser with an allowlist. Open the page in the normal context.';
  }
  for (const [key, value] of Object.entries(args)) {
    if (!/path/i.test(key)) continue;
    for (const p of Array.isArray(value) ? value : [value]) {
      if (typeof p === 'string' && isInsideFleetHome(p)) {
        return `${key} points inside ${PATHS.home}, which holds saved logins and browser profiles. Use another location.`;
      }
    }
  }
  return null;
}

function checkNavigation(url, allowlist, stateName) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `Not a valid URL: ${url}`;
  }
  if (['http:', 'https:'].includes(parsed.protocol)) {
    const { allowed, origin } = checkUrl(allowlist, url);
    const whose = stateName ? `this browser's allowlist (state "${stateName}")` : "this browser's allowlist";
    return allowed ? null : `${url} is blocked. ${origin} is not in ${whose}: ${allowlist.join(', ')}.`;
  }
  if (OK_SCHEMES.has(parsed.protocol)) return null;
  if (parsed.protocol === 'file:') {
    if (allowlist) return `file: URLs are not available in a browser with an allowlist.`;
    let path;
    try {
      path = fileURLToPath(parsed);
    } catch {
      return `Not a valid file URL: ${url}`;
    }
    return isInsideFleetHome(path) ? `${url} is inside ${PATHS.home}, which holds saved logins and browser profiles.` : null;
  }
  return `${parsed.protocol} URLs can't be opened through devtools-fleet.`;
}

/** Resolve symlinks as far as the path exists, so a link into the fleet home doesn't slip past. */
function canonical(path) {
  let current = resolve(path);
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

export function isInsideFleetHome(path) {
  const home = canonical(PATHS.home);
  const target = canonical(path);
  return target === home || target.startsWith(home + sep);
}
