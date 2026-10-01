<!-- TODO: banner at assets/banner.jpg, same style as the WordPress trio, then restore:
<p align="center">
  <img src="assets/banner.jpg" alt="devtools-fleet-mcp banner" />
</p>
-->

**Give every one of your AI agents its own Chrome, running Google's full DevTools toolset, already logged in, and fenced to the sites it should touch.**

## Why This Exists

Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) is the best browser toolset an agent can have when the job is *debugging* a web app: console, network, performance traces, Lighthouse, heap snapshots. It stops working the moment you run more than one agent:

- Agent two starts → `The browser is already running for …`, because every server shares one Chrome profile
- Switch on `--isolated` → every agent starts logged out and fights the wp-admin, staging or SSO login again, every time
- The MCP connection drops → the browser, its tabs and its login die with it
- Ten agents are running → ten invisible headless Chromes. Nothing lists them, nothing cleans up after a crash

Other multi-agent browser tools solve pooling and logins, but on Playwright or through a browser extension. None of them carries Google's DevTools toolset.

## The Solution

`devtools-fleet-mcp` sits in front of chrome-devtools-mcp and manages the browsers. It doesn't reimplement a single browser tool: Google's tools are passed through unchanged, under the same names.

```
agent session A ─stdio─▶ devtools-fleet-mcp ─▶ chrome-devtools-mcp --browserUrl ─CDP─▶ Chrome A (own profile)
agent session B ─stdio─▶ devtools-fleet-mcp ─▶ chrome-devtools-mcp --browserUrl ─CDP─▶ Chrome B (own profile)
                               │
                               └──▶ ~/.devtools-fleet/  ◀── devtools-fleet CLI: ls, show, kill, gc, login, states
```

1. **One browser per agent, zero config.** The first browser tool call launches that session's own Chrome. Up to 10 at once by default.
2. **Browsers outlive the connection.** An agent that reconnects inside the same session gets its browser back, tabs open. A small background reaper closes the browsers nobody comes back for.
3. **Saved logins.** You log in once, by hand, in a real window (2FA, SSO and captchas are fine). Any number of agents can then start from that login in parallel, each in its own browser.
4. **Origin allowlists.** A browser started from a saved login can only reach that login's origins. Typed URLs, link clicks, redirects and popups elsewhere are blocked. Strict mode locks the whole network in Chrome itself.
5. **Recovery.** If Chrome or chrome-devtools-mcp dies, the next tool call brings it back and tells the agent what happened.
6. **Watch any agent live.** `devtools-fleet show <id>` opens Chrome's DevTools inspector on that agent's page without disturbing it.

## Quick Start

Requires **Node.js 22.12+** and **Google Chrome** (or point `chromePath` at another Chromium build).

### Install as a Claude Code plugin (recommended)

The plugin installs the MCP server **and** a skill that teaches agents the fleet workflow: check `state_list`, start from a saved login, respect the allowlist, recover after a crash.

Inside Claude Code:

```
/plugin marketplace add pluginslab/devtools-fleet-mcp
/plugin install devtools-fleet@pluginslab-devtools-fleet
```

Or from your terminal:

```bash
claude plugin marketplace add pluginslab/devtools-fleet-mcp
claude plugin install devtools-fleet@pluginslab-devtools-fleet
```

Restart Claude Code and check that `devtools-fleet` shows up under `/mcp`.

**Already using chrome-devtools-mcp?** Remove it (`claude mcp remove chrome-devtools`, or disable its plugin). devtools-fleet exposes the same tools under the same names, and two servers with identical tool names confuse agents.

**Updating:** `/plugin marketplace update pluginslab-devtools-fleet`, then restart. The server runs through `npx`, so it picks up new npm releases on its own.

### Install the CLI

The plugin gives agents the MCP tools. Saving logins, watching agents and cleaning up are done by **you**, from the CLI:

```bash
npm install -g devtools-fleet-mcp
devtools-fleet doctor
```

No global install? Every command also works as `npx -p devtools-fleet-mcp devtools-fleet <command>`.

### Other MCP clients

Claude Code without the plugin:

```bash
claude mcp add devtools-fleet -- npx -y devtools-fleet-mcp
```

Any other client (`.mcp.json`, Cursor, Claude Desktop, …):

```json
{
  "mcpServers": {
    "devtools-fleet": {
      "command": "npx",
      "args": ["-y", "devtools-fleet-mcp"]
    }
  }
}
```

### First test

Open two Claude Code sessions and ask both:

> "Open http://localhost:3000 and check the console for errors."

Each gets its own Chrome; neither hits the profile lock. Then, in a terminal:

```bash
devtools-fleet ls
```

### First saved login

```bash
devtools-fleet login staging-admin https://staging.example.com/wp-login.php
```

Log in in the window that opens, come back to the terminal, press Enter, confirm the allowlist. Then ask an agent:

> "Using the staging-admin state, open the Plugins page and run a Lighthouse audit on it."

The agent calls `state_list`, then `browser_start({ state: "staging-admin" })`, and starts already logged in.

## MCP Tools

devtools-fleet adds six tools. Everything else (`navigate_page`, `take_snapshot`, `click`, `evaluate_script`, `list_network_requests`, `performance_start_trace`, `lighthouse_audit`, …) is chrome-devtools-mcp's, with the same names and arguments, so its documentation and skills apply as-is.

### `browser_start`

Starts this session's browser, or picks it up again after a reconnect. Optional: any browser tool starts one with defaults.

```
→ browser_start({ state: "staging-admin", url: "https://staging.example.com/wp-admin/" })
← Started: browser 3f9c2a, state "staging-admin", headless, stable
  allowed origins: https://staging.example.com
  tabs: https://staging.example.com/wp-admin/
  uptime 2s
```

| Parameter | Type | Description |
|---|---|---|
| `state` | string | Saved login to start from |
| `headless` | boolean | Default from config (`true`) |
| `viewport` | string | e.g. `"1280x720"` |
| `channel` | string | `stable`, `beta`, `dev` or `canary` |
| `url` | string | Open this in the first tab |
| `allowedOrigins` | string[] | Without a state: restrict this browser voluntarily |

### `browser_status`

This session's browser: id, state, allowlist, mode, open tabs, uptime, blocked requests.

```
→ browser_status()
← browser 3f9c2a, state "staging-admin", headless, stable
  allowed origins: https://staging.example.com
  tabs: https://staging.example.com/wp-admin/plugins.php
  uptime 312s, 2 request(s) blocked so far
```

### `browser_restart`

Relaunches keeping cookies, storage and tabs. `{ headless: false }` gives a visible window, for example so a person can solve a captcha.

```
→ browser_restart({ headless: false })
← Restarted with a visible window; reopened 2 tab(s). Page ids have changed: call list_pages.
```

### `browser_stop`

Closes the browser and deletes its temporary profile.

```
→ browser_stop()
← Closed browser 3f9c2a.
```

### `state_save`

Saves the current browser's login under a name. Parameters: `name`, `allowedOrigins` (defaults to the open tabs' origins), `strict`, `overwrite`. An agent can only narrow its own allowlist, never widen it, and never overwrites a state a person created.

```
→ state_save({ name: "local-shop" })
← Saved state "local-shop": 4 cookie(s), localStorage for 1 origin(s). Allowed: http://localhost:3000.
```

### `state_list`

Saved states with origins, cookie counts and expiry. Never values.

```
→ state_list()
← staging-admin: https://staging.example.com | 6 cookies (0 expired) | saved 2026-10-01T09:12:44.512Z by cli
  local-shop: http://localhost:3000 | 4 cookies (0 expired) | saved 2026-10-01T10:03:10.087Z by agent
```

## CLI Reference

```bash
# See every fleet browser: id, status, session, state, mode, current tab
devtools-fleet ls
devtools-fleet ls --json

# Watch an agent's browser live in Chrome's DevTools inspector (doesn't disturb it)
devtools-fleet show 3f9c2a
devtools-fleet show 3f9c2a --tab 2 --print

# Close browsers
devtools-fleet kill 3f9c2a
devtools-fleet kill --all

# Close browsers whose session is gone; --detached also closes ones waiting for a reconnect
devtools-fleet gc
devtools-fleet gc --detached

# Log in by hand and save a state
devtools-fleet login staging-admin https://staging.example.com/wp-login.php
devtools-fleet login shop http://localhost:3000/login --allow https://cdn.example.com --strict

# Manage states (never prints cookie or storage values)
devtools-fleet states
devtools-fleet state show staging-admin
devtools-fleet state rm staging-admin
devtools-fleet state import shop ./storageState.json --allow http://localhost:3000

# Check Node, Chrome, permissions and config; print effective config
devtools-fleet doctor
devtools-fleet config
```

Browser statuses: `active` (an agent is connected), `detached` (the connection dropped; waiting for that session to reconnect), `orphan` (the session is gone; closed on the next cleanup), `starting`.

## How It Works

### Process Management

On the first browser tool call, devtools-fleet:

1. **Checks the cap** under a machine-wide lock (`maxBrowsers`, default 10). A full fleet gets a clear error naming the running sessions and `devtools-fleet gc`
2. **Launches Chrome** itself, on a port it picks, with its own temporary profile
3. **Restores the state**, if one was asked for: cookies over CDP, `localStorage` through a throwaway tab whose request devtools-fleet answers itself, so the site is never contacted
4. **Spawns chrome-devtools-mcp** from its own pinned `node_modules` with `--browserUrl`, and re-exports its tool list unchanged
5. **Registers the browser** in `~/.devtools-fleet/browsers/<id>.json`

When the connection drops, Chrome keeps running. When the same client session reconnects, it finds its browser in the registry and re-adopts it, tabs intact. A reaper process (one per machine, started on demand, gone when idle) closes orphans at once and detached browsers after `orphanTimeoutMinutes`.

### How Sessions Are Recognised

MCP clients start servers through wrappers (`npx`, `npm exec`, `node`, shells) and restart that whole chain on reconnect, while the client session itself (the `claude` process, an editor's extension host) keeps running. devtools-fleet walks up the process tree past the wrappers to that session process. The same session reconnecting finds the same process and gets its browser back; a second session in the same directory finds a different one and never shares.

`DEVTOOLS_FLEET_SESSION=<label>` replaces the lookup with a fixed label, useful in CI or containers.

### Saved Logins

`devtools-fleet login` opens a real Chrome window. You log in, come back to the terminal, press Enter. devtools-fleet proposes an allowlist of where you started and where you ended up. Origins you only passed through, such as an SSO provider, are listed but left out: saving their cookies would hand agents your whole SSO session. Add one with `--allow` if the app really needs it.

What gets saved: cookies and `localStorage` for the allowed origins, in [Playwright's `storageState` format](https://playwright.dev/docs/auth). Playwright loads these files directly, and `state import` takes Playwright or agent-browser files the other way.

Rules that keep states safe to hand to an agent:

- States are only written outside git work trees, with mode `0600` in a `0700` directory.
- No listing, CLI or MCP, ever shows cookie or storage values.
- A state is always bound to an allowlist. There is no "use these cookies anywhere" mode.

### The Allowlist

Allowlist entries are full origins:

| Entry | Matches |
|---|---|
| `https://app.example.com` | exactly that scheme, host and port |
| `http://127.0.0.1:3000` | ports matter: `:3001` is a different origin |
| `https://*.example.com` | any subdomain, not `example.com` itself |

Two layers enforce it:

1. **Argument check.** `new_page` and `navigate_page` are checked before anything reaches the browser; the agent gets a plain error.
2. **Navigation interception.** devtools-fleet's own CDP connection intercepts navigations in every tab, popup and frame and fails the ones outside the list. A tab that can't be put under interception is closed rather than left unguarded.

A browser with an allowlist also refuses `file:` URLs and extra browser contexts (`new_page`'s `isolatedContext`), since pages there would sit outside the guard.

**Strict mode** (`login --strict`) is enforced by Chrome itself: the browser launches with a proxy that goes nowhere, and only the allowed origins bypass it. Every other request fails in Chrome's network stack: `fetch()`, XHR, beacons, workers, WebSockets, QUIC. WebRTC is pinned to the dead proxy and DNS prefetching is off. The lock holds even while no agent is connected. It's off by default because it also blocks CDNs you haven't listed. At that layer an entry means host and port, so `http` and `https` on the same port aren't told apart there; the navigation guard still tells them apart.

What the allowlist does **not** do:

- It limits *where* the agent goes, not what it does there. On an allowed origin, `evaluate_script` can read anything the page can, including non-httpOnly cookies. Treat a saved login like handing someone your session.
- Without strict mode, only navigations are guarded, and only while an agent is connected. A detached browser can still be navigated away by a script already running in its pages.

### Files and Paths

chrome-devtools-mcp only reads and writes files (screenshots, traces, uploads) inside the client's workspace roots and the temp directory. devtools-fleet passes your client's roots through, so `take_screenshot({ filePath: "<project>/shot.png" })` works as usual. Nothing may point into `~/.devtools-fleet`: not a `filePath`, not an `upload_file`, not a `file:` URL, symlinks included.

### Data Storage

```
~/.devtools-fleet/
  config.json          # Optional configuration (see below)
  browsers/
    <id>.json          # One registry entry per running browser
  profiles/            # Temporary Chrome profiles, deleted on close
  states/              # Saved logins (0700 dir, 0600 files)
    <name>.json
  locks/               # mkdir locks for the cap check and adoption
```

`DEVTOOLS_FLEET_HOME` moves the whole directory.

## Configuration

`~/.devtools-fleet/config.json`, every key optional. Environment variables override the file.

| Key | Env | Default | |
|---|---|---|---|
| `headless` | `DEVTOOLS_FLEET_HEADLESS` | `true` | |
| `viewport` | `DEVTOOLS_FLEET_VIEWPORT` | none | e.g. `"1280x720"` |
| `channel` | `DEVTOOLS_FLEET_CHANNEL` | `stable` | |
| `chromePath` | `DEVTOOLS_FLEET_CHROME_PATH` | detected | |
| `maxBrowsers` | `DEVTOOLS_FLEET_MAX_BROWSERS` | `10` | across the machine |
| `orphanTimeoutMinutes` | `DEVTOOLS_FLEET_ORPHAN_TIMEOUT_MINUTES` | `15` | how long a dropped connection's browser waits for a reconnect |
| `launchTimeoutSeconds` | `DEVTOOLS_FLEET_LAUNCH_TIMEOUT_SECONDS` | `30` | |
| `upstreamArgs` | | `[]` | extra chrome-devtools-mcp flags |
| `chromeArgs` | | `[]` | extra Chrome flags, e.g. `["--no-sandbox"]` in containers |

chrome-devtools-mcp collects usage statistics by default and may send performance trace URLs to Google's CrUX API. devtools-fleet keeps its defaults. Opt out with `"upstreamArgs": ["--no-usage-statistics", "--no-performance-crux"]`.

## Limits

- **Tested on macOS and Linux.** Windows should work apart from reconnect re-adoption, but is untested.
- **Saved logins cover cookies and `localStorage`.** Not IndexedDB, `sessionStorage` or service worker caches.
- **Sites with device-bound sessions** (Device Bound Session Credentials) won't accept copied cookies.
- **Google accounts are not supported.** Google blocks automated sign-in and binds sessions to devices.
- **Headless can't switch to a window in place.** `browser_restart` relaunches, and the pages reload.
- **The debugging port is local-only but not authenticated,** the same as chrome-devtools-mcp and every CDP tool: other processes running as your user can drive these browsers.

## Companion Tools

devtools-fleet is the *look* step for the [PluginsLab](https://github.com/pluginslab) WordPress MCPs:

| MCP | Purpose |
|-----|---------|
| [wp-devdocs-mcp](https://github.com/pluginslab/wp-devdocs-mcp) | Verified hooks/filters/APIs for writing plugin **code** |
| [wp-blockmarkup-mcp](https://github.com/pluginslab/wp-blockmarkup-mcp) | Verified block schemas for generating **content** |
| [wp-playground-mcp](https://github.com/pluginslab/wp-playground-mcp) | Ephemeral WordPress instances for **testing** |
| **devtools-fleet-mcp** (this) | One DevTools-equipped Chrome per agent for **looking** at the result |

Together: **author → validate → test → look**.

## Requirements

- **Node.js 22.12+**
- **Google Chrome** (stable, beta, dev or canary), or any Chromium via `chromePath`
- macOS or Linux

## Development

```bash
npm install
npm test                 # unit tests, no browser
npm run test:integration # launches real Chrome; ~1 minute
npm run lint
```

## License

MIT
