import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeHome, cleanupHome, registry, FleetClient, runCli, startFixtures, waitFor, pageId, evalValue, sleep } from '../helpers/fleet.js';

// Acceptance tests 1-4 from SCOPE.md: isolation, the cap, re-adoption, reaping.
// Plus crash recovery and relaunch.

let home;
let fx;
before(async () => {
  home = makeHome();
  fx = await startFixtures();
});
after(async () => {
  await FleetClient.closeAll();
  cleanupHome(home);
  fx.close();
});

test('1+2. ten sessions in parallel each get their own browser; the eleventh hits the cap', async () => {
  const clients = await Promise.all(Array.from({ length: 10 }, () => FleetClient.start({ home })));
  try {
    const opened = await Promise.all(clients.map((c, i) => c.call('new_page', { url: `${fx.appOrigin}/page-${i}` })));
    opened.forEach((r, i) => assert.ok(!r.isError && r.text.includes(`/page-${i}`), `client ${i}: ${r.text}`));

    const lists = await Promise.all(clients.map((c) => c.call('list_pages')));
    lists.forEach((r, i) => {
      const own = [...new Set(r.text.match(/\/page-\d+/g) ?? [])];
      assert.deepEqual(own, [`/page-${i}`], `client ${i} sees only its own page`);
    });

    const ids = new Set(registry(home).map((e) => e.id));
    assert.equal(ids.size, 10);

    const eleventh = await FleetClient.start({ home });
    const r = await eleventh.call('new_page', { url: `${fx.appOrigin}/eleven` });
    assert.equal(r.isError, true);
    assert.match(r.text, /limit of 10 browsers/);
    assert.match(r.text, /devtools-fleet gc/);
    await eleventh.close();
  } finally {
    await Promise.all(clients.map((c) => c.call('browser_stop').catch(() => {})));
    await Promise.all(clients.map((c) => c.close()));
  }
  assert.equal(registry(home).length, 0, 'browser_stop deregisters');
});

test('3. a reconnect in the same session re-adopts the browser, tabs intact; another session does not', async () => {
  const env = { DEVTOOLS_FLEET_SESSION: 'readopt-a' };
  const first = await FleetClient.start({ home, env });
  await first.call('new_page', { url: `${fx.appOrigin}/kept-tab` });
  const [original] = registry(home);
  first.hardKill();
  await waitFor(() => registry(home).find((e) => e.id === original.id) && true, { what: 'entry to persist' });

  const second = await FleetClient.start({ home, env });
  const status = await second.call('list_pages');
  assert.match(status.text, /kept-tab/, 'tab survived the reconnect');
  assert.match(status.text, /reconnected to this session's existing browser/);
  assert.equal(registry(home).length, 1);
  assert.equal(registry(home)[0].id, original.id);

  const other = await FleetClient.start({ home, env: { DEVTOOLS_FLEET_SESSION: 'readopt-b' } });
  const otherPages = await other.call('list_pages');
  assert.doesNotMatch(otherPages.text, /kept-tab/);
  assert.equal(registry(home).length, 2);

  await other.call('browser_stop');
  await second.call('browser_stop');
  await other.close();
  await second.close();
});

test('4. the reaper closes orphans at once and detached browsers after the timeout', async () => {
  // Orphan: a session anchored on a real process that then exits.
  const { spawn } = await import('node:child_process');
  const anchor = spawn('sleep', ['300']);
  const orphanClient = await FleetClient.start({ home, env: { DEVTOOLS_FLEET_SESSION: 'reap-orphan' } });
  await orphanClient.call('new_page', { url: `${fx.appOrigin}/orphan` });
  const orphanEntry = registry(home).find((e) => e.anchorLabel === 'session:reap-orphan');
  // Re-point the entry at the sleep process, detach, then end the "session".
  const { updateEntry } = await importWithHome('../../src/lib/registry.js');
  orphanClient.hardKill();
  await sleep(300);
  updateEntry(orphanEntry.id, { anchorPid: anchor.pid, fleetPid: 0 });
  anchor.kill();
  await waitFor(() => anchor.exitCode !== null || anchor.signalCode, { what: 'anchor exit' });

  // Detached: session still alive, but idle past the timeout.
  const idleClient = await FleetClient.start({ home, env: { DEVTOOLS_FLEET_SESSION: 'reap-idle' } });
  await idleClient.call('new_page', { url: `${fx.appOrigin}/idle` });
  const idleEntry = registry(home).find((e) => e.anchorLabel === 'session:reap-idle');
  idleClient.hardKill();
  await sleep(300);
  updateEntry(idleEntry.id, { fleetPid: 0, lastSeen: Date.now() - 2 * 60_000 });

  const r = await runCli(home, ['gc'], { env: { DEVTOOLS_FLEET_ORPHAN_TIMEOUT_MINUTES: '1' } });
  assert.equal(r.code, 0, r.stderr);
  // The background reaper closes orphans at once, so it may beat gc to this one.
  const { readFileSync } = await import('node:fs');
  const reaperLog = (() => { try { return readFileSync(join(home, 'reaper.log'), 'utf8'); } catch { return ''; } })();
  assert.match(r.stdout + reaperLog, new RegExp(`${orphanEntry.id}\\s+owning session ended`));
  assert.match(r.stdout, new RegExp(`${idleEntry.id}\\s+detached for over 1 min`));
  assert.equal(registry(home).length, 0);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await waitFor(() => !alive(orphanEntry.chromePid) && !alive(idleEntry.chromePid), { what: 'chromes to exit' });
});

test('recovery: a crashed Chrome is replaced; a crashed chrome-devtools-mcp is restarted', async () => {
  const c = await FleetClient.start({ home });
  await c.call('new_page', { url: `${fx.appOrigin}/before-crash` });
  const [entry] = registry(home);

  process.kill(entry.chromePid, 'SIGKILL');
  await sleep(500);
  const afterChrome = await c.call('new_page', { url: `${fx.appOrigin}/after-crash` });
  assert.equal(afterChrome.isError, false, afterChrome.text);
  assert.match(afterChrome.text, /the browser had exited, so a fresh one was started/);
  assert.notEqual(registry(home)[0].id, entry.id);

  const { execFileSync } = await import('node:child_process');
  const upstreamPid = Number(execFileSync('pgrep', ['-P', String(c.pid), '-f', 'chrome-devtools-mcp'], { encoding: 'utf8' }).trim().split('\n')[0]);
  process.kill(upstreamPid, 'SIGKILL');
  await sleep(500);
  const afterUpstream = await c.call('list_pages');
  assert.equal(afterUpstream.isError, false, afterUpstream.text);
  assert.match(afterUpstream.text, /chrome-devtools-mcp had exited and was restarted/);
  assert.match(afterUpstream.text, /after-crash/, 'tabs unchanged');

  await c.call('browser_stop');
  await c.close();
});

test('browser_restart keeps session cookies, localStorage and tabs', async () => {
  const c = await FleetClient.start({ home });
  await c.call('new_page', { url: `${fx.appOrigin}/login` });
  let pages = await c.call('list_pages');
  const loginPage = pageId(pages.text, '/login');
  await c.call('evaluate_script', { pageId: loginPage, function: '() => { document.getElementById("u").value = "admin"; document.getElementById("p").value = "pw"; document.forms[0].submit(); return true }' });
  await sleep(800);
  await c.call('navigate_page', { pageId: loginPage, url: `${fx.appOrigin}/app` });
  const before = evalValue((await c.call('evaluate_script', { pageId: loginPage, function: '() => document.title' })).text);
  assert.equal(before, 'user=admin ls=from-login');

  const r = await c.call('browser_restart', { headless: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /reopened 1 tab/);
  pages = await c.call('list_pages');
  const appPage = pageId(pages.text, '/app');
  assert.ok(appPage, pages.text);
  const after = evalValue((await c.call('evaluate_script', { pageId: appPage, function: '() => document.title' })).text);
  assert.equal(after, 'user=admin ls=from-login', 'session cookie + localStorage survived the relaunch');

  await c.call('browser_stop');
  await c.close();
});

test('explicit options on a running browser are refused with a clear message', async () => {
  const c = await FleetClient.start({ home });
  await c.call('browser_start');
  const again = await c.call('browser_start', { headless: false });
  assert.equal(again.isError, true);
  assert.match(again.text, /already has a browser/);
  const plain = await c.call('browser_start');
  assert.match(plain.text, /Already running/);
  await c.call('browser_stop');
  await c.close();
});

test('a launch that hangs times out cleanly: error to the agent, nothing left running or registered', async () => {
  const { writeFileSync, chmodSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const fake = join(home, 'fake-chrome.sh');
  writeFileSync(fake, '#!/bin/sh\nexec sleep 120\n');
  chmodSync(fake, 0o755);
  const c = await FleetClient.start({ home, env: { DEVTOOLS_FLEET_CHROME_PATH: fake, DEVTOOLS_FLEET_LAUNCH_TIMEOUT_SECONDS: '2' } });
  const r = await c.call('new_page', { url: 'about:blank' });
  assert.equal(r.isError, true);
  assert.match(r.text, /did not open its debugging port within 2s/);
  assert.equal(registry(home).length, 0);
  const { execFileSync } = await import('node:child_process');
  const left = execFileSync('ps', ['-ax', '-o', 'args='], { encoding: 'utf8' }).split('\n').filter((l) => l.trim() === 'sleep 120');
  assert.deepEqual(left, [], 'fake chrome was killed');
  assert.equal(existsSync(join(home, 'profiles')) && (await import('node:fs')).readdirSync(join(home, 'profiles')).length, 0);
  await c.close();
});

test('parallel tool calls during browser_restart: no crash, no leaked browser', async () => {
  const c = await FleetClient.start({ home });
  await c.call('new_page', { url: `${fx.appOrigin}/parallel` });
  const results = await Promise.all([
    c.call('browser_restart', { headless: true }),
    c.call('list_pages'),
    c.call('take_snapshot', { pageId: 1 }).catch((e) => ({ isError: true, text: e.message })),
    c.call('list_pages'),
    c.call('browser_status'),
  ]);
  assert.equal(results[0].isError, false, results[0].text);
  const entries = registry(home);
  assert.equal(entries.length, 1, 'exactly one browser registered');
  const { execFileSync } = await import('node:child_process');
  const mains = execFileSync('ps', ['-ax', '-o', 'args='], { encoding: 'utf8' }).split('\n')
    .filter((l) => l.includes(`--user-data-dir=${entries[0].profileDir}`) && !l.includes('--type='));
  assert.equal(mains.length, 1, 'exactly one Chrome on that profile');
  const after = await c.call('list_pages');
  assert.match(after.text, /\/parallel/);
  await c.call('browser_stop');
  await c.close();
});

test('explicit options are never dropped by re-adopting a detached browser', async () => {
  const env = { DEVTOOLS_FLEET_SESSION: 'explicit-adopt' };
  const first = await FleetClient.start({ home, env });
  await first.call('new_page', { url: `${fx.appOrigin}/unrestricted` });
  const [loose] = registry(home);
  first.hardKill();
  await sleep(300);
  const second = await FleetClient.start({ home, env });
  const started = await second.call('browser_start', { allowedOrigins: [fx.appOrigin] });
  assert.equal(started.isError, false, started.text);
  assert.match(started.text, /^Started/);
  assert.match(started.text, new RegExp(`allowed origins: ${fx.appOrigin}`));
  const blocked = await second.call('new_page', { url: `${fx.outsideOrigin}/x` });
  assert.equal(blocked.isError, true);
  await second.call('browser_stop');
  await second.close();
  await runCli(home, ['kill', loose.id]);
});

test('workspace roots reach chrome-devtools-mcp; the fleet home stays off limits', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const project = mkdtempSync(join(process.env.HOME, '.fleet-test-project-'));
  try {
    const c = await FleetClient.start({ home, roots: [project] });
    await c.call('new_page', { url: `${fx.appOrigin}/shot` });
    const shot = await c.call('take_screenshot', { pageId: 2, filePath: join(project, 'shot.png') });
    assert.equal(shot.isError, false, shot.text);
    assert.ok(existsSync(join(project, 'shot.png')));
    const sneaky = await c.call('take_screenshot', { pageId: 2, filePath: join(home, 'states', 'x.png') });
    assert.equal(sneaky.isError, true);
    assert.match(sneaky.text, /holds saved logins/);
    const readState = await c.call('navigate_page', { pageId: 2, url: `file://${home}/states/anything.json` });
    assert.equal(readState.isError, true);
    assert.match(readState.text, /holds saved logins/);
    await c.call('browser_stop');
    await c.close();
    assert.ok(tmpdir());
  } finally {
    (await import('node:fs')).rmSync(project, { recursive: true, force: true });
  }
});

async function importWithHome(path) {
  process.env.DEVTOOLS_FLEET_HOME = home;
  return import(`${path}?home=${encodeURIComponent(home)}`);
}
