import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { loadConfig } from './lib/config.js';
import { findSessionAnchor } from './lib/process-tree.js';
import { FleetSession } from './lib/session.js';
import { Upstream, UPSTREAM_VERSION } from './lib/upstream.js';
import { toolDefinitions, findFleetTool } from './tools/fleet-tools.js';

const { version } = createRequire(import.meta.url)('../package.json');

const INSTRUCTIONS = `devtools-fleet gives this session its own isolated Chrome with the full chrome-devtools-mcp toolset (${UPSTREAM_VERSION}).
- Any browser tool starts the browser on first use. Other agents have their own browsers; nothing is shared.
- To work logged in, call state_list, then browser_start({ state: "<name>" }). A person creates states with \`devtools-fleet login\`.
- A browser started from a state can only reach that state's allowed origins. Blocked navigations say so; don't try to work around them, ask the person.
- browser_restart({ headless: false }) shows a window, e.g. for the person to watch or solve a captcha.`;

export async function startServer() {
  const config = loadConfig();
  const anchor = findSessionAnchor();
  const session = new FleetSession(config, anchor);

  // Upstream's tool list, fetched once from a browserless child (~0.3s).
  const lister = await Upstream.start({ browserUrl: null, extraArgs: config.upstreamArgs });
  const upstreamTools = await lister.listTools();
  await lister.close();

  const fleetDefs = toolDefinitions();
  const clash = upstreamTools.find((t) => fleetDefs.some((f) => f.name === t.name));
  if (clash) throw new Error(`chrome-devtools-mcp now has a tool named "${clash.name}", which clashes with devtools-fleet. Please report this.`);
  const tools = [...fleetDefs, ...upstreamTools];

  const server = new Server(
    { name: 'devtools-fleet-mcp', version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  // Pass the client's workspace roots through to chrome-devtools-mcp (see upstream.js).
  server.oninitialized = () => {
    if (server.getClientCapabilities()?.roots) {
      session.setRootsProvider(async () => (await server.listRoots(undefined, { timeout: 5000 })).roots);
      server.setNotificationHandler(RootsListChangedNotificationSchema, async () => session.rootsChanged());
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const fleetTool = findFleetTool(name);
      if (fleetTool) {
        const parsed = fleetTool.schema.safeParse(args);
        if (!parsed.success) return errorResult(`Invalid arguments for ${name}: ${parsed.error.message}`);
        return await fleetTool.handler(session, parsed.data);
      }
      if (!upstreamTools.some((t) => t.name === name)) return errorResult(`Unknown tool: ${name}`);
      return await session.callUpstream(name, args);
    } catch (err) {
      return errorResult(err.message);
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Leave the browser running for re-adoption; the reaper handles the rest.
    await session.detach().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.stdin.on('close', shutdown);

  const transport = new StdioServerTransport();
  transport.onclose = shutdown;
  await server.connect(transport);
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}
