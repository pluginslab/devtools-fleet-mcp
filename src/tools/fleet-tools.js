import { z } from 'zod';
import { listStates } from '../lib/states.js';

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
      '(e.g. so the human can watch or solve a captcha), headless: true to hide it again. Pages reload.',
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
      'it can never be wider than this browser\'s own allowlist. States a person created with `devtools-fleet login` cannot be overwritten.',
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
      if (!states.length) return text('No saved states. A person can create one with `devtools-fleet login <name> <url>`.');
      return text(states.map((s) => s.error
        ? `${s.name}: unreadable (${s.error})`
        : `${s.name}: ${s.allowedOrigins.join(', ')}${s.strict ? ' [strict]' : ''} | ${s.cookies} cookies (${s.expiredCookies} expired) | saved ${s.savedAt} by ${s.createdBy}`).join('\n'));
    },
  },
];

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
