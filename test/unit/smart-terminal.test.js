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

test('inside tmux the tab is the one you are in, not the one tmux started from', () => {
  const gate = smartTerminalGate({ SMART_TERMINAL_GATE: gateFile(live), SMART_TERMINAL_TAB: 'TAB-1', TMUX: '/tmp/tmux,1,0' });
  assert.equal(gate.tab, '-');
});

test('a file left by a Smart Terminal that quit, a bad file, or opting out: no gate', () => {
  assert.equal(smartTerminalGate({ SMART_TERMINAL_GATE: gateFile({ ...live, pid: 999_999 }) }), null);
  assert.equal(smartTerminalGate({ SMART_TERMINAL_GATE: gateFile({ version: 2 }) }), null);
  assert.equal(smartTerminalGate({ SMART_TERMINAL_GATE: '/nonexistent/gate.json' }), null);
  assert.equal(smartTerminalGate({ SMART_TERMINAL_GATE: gateFile(live), DEVTOOLS_FLEET_SMART_TERMINAL: '0' }), null);
});
