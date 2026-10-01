import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './config.js';
import { CdpConnection } from './cdp.js';
import { launchChrome, closeChrome, browserWsUrl, resolveChromePath, isChromeAlive } from './chrome.js';
import { withLock } from './lock.js';
import { newBrowserId, writeEntry, updateEntry, removeEntry, listEntries, classify } from './registry.js';
import { pruneRegistry, ensureReaper } from './reaper.js';
import { installGuard } from './guard.js';
import { checkUrl, normalizeOriginPatterns, isSubset, patternMatchesOrigin } from './origins.js';
import { checkToolCall } from './policy.js';
import { lockdownArgs } from './lockdown.js';
import { applyStorage, captureStorage, openOrigins, openTabUrls } from './storage.js';
import { readState, writeState, stateExists, summarizeState } from './states.js';
import { Upstream } from './upstream.js';
import { anchorMatches } from './process-tree.js';

const HEARTBEAT_MS = 30_000;

// One FleetSession per devtools-fleet-mcp process, i.e. per agent session.
// It owns at most one browser at a time.
//
// MCP clients send tool calls in parallel, so everything that changes which
// browser, CDP connection or upstream process this session has runs through
// #serial. Upstream tool calls themselves run concurrently, outside it.
export class FleetSession {
  #config;
  #anchor;
  #entry = null;
  #cdp = null;
  #upstream = null;
  #guardOff = null;
  #heartbeat = null;
  #blocks = [];
  #queue = Promise.resolve();
  #rootsProvider = null;

  constructor(config, anchor) {
    this.#config = config;
    this.#anchor = anchor;
  }

  get allowlist() {
    return this.#entry?.allowedOrigins ?? null;
  }

  /** Where upstream may read and write files: the MCP client's workspace roots, if it has any. */
  setRootsProvider(provider) {
    this.#rootsProvider = provider;
  }

  rootsChanged() {
    this.#upstream?.sendRootsListChanged();
  }

  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------- start

  /** Start (or re-adopt) this session's browser. */
  start(opts = {}) {
    return this.#serial(() => this.#start(opts));
  }

  async #start(opts) {
    const explicit = Object.values(opts).some((v) => v !== undefined);
    if (this.#entry && !this.#cdp?.closed) {
      if (explicit) {
        throw new Error(`This session already has a browser (${this.#entry.id}${this.#entry.state ? `, state "${this.#entry.state}"` : ''}). Call browser_stop first to start one with different options.`);
      }
      return { adopted: false, alreadyRunning: true };
    }
    if (this.#entry) await this.#teardown({ keepBrowser: false });

    const plan = this.#plan(opts);
    // Re-adopt only for a plain start or the same state: explicit options
    // (allowlist, url, headless...) must never be silently dropped.
    const onlyState = Object.entries(opts).every(([k, v]) => k === 'state' || v === undefined);
    const { entry, adopted } = await withLock('registry', () => this.#reserve(plan, { mayAdopt: onlyState }));
    this.#entry = entry;
    try {
      if (adopted) await this.#attach();
      else await this.#launch(plan);
    } catch (err) {
      await this.#teardown({ keepBrowser: adopted });
      throw err;
    }
    ensureReaper();
    this.#startHeartbeat();
    return { adopted, alreadyRunning: false };
  }

  #plan({ state, headless, viewport, channel, url, allowedOrigins }) {
    const plan = {
      headless: headless ?? this.#config.headless,
      viewport: viewport ?? this.#config.viewport,
      channel: channel ?? this.#config.channel,
      url: url ?? null,
      state: state ?? null,
      stateData: null,
      allowedOrigins: null,
      strict: false,
    };
    if (state) {
      if (allowedOrigins) throw new Error('allowedOrigins comes from the state; pass one or the other, not both');
      plan.stateData = readState(state);
      plan.allowedOrigins = plan.stateData.devtoolsFleet.allowedOrigins;
      plan.strict = plan.stateData.devtoolsFleet.strict;
    } else if (allowedOrigins?.length) {
      plan.allowedOrigins = normalizeOriginPatterns(allowedOrigins);
    }
    if (plan.url) {
      const reason = checkToolCall('new_page', { url: plan.url }, { allowlist: plan.allowedOrigins });
      if (reason) throw new Error(reason);
    }
    return plan;
  }

  // Runs under the registry lock: adopt a detached browser of this session, or reserve a slot.
  async #reserve(plan, { mayAdopt }) {
    pruneRegistry();
    if (mayAdopt) {
      const mine = listEntries().filter((e) =>
        e.kind === 'agent' &&
        classify(e) === 'detached' &&
        anchorMatches(e, this.#anchor) &&
        (plan.state ?? null) === (e.state ?? null) &&
        e.port);
      // Newest first: after several reconnects, the most recent browser is the one the agent was using.
      for (const candidate of mine.reverse()) {
        if (!(await isChromeAlive(candidate))) continue;
        const entry = updateEntry(candidate.id, { fleetPid: process.pid, lastSeen: Date.now() });
        if (entry) return { entry, adopted: true };
      }
    }

    const running = listEntries().filter((e) => e.kind === 'agent');
    if (running.length >= this.#config.maxBrowsers) {
      const lines = running.map((e) => `  ${e.id}  ${classify(e).padEnd(8)}  ${e.anchorLabel ?? ''}  ${e.cwd ?? ''}`).join('\n');
      throw new Error(
        `devtools-fleet is at its limit of ${this.#config.maxBrowsers} browsers.\n${lines}\n` +
        'Run `devtools-fleet gc` to close orphans, `devtools-fleet kill <id>` to close one, or raise maxBrowsers.',
      );
    }

    const id = newBrowserId();
    const now = Date.now();
    const entry = {
      id,
      kind: 'agent',
      chromePid: null,
      port: null,
      wsPath: null,
      profileDir: join(PATHS.profiles, id),
      headless: plan.headless,
      viewport: plan.viewport,
      channel: plan.channel,
      fleetPid: process.pid,
      anchorPid: this.#anchor.pid,
      anchorStart: this.#anchor.start ?? null,
      anchorLabel: this.#anchor.label,
      cwd: process.cwd(),
      state: plan.state,
      allowedOrigins: plan.allowedOrigins,
      strict: plan.strict,
      createdAt: now,
      lastSeen: now,
    };
    writeEntry(entry);
    return { entry, adopted: false };
  }

  /** Update this session's registry entry. Writes the whole entry, so it survives a concurrent prune. */
  #patch(patch) {
    this.#entry = { ...this.#entry, ...patch };
    writeEntry(this.#entry);
  }

  async #launchChrome(headless) {
    return launchChrome({
      executablePath: resolveChromePath({ chromePath: this.#config.chromePath, channel: this.#entry.channel }),
      onSpawn: (pid) => this.#patch({ chromePid: pid }),
      profileDir: this.#entry.profileDir,
      headless,
      viewport: this.#entry.viewport,
      // Lockdown flags go last so they win over anything in chromeArgs.
      extraArgs: [
        ...this.#config.chromeArgs,
        ...(this.#entry.strict && this.#entry.allowedOrigins ? lockdownArgs(this.#entry.allowedOrigins) : []),
      ],
      timeoutMs: this.#config.launchTimeoutSeconds * 1000,
    });
  }

  async #launch(plan) {
    const chrome = await this.#launchChrome(plan.headless);
    this.#patch({ chromePid: chrome.pid, port: chrome.port, wsPath: chrome.wsPath });
    this.#cdp = await CdpConnection.connect(browserWsUrl(chrome));
    // Logins go in before the guard (the restore tab is fleet's own) and before any real page loads.
    if (plan.stateData) await applyStorage(this.#cdp, plan.stateData);
    await this.#installGuard();
    await this.#startUpstream();
    if (plan.url) await this.#navigateFirstTab(plan.url);
  }

  async #attach() {
    this.#cdp = await CdpConnection.connect(browserWsUrl(this.#entry));
    await this.#installGuard();
    await this.#startUpstream();
  }

  async #installGuard() {
    this.#guardOff = await installGuard(this.#cdp, {
      allowlist: this.#entry.allowedOrigins,
      strict: this.#entry.strict,
      onBlock: (block) => {
        this.#blocks.push(block);
        if (this.#blocks.length > 50) this.#blocks.shift();
      },
    });
  }

  async #startUpstream() {
    this.#upstream = await Upstream.start({
      browserUrl: `http://127.0.0.1:${this.#entry.port}`,
      extraArgs: this.#config.upstreamArgs,
      rootsProvider: this.#rootsProvider,
    });
  }

  async #navigateFirstTab(url) {
    const { targetInfos } = await this.#cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) {
      await this.#cdp.send('Target.createTarget', { url });
      return;
    }
    const { sessionId } = await this.#cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await this.#cdp.send('Page.navigate', { url }, sessionId);
    await this.#cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }

  #startHeartbeat() {
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      try {
        if (this.#entry) updateEntry(this.#entry.id, { lastSeen: Date.now(), fleetPid: process.pid });
      } catch (err) {
        // A full disk or permissions problem shouldn't take the MCP server down.
        console.error(`[devtools-fleet] heartbeat failed: ${err.message}`);
      }
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  // ------------------------------------------------------------ upstream calls

  /** Make sure there is a healthy browser + upstream. Returns a note for the agent if something was recovered. */
  ensureReady() {
    return this.#serial(() => this.#ensureReady());
  }

  async #ensureReady() {
    if (!this.#entry) {
      const { adopted } = await this.#start({});
      return adopted ? `devtools-fleet: reconnected to this session's existing browser ${this.#entry.id}.` : null;
    }
    if (this.#cdp.closed || !(await isChromeAlive(this.#entry))) {
      const { state, allowedOrigins, headless, viewport, channel } = this.#entry;
      await this.#teardown({ keepBrowser: false });
      await this.#start({ state: state ?? undefined, allowedOrigins: state ? undefined : allowedOrigins ?? undefined, headless, viewport, channel });
      return `devtools-fleet: the browser had exited, so a fresh one was started (${this.#entry.id}${state ? `, state "${state}" reloaded` : ''}). Open tabs were lost.`;
    }
    if (!this.#upstream || this.#upstream.closed) {
      await this.#startUpstream();
      return 'devtools-fleet: chrome-devtools-mcp had exited and was restarted. The browser and its tabs are unchanged.';
    }
    return null;
  }

  async callUpstream(name, args = {}) {
    const { note, upstream, entry } = await this.#serial(async () => {
      const recovered = await this.#ensureReady();
      return { note: recovered, upstream: this.#upstream, entry: this.#entry };
    });
    const refusal = checkToolCall(name, args, { allowlist: entry.allowedOrigins, stateName: entry.state });
    if (refusal) return errorResult(`devtools-fleet: ${refusal}`);
    const blocksBefore = this.#blocks.length;
    let result;
    try {
      result = await upstream.callTool(name, args);
    } catch (err) {
      if (upstream.closed || this.#cdp?.closed || upstream !== this.#upstream) {
        const recovered = await this.ensureReady().catch((e) => `Recovery failed: ${e.message}`);
        return errorResult(`devtools-fleet: the call failed because the browser tooling exited or was restarted (${err.message}). ${recovered ?? ''} Retry the call.`);
      }
      throw err;
    }
    const newBlocks = this.#blocks.slice(blocksBefore);
    const extra = [];
    if (note) extra.push(note);
    if (newBlocks.length) {
      extra.push(
        `devtools-fleet blocked ${newBlocks.length} request(s) outside the allowlist (${(entry.allowedOrigins ?? []).join(', ')}):\n` +
        newBlocks.slice(0, 5).map((b) => `  ${b.resourceType ?? 'request'} ${b.url}`).join('\n'),
      );
    }
    if (extra.length) result = { ...result, content: [...(result.content ?? []), { type: 'text', text: extra.join('\n\n') }] };
    return result;
  }

  // ------------------------------------------------------------- fleet tools

  status() {
    return this.#serial(async () => {
      if (!this.#entry) return { running: false };
      const alive = !this.#cdp?.closed && (await isChromeAlive(this.#entry));
      const tabs = alive ? await openTabUrls(this.#cdp).catch(() => []) : [];
      return {
        running: alive,
        id: this.#entry.id,
        state: this.#entry.state,
        allowedOrigins: this.#entry.allowedOrigins,
        strict: this.#entry.strict,
        headless: this.#entry.headless,
        viewport: this.#entry.viewport,
        channel: this.#entry.channel,
        tabs,
        uptimeSeconds: Math.round((Date.now() - this.#entry.createdAt) / 1000),
        blockedRequests: this.#blocks.length,
      };
    });
  }

  /** Relaunch with the same profile, cookies, storage and tabs, optionally switching headless. */
  restart({ headless } = {}) {
    return this.#serial(() => this.#restart({ headless }));
  }

  async #restart({ headless }) {
    if (!this.#entry) throw new Error('No browser is running in this session. Call browser_start first.');
    await this.#ensureReady();
    const allowlist = this.#entry.allowedOrigins;
    const tabs = await openTabUrls(this.#cdp);
    const storageOrigins = [...new Set(tabs.map((u) => new URL(u).origin))];
    const snapshot = await captureStorage(this.#cdp, { cookieAllowlist: null, storageOrigins });

    // No port = "starting" to everyone else: the reaper and prune leave the entry
    // (and the profile dir the new Chrome is about to use) alone.
    const previous = { ...this.#entry };
    this.#patch({ port: null, wsPath: null });
    await this.#stopUpstreamAndGuard();
    await closeChrome(previous, { cdp: this.#cdp });
    this.#cdp.close();

    const nextHeadless = headless ?? this.#entry.headless;
    const chrome = await this.#launchChrome(nextHeadless);
    this.#cdp = await CdpConnection.connect(browserWsUrl(chrome));
    await applyStorage(this.#cdp, snapshot);
    await this.#installGuard();
    this.#patch({ chromePid: chrome.pid, port: chrome.port, wsPath: chrome.wsPath, headless: nextHeadless, lastSeen: Date.now() });
    const reopen = tabs.filter((u) => checkUrl(allowlist, u).allowed);
    if (reopen.length) {
      const { targetInfos } = await this.#cdp.send('Target.getTargets');
      for (const url of reopen) await this.#cdp.send('Target.createTarget', { url });
      for (const t of targetInfos.filter((t) => t.type === 'page' && t.url === 'about:blank')) {
        await this.#cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      }
    }
    await this.#startUpstream();
    return { headless: nextHeadless, reopenedTabs: reopen.length };
  }

  stop() {
    return this.#serial(async () => {
      if (!this.#entry) return { stopped: false };
      const id = this.#entry.id;
      await this.#teardown({ keepBrowser: false });
      return { stopped: true, id };
    });
  }

  saveState(opts) {
    return this.#serial(() => this.#saveState(opts));
  }

  async #saveState({ name, allowedOrigins, overwrite = false, strict }) {
    if (!this.#entry) throw new Error('No browser is running in this session. Start one and log in first.');
    await this.#ensureReady();
    if (stateExists(name)) {
      const existing = summarizeState(readState(name));
      if (existing.createdBy === 'cli') {
        throw new Error(`State "${name}" was created by a person with \`devtools-fleet login\`; agents can't overwrite it. Pick another name.`);
      }
      if (!overwrite) throw new Error(`State "${name}" already exists. Pass overwrite: true to replace it.`);
    }
    const current = this.#entry.allowedOrigins;
    const open = await openOrigins(this.#cdp);
    const allow = allowedOrigins?.length ? normalizeOriginPatterns(allowedOrigins) : open.filter((o) => checkUrl(current, o).allowed);
    if (!allow.length) throw new Error('Nothing to save: no allowed http(s) page is open. Open the logged-in site first, or pass allowedOrigins.');
    if (current && !isSubset(allow, current)) {
      throw new Error(`allowedOrigins may only narrow this browser's allowlist (${current.join(', ')}), not widen it.`);
    }
    if (current && this.#entry.strict && strict === false) throw new Error('This browser runs in strict mode; a state saved from it stays strict.');
    const storageOrigins = [...new Set([
      ...allow.filter((p) => !p.includes('*')),
      ...open.filter((o) => allow.some((p) => patternMatchesOrigin(p, o))),
    ])];
    const snapshot = await captureStorage(this.#cdp, { cookieAllowlist: allow, storageOrigins });
    return writeState({
      name,
      cookies: snapshot.cookies,
      origins: snapshot.origins,
      allowedOrigins: allow,
      strict: strict ?? this.#entry.strict ?? false,
      createdBy: 'agent',
    });
  }

  // ------------------------------------------------------------- lifecycle

  async #stopUpstreamAndGuard() {
    this.#guardOff?.();
    this.#guardOff = null;
    await this.#upstream?.close();
    this.#upstream = null;
  }

  async #teardown({ keepBrowser }) {
    clearInterval(this.#heartbeat);
    await this.#stopUpstreamAndGuard().catch(() => {});
    const entry = this.#entry;
    if (entry && !keepBrowser) {
      await closeChrome(entry, { cdp: this.#cdp }).catch(() => {});
      removeEntry(entry.id);
      rmSync(entry.profileDir, { recursive: true, force: true });
    } else if (entry) {
      try {
        updateEntry(entry.id, { fleetPid: 0, lastSeen: Date.now() });
      } catch {
        // best effort on the way out
      }
    }
    this.#cdp?.close();
    this.#cdp = null;
    this.#entry = null;
  }

  /**
   * The MCP connection is going away (client reconnect, session end). Leave the
   * browser running for re-adoption; the reaper closes it if nobody comes back.
   */
  detach() {
    return this.#serial(async () => {
      if (this.#entry) await this.#teardown({ keepBrowser: true });
    });
  }
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}
