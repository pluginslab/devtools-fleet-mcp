import { checkUrl } from './origins.js';
import { PLACEHOLDER_PATH, fulfillPlaceholder } from './storage.js';

// The allowlist's second layer: fleet's own CDP connection auto-attaches to
// every target (tabs, popups, out-of-process iframes, workers) and fails
// requests to origins that aren't allowed. waitForDebuggerOnStart means a new
// tab is held until interception is on, so a popup can't slip its first
// navigation through.
//
// Non-strict: only Document requests (navigations). Strict: every request,
// which also stops fetch()/XHR/beacon exfiltration from evaluate_script.
//
// Fails closed: a tab or frame whose interception can't be switched on is
// closed, and so is any page in a browser context other than the default one
// (the browser-level auto-attach doesn't reach new contexts).

const PAGE_LIKE = new Set(['page', 'iframe']);
const WORKERS = new Set(['worker', 'service_worker', 'shared_worker']);

export async function installGuard(cdp, { allowlist, strict = false, onBlock = () => {} }) {
  if (!allowlist) return () => {};
  const pattern = { urlPattern: '*', requestStage: 'Request', ...(strict ? {} : { resourceType: 'Document' }) };

  // Only sessions this guard enabled interception on. Other code on the same
  // connection (storage.js) runs its own Fetch sessions and answers those itself.
  const guarded = new Set();

  const offPaused = cdp.on('Fetch.requestPaused', (params, sessionId) => {
    if (!guarded.has(sessionId)) return;
    const { allowed, origin } = checkUrl(allowlist, params.request.url);
    // Fleet's own storage tab (see storage.js). When two interceptors see the
    // same request, whichever gets it must answer it the same way, or a
    // "continue" from here would send it to the real site.
    if (allowed && params.resourceType === 'Document' && new URL(params.request.url).pathname === PLACEHOLDER_PATH) {
      fulfillPlaceholder(cdp, params.requestId, sessionId);
      return;
    }
    if (allowed) {
      cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
    } else {
      onBlock({ url: params.request.url, origin, resourceType: params.resourceType });
      cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
    }
  });

  const offAttached = cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
    const pageLike = PAGE_LIKE.has(targetInfo.type);
    if (pageLike || (strict && WORKERS.has(targetInfo.type))) {
      guarded.add(sessionId);
      try {
        await cdp.send('Fetch.enable', { patterns: [pattern] }, sessionId);
        if (pageLike) await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      } catch {
        guarded.delete(sessionId);
        if (pageLike) {
          // Can't guard it, so it doesn't get to run.
          onBlock({ url: targetInfo.url, origin: null, resourceType: `${targetInfo.type} that could not be guarded (closed)` });
          await cdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
          return;
        }
      }
    }
    if (waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  });

  const offDetached = cdp.on('Target.detachedFromTarget', ({ sessionId }) => guarded.delete(sessionId));

  // Pages in a browser context other than the default one are closed on sight.
  // Defence in depth: fleet already refuses isolatedContext, the only way
  // upstream creates one, so this catches only direct CDP clients, which could
  // do anything anyway. It closes such a page, it can't stop its first load.
  const { defaultBrowserContextId: defaultContext } = await cdp.send('Target.getBrowserContexts');
  const { targetInfos } = await cdp.send('Target.getTargets');
  const closeForeign = ({ targetInfo }) => {
    if (targetInfo.type !== 'page' || !defaultContext || targetInfo.browserContextId === defaultContext) return;
    onBlock({ url: targetInfo.url || 'about:blank', origin: null, resourceType: 'page in a separate browser context (closed)' });
    cdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
  };
  const offCreated = cdp.on('Target.targetCreated', closeForeign);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  for (const targetInfo of targetInfos) closeForeign({ targetInfo });

  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  return () => {
    offCreated();
    offDetached();
    offPaused();
    offAttached();
    cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false }).catch(() => {});
    cdp.send('Target.setDiscoverTargets', { discover: false }).catch(() => {});
  };
}
