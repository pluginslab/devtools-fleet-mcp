import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smartTerminalGate } from '../../src/lib/smart-terminal.js';

function gateFile(info) {
  const file = join(mkdtempSync(join(tmpdir(), 'st-gate-')), 'chromium-gate.json');
  writeFileSync(file, JSON.stringify(info));
  return file;
}

const live = { version: 1, url: 'http://127.0.0.1:5000', token: 't', pid: process.pid };

test('outside Smart Terminal there is no gate', () => {
  assert.equal(smartTerminalGate({}), null);
});

test('inside a tab: the gate, for that tab', () => {
  const gate = smartTerminalGate({ SMART_TERMINAL_GATE: gateFile(live), SMART_TERMINAL_TAB: 'TAB-1' });
  assert.deepEqual(gate, { url: live.url, token: 't', pid: process.pid, tab: 'TAB-1' });
});

// A fake tmux: the session the pane is in, and that session's own environment.
const fakeTmux = (session, sessionTab) => (args) => {
  if (args.includes('display-message')) return `${session}\n`;
  if (args.includes('show-environment')) {
    if (sessionTab === undefined) throw new Error('unknown variable: SMART_TERMINAL_TAB');
    return `SMART_TERMINAL_TAB=${sessionTab}\n`;
  }
  throw new Error(`unexpected tmux ${args.join(' ')}`);
};
const inTmux = { SMART_TERMINAL_TAB: 'TAB-OF-THE-SERVER', TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' };

test('inside tmux: the tab the session was started for, never the one that started the server', () => {
  const gate = smartTerminalGate({ SMART_TERMINAL_GATE: gateFile(live), ...inTmux }, fakeTmux('DevWork', 'TAB-2'));
  assert.equal(gate.tab, 'TAB-2');
  assert.deepEqual(gate.tmux, { socket: '/tmp/tmux-501/default', session: 'DevWork' });
});

test('inside tmux, a session without a tab: Smart Terminal finds the tab by the session', () => {
  const gate = smartTerminalGate({ SMART_TERMINAL_GATE: gateFile(live), ...inTmux }, fakeTmux('old', undefined));
  assert.equal(gate.tab, '-');
  assert.deepEqual(gate.tmux, { socket: '/tmp/tmux-501/default', session: 'old' });
});

test('inside tmux with tmux not answering: the tab you are in', () => {
  const gate = smartTerminalGate({ SMART_TERMINAL_GATE: gateFile(live), ...inTmux }, () => { throw new Error('no server'); });
  assert.equal(gate.tab, '-');
  assert.equal(gate.tmux, undefined);
});

test('a file left by a Smart Terminal that quit, a bad file, or opting out: no gate', () => {
  assert.equal(smartTerminalGate({ SMART_TERMINAL_GATE: gateFile({ ...live, pid: 999_999 }) }), null);
  assert.equal(smartTerminalGate({ SMART_TERMINAL_GATE: gateFile({ version: 2 }) }), null);
  assert.equal(smartTerminalGate({ SMART_TERMINAL_GATE: '/nonexistent/gate.json' }), null);
  assert.equal(smartTerminalGate({ SMART_TERMINAL_GATE: gateFile(live), DEVTOOLS_FLEET_SMART_TERMINAL: '0' }), null);
});
