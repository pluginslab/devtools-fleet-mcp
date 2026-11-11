#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { PATHS, loadConfig } from '../src/lib/config.js';
import { listEntries, readEntry, removeEntry, classify } from '../src/lib/registry.js';
import { isChromeAlive, listPages, inspectorUrl, resolveChromePath } from '../src/lib/chrome.js';
import { reapOnce, closeEntryBrowser } from '../src/lib/reaper.js';
import { listStates, readState, summarizeState, deleteState, importState } from '../src/lib/states.js';
import { login } from '../src/lib/login.js';
import { UPSTREAM_VERSION } from '../src/lib/upstream.js';
import { withLock } from '../src/lib/lock.js';

const { version } = createRequire(import.meta.url)('../package.json');
const program = new Command();

program
  .name('devtools-fleet')
  .description('See and manage the Chrome browsers devtools-fleet-mcp runs for your agents, and the login states they use.')
  .version(`${version} (chrome-devtools-mcp ${UPSTREAM_VERSION})`);

// ------------------------------------------------------------------ browsers

program
  .command('ls')
  .description('List every fleet browser')
  .option('--json', 'machine-readable output')
  .action(async ({ json }) => {
    const rows = [];
    for (const e of listEntries()) {
      const alive = await isChromeAlive(e);
      const pages = alive ? await listPages(e).catch(() => []) : [];
      rows.push({
        id: e.id,
        kind: e.kind,
        status: alive ? classify(e) : 'dead',
        session: `${e.anchorLabel ?? '?'}${e.anchorPid ? `:${e.anchorPid}` : ''}`,
        state: e.state ?? null,
        allowedOrigins: e.allowedOrigins,
        mode: e.headless ? 'headless' : 'window',
        tabs: pages.filter((p) => /^https?:/.test(p.url)).map((p) => p.url),
        cwd: e.cwd,
        idleSeconds: Math.round((Date.now() - e.lastSeen) / 1000),
        port: e.port,
      });
    }
    if (json) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) return console.log('No fleet browsers running.');
    table(rows.map((r) => ({
      ID: r.id,
      STATUS: r.status,
      SESSION: r.session,
      STATE: r.state ?? '-',
      MODE: r.mode,
      TAB: r.tabs[0] ? truncate(r.tabs[0], 50) + (r.tabs.length > 1 ? ` (+${r.tabs.length - 1})` : '') : '-',
      CWD: truncate(r.cwd ?? '', 40),
    })));
  });

program
  .command('kill')
  .description('Close fleet browsers')
  .argument('[ids...]', 'browser ids from `ls`')
  .option('--all', 'close every fleet browser')
  .action(async (ids, { all }) => {
    if (!all && !ids.length) fail('Pass one or more ids, or --all.');
    const targets = all ? listEntries() : ids.map((id) => readEntry(id) ?? fail(`No browser with id ${id}`));
    // Deregister under the lock so nothing re-adopts them, then close.
    const claimed = await withLock('registry', async () => targets.map((t) => readEntry(t.id)).filter(Boolean).map((e) => { removeEntry(e.id); return e; }));
    for (const e of claimed) {
      await closeEntryBrowser(e);
      console.log(`closed ${e.id}${e.chromePid ? '' : ' (it had no Chrome yet)'}`);
    }
  });

program
  .command('gc')
  .description('Close orphaned browsers now (sessions that ended), and detached ones past the timeout')
  .option('--detached', 'also close browsers whose MCP connection dropped, without waiting for the timeout')
  .action(async ({ detached }) => {
    const config = loadConfig();
    const actions = await reapOnce({ orphanTimeoutMinutes: config.orphanTimeoutMinutes, closeDetached: detached });
    if (!actions.length) return console.log('Nothing to clean up.');
    for (const { id, action } of actions) console.log(`${id}  ${action}`);
  });

program
  .command('show')
  .description("Watch a browser live: opens Chrome's DevTools inspector with a screencast of the page. Doesn't disturb the agent")
  .argument('<id>', 'browser id from `ls`')
  .option('--tab <n>', 'which tab (1-based, from the list printed)', (v) => Number(v))
  .option('--print', 'print the URL instead of opening it')
  .action(async (id, { tab, print }) => {
    const e = readEntry(id) ?? fail(`No browser with id ${id}`);
    if (!(await isChromeAlive(e))) fail(`Browser ${id} is not running.`);
    const pages = await listPages(e);
    if (!pages.length) fail(`Browser ${id} has no open tabs.`);
    pages.forEach((p, i) => console.log(`${i + 1}. ${p.title || '(untitled)'}  ${p.url}`));
    const index = tab ? tab - 1 : Math.max(0, pages.findIndex((p) => /^https?:/.test(p.url)));
    const page = pages[index] ?? fail(`No tab ${tab}.`);
    const url = inspectorUrl(e, page.id);
    if (print) return console.log(url);
    console.log(`\nOpening tab ${index + 1} in your default browser:\n${url}`);
    openInBrowser(url);
  });

// -------------------------------------------------------------------- states

program
  .command('login')
  .description('Open a visible browser, log in by hand, and save the session as a named state agents can use')
  .argument('<name>', 'state name, e.g. staging-admin')
  .argument('<url>', 'where to start, e.g. https://staging.example.com/login')
  .option('--allow <origin...>', 'extra origins the state may be used on (visited origins are added automatically)')
  .option('--strict', 'when used, block every request outside the allowlist, not just navigations')
  .option('--overwrite', 'replace an existing state')
  .option('-y, --yes', 'save without confirming the allowlist')
  .option('--headless', 'no window (for scripted logins and tests)')
  .action(async (name, url, opts) => {
    await login({ name, url, allow: opts.allow ?? [], strict: Boolean(opts.strict), overwrite: Boolean(opts.overwrite), yes: Boolean(opts.yes), headless: Boolean(opts.headless), config: loadConfig() });
    process.exit(0);
  });

program
  .command('states')
  .description('List saved login states (never shows cookie values)')
  .option('--json', 'machine-readable output')
  .action(({ json }) => {
    const states = listStates();
    if (json) return console.log(JSON.stringify(states, null, 2));
    if (!states.length) return console.log('No saved states. Create one with `devtools-fleet login <name> <url>`.');
    table(states.map((s) => s.error ? { NAME: s.name, ORIGINS: `unreadable: ${s.error}` } : {
      NAME: s.name,
      ORIGINS: s.allowedOrigins.join(', ') + (s.strict ? ' [strict]' : ''),
      COOKIES: `${s.cookies}${s.expiredCookies ? ` (${s.expiredCookies} expired)` : ''}`,
      SAVED: s.savedAt.slice(0, 16).replace('T', ' '),
      BY: s.createdBy,
    }));
  });

const state = program.command('state').description('Manage one saved state');

state
  .command('show')
  .argument('<name>')
  .description('Metadata for a state (never cookie values)')
  .action((name) => console.log(JSON.stringify(summarizeState(readState(name)), null, 2)));

state
  .command('rm')
  .argument('<name>')
  .description('Delete a state')
  .action((name) => {
    deleteState(name);
    console.log(`Deleted state "${name}".`);
  });

state
  .command('import')
  .argument('<name>')
  .argument('<file>', 'a Playwright / agent-browser storageState JSON file')
  .requiredOption('--allow <origin...>', 'origins the state may be used on')
  .option('--strict', 'block every request outside the allowlist, not just navigations')
  .description('Import a storageState file as a fleet state')
  .action((name, file, { allow, strict }) => {
    const { summary, droppedCookies } = importState({ name, file, allowedOrigins: allow, strict: Boolean(strict) });
    console.log(`Imported "${summary.name}": ${summary.cookies} cookie(s)${droppedCookies ? `, ${droppedCookies} dropped (outside the allowlist)` : ''}.`);
  });

// --------------------------------------------------------------------- misc

program
  .command('doctor')
  .description('Check Chrome, Node, permissions and configuration')
  .action(async () => {
    let ok = true;
    const check = (label, fn) => {
      try {
        const detail = fn();
        console.log(`ok    ${label}${detail ? `: ${detail}` : ''}`);
      } catch (err) {
        ok = false;
        console.log(`FAIL  ${label}: ${err.message}`);
      }
    };
    let config;
    check('config', () => { config = loadConfig(); return PATHS.config; });
    check('node', () => {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 12)) throw new Error(`${process.versions.node}; need 22.12 or newer`);
      return process.versions.node;
    });
    if (config) check(`chrome (${config.channel})`, () => resolveChromePath(config));
    check('chrome-devtools-mcp', () => UPSTREAM_VERSION);
    check('fleet home', () => {
      try {
        const mode = statSync(PATHS.home).mode & 0o777;
        if (mode & 0o077) throw new Error(`${PATHS.home} is readable by others (mode ${mode.toString(8)}); run chmod 700`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return `${PATHS.home} (created on first use)`;
      }
      return PATHS.home;
    });
    check('states', () => `${listStates().length} saved`);
    check('browsers', () => `${listEntries().length} registered`);
    process.exitCode = ok ? 0 : 1;
  });

program
  .command('config')
  .description('Print the effective configuration and where it comes from')
  .action(() => {
    console.log(`config file: ${PATHS.config}`);
    console.log(`fleet home:  ${PATHS.home}`);
    console.log(JSON.stringify(loadConfig(), null, 2));
  });

program.parseAsync().catch((err) => fail(err.message));

// -------------------------------------------------------------------- helpers

function fail(message) {
  console.error(`devtools-fleet: ${message}`);
  process.exit(1);
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function table(rows) {
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(cols));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

function openInBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
