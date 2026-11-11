import { z } from 'zod';
import { listStates } from '../lib/states.js';
import { runChecks, formatChecks } from '../lib/doctor.js';

// devtools-fleet's own tools. Everything else the agent sees is
// chrome-devtools-mcp's, passed through with its original names.

const viewport = z.string().regex(/^\d{2,5}x\d{2,5}$/).describe('Window size, e.g. "1280x720"');

export const FLEET_TOOLS = [
  {
    name: 'browser_start',
    description:
      'Start this session\'s own Chrome (isolated from every other agent). Optional: the first browser tool call starts one with defaults anyway. ' +
      'Call it explicitly to load a saved login (`state`), to pick headless/viewport/channel, or to open a URL. ' +
      'A browser started from a state can only visit that state\'s allowed origins. ' +
      'If this session already had a browser before a reconnect, it is picked up again with its tabs.',
    schema: z.object({
      state: z.string().optional().describe('Name of a saved login state (see state_list)'),
      headless: z.boolean().optional().describe('Run without a window (default from config, normally true)'),
      viewport: viewport.optional(),
      channel: z.enum(['stable', 'beta', 'dev', 'canary']).optional(),
      url: z.string().url().optional().describe('Open this URL in the first tab'),
      allowedOrigins: z.array(z.string()).optional().describe('Without a state: restrict this browser to these origins, e.g. ["http://localhost:3000"]'),
    }).strict(),
    async handler(session, args) {
      const { adopted, alreadyRunning } = await session.start(args);
      const status = await session.status();
      const how = alreadyRunning ? 'Already running' : adopted ? 'Re-attached to this session\'s existing browser' : 'Started';
      return text(`${how}: ${describe(status)}`);
    },
  },
  {
    name: 'browser_status',
    description: 'Show this session\'s browser: id, saved state, allowlist, headless, open tabs, uptime.',
    schema: z.object({}).strict(),
    async handler(session) {
      const status = await session.status();
      return text(status.running ? describe(status) : 'No browser running in this session. Any browser tool call (or browser_start) starts one.');
    },
  },
  {
    name: 'browser_restart',
    description:
      'Relaunch this session\'s browser keeping cookies, localStorage and open tabs. Pass headless: false to get a visible window ' +
      '(e.g. so the person can solve a captcha or pass 2FA in it), headless: true to hide it again. Pages reload. ' +
      'If the person only wants to watch, browser_show is lighter: it doesn\'t reload anything.',
    schema: z.object({ headless: z.boolean().optional() }).strict(),
    async handler(session, args) {
      const { headless, reopenedTabs } = await session.restart(args);
      return text(`Restarted ${headless ? 'headless' : 'with a visible window'}; reopened ${reopenedTabs} tab(s). Page ids have changed: call list_pages.`);
    },
  },
  {
    name: 'browser_stop',
    description: 'Close this session\'s browser and delete its temporary profile.',
    schema: z.object({}).strict(),
    async handler(session) {
      const { stopped, id } = await session.stop();
      return text(stopped ? `Closed browser ${id}.` : 'No browser was running.');
    },
  },
  {
    name: 'state_save',
    description:
      'Save the current browser\'s login (cookies + localStorage) as a named state, so other sessions can start already logged in. ' +
      'Only cookies for the allowed origins are kept. allowedOrigins defaults to the http(s) origins open in tabs; ' +
      'it can never be wider than this browser\'s own allowlist. Can\'t overwrite a login a person made. ' +
      'For a fresh login by the person, use state_login instead: it opens the window and saves the result as theirs.',
    schema: z.object({
      name: z.string().describe('State name: letters, digits, . _ -'),
      allowedOrigins: z.array(z.string()).optional().describe('Origins this state may be used on, e.g. ["https://staging.example.com"]'),
      strict: z.boolean().optional().describe('Block every request (not just navigations) outside the allowlist when the state is used'),
      overwrite: z.boolean().optional(),
    }).strict(),
    async handler(session, args) {
      const s = await session.saveState(args);
      return text(`Saved state "${s.name}": ${s.cookies} cookie(s), localStorage for ${s.localStorageOrigins.length} origin(s). Allowed: ${s.allowedOrigins.join(', ')}${s.strict ? ' (strict)' : ''}.`);
    },
  },
  {
    name: 'state_list',
    description: 'List saved login states: name, allowed origins, cookie counts, when saved and when the first cookie expires. Never shows cookie values.',
    schema: z.object({}).strict(),
    async handler() {
      const states = listStates();
      if (!states.length) return text('No saved states. To create one, call state_login({ name, url }): it opens a window where the person logs in.');
      return text(states.map((s) => s.error
        ? `${s.name}: unreadable (${s.error})`
        : `${s.name}: ${s.allowedOrigins.join(', ')}${s.strict ? ' [strict]' : ''} | ${s.cookies} cookies (${s.expiredCookies} expired) | saved ${s.savedAt} by ${WHO[s.createdBy] ?? s.createdBy}`).join('\n') +
        '\nA state whose cookies have expired logs nobody in: call state_login({ name, url, overwrite: true }) so the person logs in again.');
    },
  },

  {
    name: 'state_login',
    description:
      'Have the person log in to a site so agents can use that login: opens a visible Chrome window at `url` for the person to log in by hand ' +
      '(passwords, 2FA, SSO, captchas all happen in that window). Use it whenever a task needs a login and state_list has no fitting state, ' +
      'or a state\'s cookies have expired (overwrite: true). You open the window; never type credentials yourself, and don\'t ask the person ' +
      'to run a terminal command for this. Then tell the person to log in and say when they\'re done, and call state_login_finish. ' +
      'Needs this session to have no browser running (browser_stop first).',
    schema: z.object({
      name: z.string().describe('State name: letters, digits, . _ -, e.g. "staging-admin"'),
      url: z.string().url().describe('Where the person starts, usually the login page'),
      allow: z.array(z.string()).optional().describe('Extra origins the state should work on, beyond where the login starts and ends'),
      strict: z.boolean().optional().describe('When the state is used, block every request outside its allowlist, not just navigations'),
      overwrite: z.boolean().optional().describe('Log in again over an existing state (a person-made one keeps its allowed origins)'),
    }).strict(),
    async handler(session, args) {
      const { id, url, refresh } = await session.stateLogin(args);
      return text(
        `A Chrome window (browser ${id}) is open at ${url}.\n` +
        `Tell the person: "Log in in the Chrome window that just opened (2FA and SSO are fine), then tell me when you're done." ` +
        `Wait for them; don't fill the form yourself.\n` +
        `Then call state_login_finish() to see which origins the login will be usable on, show that list to the person, ` +
        `and call state_login_finish({ confirm: true }) once they agree${refresh ? '' : ' (pass allowedOrigins if they want a different list)'}.`,
      );
    },
  },
  {
    name: 'state_login_finish',
    description:
      'Finish a state_login once the person says they have logged in. Without confirm: returns the proposed allowlist (where the login started and ended; ' +
      'origins only passed through, like an SSO provider, are left out so their session isn\'t handed to agents) for you to show the person. ' +
      'With confirm: true: saves the login as a state the person made, closes the window, and says how to use it.',
    schema: z.object({
      confirm: z.boolean().optional().describe('true once the person agreed to the allowed origins: save and close the window'),
      allowedOrigins: z.array(z.string()).optional().describe('Use these origins instead of the proposal, when the person asked for a different list'),
    }).strict(),
    async handler(session, args) {
      const r = await session.stateLoginFinish(args);
      const list = (o) => o.map((x) => `  ${x}`).join('\n');
      const lines = [];
      if (!r.saved) {
        lines.push(`State "${r.name}" would only be usable on:\n${list(r.allowedOrigins)}${r.strict ? '\n(strict: every other request blocked)' : ''}`);
        if (r.passedThrough.length) lines.push(`Visited during the login but left out:\n${list(r.passedThrough)}`);
        if (!r.landed.length) lines.push('Warning: no http(s) page is open in the window. Has the person finished logging in?');
        lines.push(r.refresh
          ? 'This is a login the person made before; its allowed origins stay the same. Call state_login_finish({ confirm: true }) to save.'
          : 'Show this to the person. When they agree, call state_login_finish({ confirm: true }), or pass allowedOrigins with the list they want.');
        return text(lines.join('\n\n'));
      }
      const s = r.summary;
      lines.push(`Saved state "${s.name}": ${s.cookies} cookie(s), localStorage for ${s.localStorageOrigins.length} origin(s). Usable on: ${s.allowedOrigins.join(', ')}${s.strict ? ' (strict)' : ''}. The login window (${r.closed}) is closed.`);
      if (s.cookies === 0) lines.push('Warning: no cookies were saved for these origins, so this state probably logs nobody in. Did the login finish?');
      lines.push(`To use it: browser_start({ state: "${s.name}", url: "<page>" }).`);
      return text(lines.join('\n'));
    },
  },
  {
    name: 'state_delete',
    description: 'Delete a saved state that an agent saved with state_save. Logins a person made can\'t be deleted by agents.',
    schema: z.object({ name: z.string() }).strict(),
    async handler(session, { name }) {
      session.deleteState(name);
      return text(`Deleted state "${name}".`);
    },
  },
  {
    name: 'browser_show',
    description:
      'Let the person watch this session\'s browser live, without disturbing it: opens Chrome DevTools with a screencast of a tab in the person\'s ' +
      'default browser, and returns the URL. Use it when the person asks to see or follow what you\'re doing. Works for headless browsers too. ' +
      'To let them type into the page (captcha, 2FA), use browser_restart({ headless: false }) instead.',
    schema: z.object({
      tab: z.number().int().positive().optional().describe('Which tab, 1-based in the order returned (default: the first web page)'),
      open: z.boolean().optional().describe('false: only return the URL, e.g. when the person is on another machine'),
    }).strict(),
    async handler(session, args) {
      const { url, opened, index, pages } = await session.show(args);
      const tabs = pages.map((p, i) => `${i + 1}. ${p.title || '(untitled)'}  ${p.url}`).join('\n');
      return text(`${tabs}\n\n${opened ? `Opened tab ${index} for the person to watch` : `Tab ${index} can be watched at this URL (nothing was opened here; give it to the person)`}:\n${url}\n` +
        'The URL only works on this machine (it points at 127.0.0.1).');
    },
  },
  {
    name: 'fleet_doctor',
    description: 'Check devtools-fleet\'s setup: Node, which Chrome it launches, chrome-devtools-mcp version, permissions, config file, saved states and browsers in use. Run it yourself when a browser won\'t start, before asking the person anything.',
    schema: z.object({}).strict(),
    async handler() {
      const results = runChecks();
      return text(`${formatChecks(results)}\n${results.every((r) => r.ok) ? 'All checks passed.' : 'Some checks failed; the FAIL lines say why.'}`);
    },
  },
];

const WHO = { cli: 'a person (CLI)', person: 'a person', agent: 'an agent' };

export function toolDefinitions() {
  return FLEET_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema, { target: 'draft-7' }),
  }));
}

export function findFleetTool(name) {
  return FLEET_TOOLS.find((t) => t.name === name);
}

function describe(s) {
  const lines = [
    `browser ${s.id}${s.state ? `, state "${s.state}"` : ''}, ${s.headless ? 'headless' : 'visible window'}${s.viewport ? `, ${s.viewport}` : ''}, ${s.channel}`,
    s.allowedOrigins ? `allowed origins: ${s.allowedOrigins.join(', ')}${s.strict ? ' (strict)' : ''}` : 'allowed origins: any',
    `tabs: ${s.tabs.length ? s.tabs.join(' | ') : 'none with a web page'}`,
    `uptime ${s.uptimeSeconds}s${s.blockedRequests ? `, ${s.blockedRequests} request(s) blocked so far` : ''}`,
  ];
  return lines.join('\n');
}

function text(value) {
  return { content: [{ type: 'text', text: value }] };
}
