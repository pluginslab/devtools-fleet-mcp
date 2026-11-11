import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, cleanupHome, registry, FleetClient, runCli, spawnCli, startFixtures, waitFor, pageId, evalValue, sleep } from '../helpers/fleet.js';
import { CdpConnection } from '../../src/lib/cdp.js';

// Acceptance tests 5-8 from SCOPE.md: login → state → logged-in agents,
// the allowlist, no secrets in listings, and what agents may not do.

let home;
let fx;
let sid;

before(async () => {
  home = makeHome();
  fx = await startFixtures();
});
after(async () => {
  await FleetClient.closeAll();
  cleanupHome(home);
  fx.close();
});

/** Drive `devtools-fleet login` the way a person would, through the browser it opens. */
async function scriptedLogin(name, extraArgs = []) {
  const cli = spawnCli(home, ['login', name, `${fx.appOrigin}/login`, '--headless', '--yes', ...extraArgs]);
  const entry = await waitFor(() => registry(home).find((e) => e.kind === 'login' && e.state === name && e.port), { what: 'login browser' });
  await waitFor(() => cli.out.includes('press Enter'), { what: 'login prompt' });
  const version = await (await fetch(`http://127.0.0.1:${entry.port}/json/version`)).json();
  const cdp = await CdpConnection.connect(version.webSocketDebuggerUrl);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && t.url.includes('/login'));
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("u").value = "admin"; document.getElementById("p").value = "pw"; document.forms[0].submit()' }, sessionId);
  await waitFor(async () => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId);
    return result.value === 'WELCOME';
  }, { what: 'login to complete' });
  cdp.close();
  cli.stdin.write('\n');
  const code = await cli.done;
  return { code, out: cli.out };
}

test('5a. devtools-fleet login saves a state from a real login', async () => {
  const { code, out } = await scriptedLogin('fixture-admin');
  assert.equal(code, 0, out);
  assert.match(out, /Saved state "fixture-admin": 1 cookie\(s\), localStorage for 1 origin/);
  assert.equal(registry(home).length, 0, 'login browser is closed and deregistered');
  sid = JSON.parse(readFileSync(join(home, 'states', 'fixture-admin.json'), 'utf8')).cookies[0].value;
  assert.ok(sid && fx.sessions.has(sid));
});

test('5b. an agent started from the state is logged in, and the site was not contacted to restore it', async () => {
  const hitsBefore = { ...fx.app.hits };
  const c = await FleetClient.start({ home });
  const started = await c.call('browser_start', { state: 'fixture-admin', url: `${fx.appOrigin}/app` });
  assert.equal(started.isError, false, started.text);
  assert.match(started.text, /state "fixture-admin"/);
  await sleep(500);
  const pages = await c.call('list_pages');
  const title = evalValue((await c.call('evaluate_script', { pageId: pageId(pages.text, '/app'), function: '() => document.title' })).text);
  assert.equal(title, 'user=admin ls=from-login');
  assert.equal(fx.app.hits['/__devtools_fleet__'], undefined, 'storage restore never reached the server');
  assert.equal((fx.app.hits['/app'] ?? 0) - (hitsBefore['/app'] ?? 0), 1);
  await c.call('browser_stop');
  await c.close();
});

test('5c. several agents use the same state at once', async () => {
  const clients = await Promise.all([1, 2, 3].map(() => FleetClient.start({ home })));
  try {
    await Promise.all(clients.map((c) => c.call('browser_start', { state: 'fixture-admin', url: `${fx.appOrigin}/app` })));
    await sleep(500);
    for (const c of clients) {
      const pages = await c.call('list_pages');
      const title = evalValue((await c.call('evaluate_script', { pageId: pageId(pages.text, '/app'), function: '() => document.title' })).text);
      assert.equal(title, 'user=admin ls=from-login');
    }
    assert.equal(new Set(registry(home).map((e) => e.id)).size, 3);
  } finally {
    await Promise.all(clients.map(async (c) => { await c.call('browser_stop'); await c.close(); }));
  }
});

test('6. the allowlist blocks typed URLs, clicks and popups; strict also blocks fetch()', async () => {
  const c = await FleetClient.start({ home });
  await c.call('browser_start', { state: 'fixture-admin', url: `${fx.appOrigin}/app` });
  await sleep(500);

  const typed = await c.call('new_page', { url: `${fx.outsideOrigin}/typed` });
  assert.equal(typed.isError, true);
  assert.match(typed.text, /is blocked\. .* is not in this browser's allowlist \(state "fixture-admin"\): http/);

  let pages = await c.call('list_pages');
  const app = pageId(pages.text, '/app');
  const clicked = await c.call('evaluate_script', { pageId: app, function: '() => { document.getElementById("out").click(); return true }' });
  await sleep(700);
  const popup = await c.call('evaluate_script', { pageId: app, function: `() => { window.open("${fx.outsideOrigin}/popup"); return true }` });
  await sleep(700);
  assert.match(clicked.text + popup.text, /devtools-fleet blocked \d+ request\(s\) outside the allowlist/);
  assert.equal(fx.outside.hits['/typed'], undefined);
  assert.equal(fx.outside.hits['/clicked'], undefined);
  assert.equal(fx.outside.hits['/popup'], undefined);

  // Non-strict: a background fetch still leaves (navigations only).
  await c.call('navigate_page', { pageId: app, url: `${fx.appOrigin}/beacon` });
  await sleep(700);
  assert.equal(fx.outside.hits['/fetched'], 1, 'non-strict lets fetch() through');
  await c.call('browser_stop');

  // Strict: the same fetch is blocked.
  const imported = await runCli(home, ['state', 'import', 'fixture-strict', join(home, 'states', 'fixture-admin.json'), '--allow', fx.appOrigin, '--strict']);
  assert.equal(imported.code, 0, imported.stderr);
  await c.call('browser_start', { state: 'fixture-strict', url: `${fx.appOrigin}/beacon` });
  await sleep(1000);
  pages = await c.call('list_pages');
  const title = evalValue((await c.call('evaluate_script', { pageId: pageId(pages.text, '/beacon'), function: '() => document.title' })).text);
  assert.equal(title, 'fetch-blocked');
  assert.equal(fx.outside.hits['/fetched'], 1, 'strict stopped the second fetch');
  await c.call('browser_stop');
  await c.close();
});

test('strict: WebSockets and a detached browser are locked down by Chrome itself', async () => {
  const env = { DEVTOOLS_FLEET_SESSION: 'strict-lock' };
  const c = await FleetClient.start({ home, env });
  const started = await c.call('browser_start', { state: 'fixture-strict', url: `${fx.appOrigin}/app` });
  assert.equal(started.isError, false, started.text);
  await sleep(700);
  const pages = await c.call('list_pages');
  const app = pageId(pages.text, '/app');
  const ws = async (url) => evalValue((await c.call('evaluate_script', { pageId: app, function: `() => new Promise((res) => { const w = new WebSocket(${JSON.stringify(url)}); w.onopen = () => res('open'); w.onerror = () => res('blocked'); setTimeout(() => res('timeout'), 3000) })` })).text);
  assert.equal(await ws(`${fx.appOrigin.replace('http', 'ws')}/ws-ok`), 'open', 'own origin still works');
  assert.equal(await ws(`${fx.outsideOrigin.replace('http', 'ws')}/ws-out`), 'blocked');
  assert.equal(fx.outside.hits['WS /ws-out'], undefined);

  // Plant a timer, then drop the agent: nothing fleet-side is connected any more.
  await c.call('evaluate_script', { pageId: app, function: `() => { setInterval(() => { fetch(${JSON.stringify(`${fx.outsideOrigin}/detached-fetch`)}, { mode: 'no-cors' }).catch(() => {}); new WebSocket(${JSON.stringify(`${fx.outsideOrigin.replace('http', 'ws')}/detached-ws`)}) }, 300); setTimeout(() => { location = ${JSON.stringify(`${fx.outsideOrigin}/detached-nav`)} }, 1500); return 1 }` });
  c.hardKill();
  await sleep(2500);
  for (const path of ['/detached-fetch', 'WS /detached-ws', '/detached-nav']) {
    assert.equal(fx.outside.hits[path], undefined, `${path} reached the outside server while detached`);
  }
  const [entry] = registry(home).filter((e) => e.anchorLabel === 'session:strict-lock');
  await runCli(home, ['kill', entry.id]);
});

test('7. no listing ever shows cookie values', async () => {
  const c = await FleetClient.start({ home });
  const list = await c.call('state_list');
  assert.match(list.text, /fixture-admin/);
  assert.ok(!list.text.includes(sid));
  await c.close();
  for (const args of [['states'], ['states', '--json'], ['state', 'show', 'fixture-admin'], ['ls', '--json']]) {
    const r = await runCli(home, args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.ok(!r.stdout.includes(sid), `${args.join(' ')} leaked the session cookie`);
  }
});

test('agents may narrow but never widen an allowlist, and never overwrite a person\'s state', async () => {
  const c = await FleetClient.start({ home });
  await c.call('browser_start', { state: 'fixture-admin', url: `${fx.appOrigin}/app` });
  await sleep(500);

  const widen = await c.call('state_save', { name: 'wider', allowedOrigins: [fx.appOrigin, fx.outsideOrigin] });
  assert.equal(widen.isError, true);
  assert.match(widen.text, /may only narrow/);

  const overwrite = await c.call('state_save', { name: 'fixture-admin', overwrite: true });
  assert.equal(overwrite.isError, true);
  assert.match(overwrite.text, /created by a person/);

  const copy = await c.call('state_save', { name: 'agent-copy' });
  assert.equal(copy.isError, false, copy.text);
  assert.match(copy.text, /Saved state "agent-copy": 1 cookie/);
  const again = await c.call('state_save', { name: 'agent-copy' });
  assert.match(again.text, /already exists/);
  assert.equal((await c.call('state_save', { name: 'agent-copy', overwrite: true })).isError, false);
  assert.equal(fx.app.hits['/__devtools_fleet__'], undefined, 'saving never reached the server either');

  const both = await c.call('browser_stop');
  assert.match(both.text, /Closed/);
  const conflicting = await c.call('browser_start', { state: 'fixture-admin', allowedOrigins: [fx.outsideOrigin] });
  assert.equal(conflicting.isError, true);
  assert.match(conflicting.text, /one or the other/);
  const missing = await c.call('browser_start', { state: 'does-not-exist' });
  assert.match(missing.text, /No state named "does-not-exist"/);
  await c.close();
});

test('an agent can restrict itself without a state', async () => {
  const c = await FleetClient.start({ home });
  const r = await c.call('browser_start', { allowedOrigins: [fx.appOrigin] });
  assert.match(r.text, new RegExp(`allowed origins: ${fx.appOrigin}`));
  const blocked = await c.call('new_page', { url: `${fx.outsideOrigin}/self` });
  assert.equal(blocked.isError, true);
  await c.call('browser_stop');
  await c.close();
});

test('no second browser context in a browser with an allowlist', async () => {
  const c = await FleetClient.start({ home });
  await c.call('browser_start', { state: 'fixture-admin', url: `${fx.appOrigin}/app` });
  const viaTool = await c.call('new_page', { url: `${fx.appOrigin}/app`, isolatedContext: 'x' });
  assert.equal(viaTool.isError, true);
  assert.match(viaTool.text, /isolatedContext is not available/);

  // Second layer: a context created behind fleet's back is closed on sight.
  const [entry] = registry(home);
  const version = await (await fetch(`http://127.0.0.1:${entry.port}/json/version`)).json();
  const cdp = await CdpConnection.connect(version.webSocketDebuggerUrl);
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const { targetId } = await cdp.send('Target.createTarget', { url: `${fx.outsideOrigin}/foreign`, browserContextId });
  await sleep(1000);
  const { targetInfos } = await cdp.send('Target.getTargets');
  assert.equal(targetInfos.some((t) => t.targetId === targetId), false, 'foreign-context page was closed');
  cdp.close();
  await c.call('browser_stop');
  await c.close();
});

test('login keeps pass-through origins (SSO) out of the state by default', async () => {
  const cli = spawnCli(home, ['login', 'sso-app', `${fx.appOrigin}/sso-start`, '--headless', '--yes']);
  const entry = await waitFor(() => registry(home).find((e) => e.kind === 'login' && e.state === 'sso-app' && e.port), { what: 'login browser' });
  await waitFor(() => cli.out.includes('press Enter'), { what: 'login prompt' });
  const version = await (await fetch(`http://127.0.0.1:${entry.port}/json/version`)).json();
  const cdp = await CdpConnection.connect(version.webSocketDebuggerUrl);
  await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.some((t) => t.type === 'page' && t.url.endsWith('/login')), { what: 'SSO round trip' });
  cdp.close();
  cli.stdin.write('\n');
  assert.equal(await cli.done, 0, cli.out);
  assert.match(cli.out, new RegExp(`Also visited during login, not included[^\\n]*\\n\\s+${fx.outsideOrigin.replace(/[.]/g, '\\.')}`));
  const saved = JSON.parse(readFileSync(join(home, 'states', 'sso-app.json'), 'utf8'));
  assert.deepEqual(saved.devtoolsFleet.allowedOrigins, [fx.appOrigin]);
  assert.ok(!JSON.stringify(saved).includes('SSO-SECRET'), 'the SSO provider\'s cookie was not saved');
});

test('login refuses to overwrite without --overwrite', async () => {
  const r = await runCli(home, ['login', 'fixture-admin', `${fx.appOrigin}/login`, '--headless', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already exists/);
});
