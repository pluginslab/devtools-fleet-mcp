# devtools-fleet-mcp — v1 scope

> chrome-devtools-mcp for ten agents at once.

Status: **v0.1.0 released** (2026-10-01).

## As built: where v0.1.0 differs from this scope

- **Registry is one file per browser** (`~/.devtools-fleet/browsers/<id>.json`, atomic renames) instead of one `sessions.json`, plus an `mkdir` lock for the cap check and adoption.
- **Session identity** is the nearest non-wrapper ancestor process (skipping npx/npm/node/shells), not the direct parent pid: with `npx`, the direct parent is restarted along with the server on reconnect. MCP servers don't receive `CLAUDE_PID`, so there is no shortcut. `DEVTOOLS_FLEET_SESSION` overrides.
- **Cleanup is a reaper process**, one per machine, started on demand and exiting when idle. Orphans (session gone) close at once; detached browsers (session alive, connection dropped) after `orphanTimeoutMinutes`; launches that never finished at once.
- **`devtools-fleet show` opens Chrome's own DevTools inspector** with a live screencast instead of relaunching headed. A relaunch would cut the agent off mid-task. Agents still get a real window with `browser_restart({ headless: false })`. This required fleet to pick the debugging port itself and set `--remote-allow-origins` to exactly that port's origin; readiness is read from `/json/version` because Chrome doesn't write `DevToolsActivePort` for a fixed port.
- **Node 22.12+** (Node 20 is end-of-life; 22 has a built-in WebSocket, so no `ws` dependency).
- **The guard answers fleet's own `/__devtools_fleet__` placeholder requests itself.** With two Fetch interceptors on one tab, a "continue" from the guard sent the storage tab's request to the real site. Found by acceptance test 6.
- **Chrome's pid is registered at spawn**, not after the port opens, so a launch that hangs is always cleaned up.
- CLI adds `doctor`, `config` and `state show`; `kill --all` and `gc --detached`.
- Windows: everything except re-adoption should work, but is untested. CI runs Ubuntu and macOS, Node 22 and 24.
- **After an independent review (12 findings):** a per-session lock serialises browser lifecycle against parallel tool calls; `isolatedContext` is refused with an allowlist and foreign-context pages are closed; `file:` URLs and any file argument pointing into the fleet home are refused (symlinks resolved); the client's MCP roots are passed to upstream (file tools only worked in the temp dir before); the reaper and `kill` deregister under the lock before closing; `node` counts as a wrapper only when running a launcher, and the anchor's start time guards against pid reuse; explicit `browser_start` options never re-adopt; the guard fails closed; login leaves pass-through (SSO) origins out by default. Two gaps the review found (strict mode missed WebSockets/WebRTC; detached browsers were unguarded) were closed by **moving strict enforcement into Chrome**: strict browsers launch with a dead proxy (`127.0.0.1:0`) and the allowlist as `--proxy-bypass-list=<-loopback>;host:port;...`, plus `--webrtc-ip-handling-policy=disable_non_proxied_udp` and `--dns-prefetch-disable`. Established by experiment: `<-loopback>` must come first; scheme-qualified rules don't match `ws://`; the `--force-webrtc-...` flag variant does nothing. Non-strict browsers keep navigation-only guarding, off while detached (documented).

## The problem

Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) is the best toolset for an agent that needs to *debug* a web app: console, network, Lighthouse, performance traces, heap snapshots. It falls over the moment you run more than one agent:

- **Profile lock.** Every server launches Chrome on the same `~/.cache/chrome-devtools-mcp/chrome-profile`. The first agent wins; every other agent gets `The browser is already running for …`. `--isolated` fixes that, but then:
- **No logins.** Isolated profiles start blank, so every agent re-authenticates against staging, wp-admin, the local app, every time.
- **Dies with the connection.** When the MCP connection drops, the agent's browser, its tabs and its state go with it. The fix today is "reconnect and start over".
- **No overview.** Ten agents means ten invisible headless Chromes. Nothing lists them, nothing reaps the orphans.

The other multi-agent browser tools (agent-browser, agent-browser-pool, Agent360 browser-mcp, tkwong/browser-pool) solve pooling and logins, but on Playwright or a browser extension. None of them carries Google's DevTools toolset. That gap is the reason this exists.

## What v1 is

A thin fleet manager **in front of** chrome-devtools-mcp. It does not reimplement a single browser tool.

```
Claude session A ──stdio──▶ devtools-fleet-mcp ──spawns──▶ chrome-devtools-mcp --browserUrl=:54288 ──CDP──▶ Chrome A (own profile dir)
Claude session B ──stdio──▶ devtools-fleet-mcp ──spawns──▶ chrome-devtools-mcp --browserUrl=:54301 ──CDP──▶ Chrome B
                                   │
                                   └──▶ ~/.devtools-fleet/sessions.json  ◀── devtools-fleet CLI (ls / kill / gc / show / login)
```

- For each agent, fleet launches Chrome itself (`--remote-debugging-port=0`, own temp `--user-data-dir`) and runs chrome-devtools-mcp as a child pointed at it with `--browserUrl`.
- Fleet is an MCP client to that child and **re-exports its full tool list unchanged**. New upstream tools arrive with a dependency bump.
- chrome-devtools-mcp is a pinned npm dependency, spawned from `node_modules`. No `npx @latest` at runtime (that registry check on every start is a crash source with many sessions).
- No central daemon. Each stdio process owns its browser and registers it in a shared file. The registry is enough for the CLI, the cap and garbage collection.

Verified in a spike (2026-09-30): Chrome launched by us + `chrome-devtools-mcp --browserUrl` exposes all 30 tools and navigates; the browser **survives the MCP process being killed**; `Storage.setCookies` / `getCookies` over a second CDP connection works alongside it.

## v1 features

### 1. One browser per agent, zero config
The first tool call launches this session's browser with defaults. No flags, no session IDs. Up to `maxBrowsers` (default 10) across the machine; the next one gets a clear error naming the running sessions and `devtools-fleet gc`.

### 2. Browsers outlive the connection
The registry records each browser's owner: the MCP process pid **and its parent pid** (the Claude session). On start:
- a registered browser with the **same parent pid** whose owner is dead is **re-adopted**, tabs intact (a reconnect inside the same Claude session);
- otherwise a new browser is launched.

Two Claude sessions in the same directory never share a browser. A browser whose owner and parent are both gone is an orphan; `gc` (and every fleet start, opportunistically) closes orphans idle longer than `orphanTimeout` (default 15 min).

### 3. Saved login states
A **state** is a named login: cookies + localStorage, saved once, loaded into any number of fresh browsers at once. Ten agents can all be logged into staging as admin in parallel, without sharing a profile.

- **Format:** Playwright `storageState` JSON (`{ cookies, origins: [{ origin, localStorage }] }`), plus fleet metadata (`allowedOrigins`, `savedAt`). Playwright loads it directly; `state import` takes one from Playwright or agent-browser.
- **Storage:** `~/.devtools-fleet/states/<name>.json`, dir `0700`, files `0600`. Fleet refuses to write a state inside a git work tree.
- **Capture:** cookies via `Storage.getCookies`; localStorage by evaluating `Object.entries(localStorage)` on each allowed origin that has an open page.
- **Restore:** cookies via `Storage.setCookies` before the first navigation; localStorage by visiting each saved origin once at startup in a background target and writing the entries, then closing it.
- **Not in v1:** IndexedDB, sessionStorage, service workers. Documented.

Humans log in, agents don't: the login flow lives in the CLI (`devtools-fleet login`), which opens a **headed** browser, waits until you close the window, and saves. That also handles 2FA, SSO and captchas without the agent seeing a password.

### 4. Origin allowlist per state
Every state carries `allowedOrigins` (defaults to the origins it was saved from). A browser started with a state may only go there. This is the prompt-injection guard: an agent carrying an admin session can't be steered to a page that tells it what to do with that session.

Two layers:
1. **Argument check** in the proxy: `navigate_page` / `new_page` with a disallowed URL returns a clear error to the agent before anything is forwarded.
2. **Navigation interception**: fleet's own CDP connection auto-attaches to every target and uses the `Fetch` domain to fail `Document` requests to disallowed origins. Catches link clicks, redirects, `window.location`.

`strict: true` on a state extends layer 2 to every resource type, blocking `fetch()` / XHR exfiltration from `evaluate_script`. Off by default because it breaks CDN assets unless those origins are listed.

Honest limits, in the README: `evaluate_script` can read non-httpOnly cookies on allowed origins; the allowlist limits *where* the agent goes, not what it does there.

### 5. CLI: `devtools-fleet`
Same package, second bin, the `wp-playground` pattern.

| Command | Does |
|---|---|
| `ls` | Every fleet browser: id, owner session, state, headless, pages, current URL, idle time |
| `kill <id>` / `kill --all` | Close a browser, deregister |
| `gc` | Close orphans now |
| `show <id>` | Relaunch headed with the same cookies + storage (short reload), for watching or taking over |
| `login <name> <url> [--allow <origin>...]` | Headed browser → you log in → close window → state saved |
| `states` | Names, origins, saved at, cookie count. Never values |
| `state rm <name>` / `state import <name> <file>` | Manage states |

### 6. Options
Per call on `browser_start`, defaults from `~/.devtools-fleet/config.json`, overridable by env:
`headless` (default true), `viewport`, `channel` (stable / beta / canary / dev), `maxBrowsers`, `orphanTimeout`, `chromePath`.

## MCP surface

Fleet's own tools (everything else is chrome-devtools-mcp, passed through with identical names so its skills and docs still apply):

| Tool | Input | Notes |
|---|---|---|
| `browser_start` | `{ state?, headless?, viewport?, channel?, url? }` | Implicit with defaults on the first proxied call. Explicit call needed to pick a state. Re-adopts if eligible |
| `browser_status` | `{}` | This session's browser: id, state, allowlist, headless, pages, uptime |
| `browser_restart` | `{ headless? }` | Relaunch keeping cookies + storage; how an agent asks for a headed window |
| `browser_stop` | `{}` | Close and deregister |
| `state_save` | `{ name, allowedOrigins? }` | Save the current browser as a state. Refuses to overwrite without `overwrite: true` |
| `state_list` | `{}` | Same as `devtools-fleet states`. Never returns cookie or storage values |

Deliberately **not** MCP tools: `login` (a human act, CLI only), `state rm`, `kill` of other sessions' browsers.

## Package conventions (same as the WordPress trio)

- Plain JS ESM, Node ≥ 20, `@modelcontextprotocol/sdk`, `zod`, `commander`; `@puppeteer/browsers` for finding Chrome by channel. No TypeScript build step.
- `src/index.js` (MCP bin `devtools-fleet-mcp`), `bin/cli.js` (bin `devtools-fleet`), `src/lib/` (chrome-launcher, registry, proxy, states, allowlist), `src/tools/` (one file per fleet tool).
- `node --test`; `eslint`; MIT; `pluginslab/devtools-fleet-mcp`; README in the "Why This Exists / The Solution / Quick Start / MCP Tools" shape with a banner; `ROADMAP.md`; `CHANGELOG.md`.
- **New for this one:** `.claude-plugin/` manifest + marketplace entry so it installs as a Claude Code plugin, and a `skills/devtools-fleet/SKILL.md` teaching the start → state → debug loop.
- Listing on marcelschmitz.com: an entry in `2026-astro/src/data/tools.ts` (probably under "Also").

## Milestones

**M0 · Spikes** (before committing to the design)
- `Fetch` interception across auto-attached targets coexisting with chrome-devtools-mcp's own CDP session.
- localStorage restore via background target, including origins that set storage only after JS runs.
- Headed ⇄ headless relaunch preserving state (`browser_restart`).
- Registry locking with `mkdir`-based locks (no dependency) under 10 concurrent starts.

**M1 · Fleet core:** launcher, registry, passthrough proxy, re-adoption, cap, orphan gc; CLI `ls` / `kill` / `gc`.

**M2 · States:** `state_save` / `state_list`, restore on `browser_start`, CLI `login` / `states` / `state rm` / `state import`.

**M3 · Allowlist:** both layers + `strict`.

**M4 · Ship:** CLI `show`, plugin manifest + skill, README + banner, npm publish, tools.ts entry.

## Acceptance tests

1. 10 fleet processes start concurrently → 10 browsers, each navigates to its own URL, no cross-talk (the check from 2026-09-30, now as a test).
2. 11th start → error that names the cap and `gc`.
3. Kill the MCP process; start a new one under the same parent → same browser id, tabs intact.
4. Kill owner and parent → `gc` closes the browser after `orphanTimeout` (test with a short timeout).
5. Fixture app in `test/fixtures/` (tiny http server: login form → httpOnly session cookie + a localStorage flag). `login` flow scripted headless → state saved → new browser with that state lands logged in, localStorage flag present.
6. State with allowlist `http://127.0.0.1:<fixture>`: `navigate_page` elsewhere → proxy error; a link click elsewhere → blocked by `Fetch`; `strict` blocks a cross-origin `fetch()` from `evaluate_script`.
7. `state_list` output contains no cookie values (grep the response for the fixture's cookie value).
8. State write inside a git work tree is refused.

## Out of scope

Firefox / WebKit; cloud browser providers; bot-detection evasion; captcha solving; a hosted service. Google-account automation is not a feature: it probably works through a saved state, but Google blocks automated sign-in and may bind sessions to the device, so the README calls it unsupported.

## Risks

- **Upstream builds it.** chrome-devtools-mcp's CLI already has a hidden per-session daemon id (`--sessionId`, hex only). Keep fleet thin so it's cheap to retire, and consider upstreaming the isolation part as a PR.
- **Device-bound sessions.** Sites adopting Device Bound Session Credentials will not survive cookie copying. Affects states, not the fleet.
- **Headless can't flip to headed live.** `show` / `browser_restart` relaunch; the page reloads.
- **Upstream flag drift.** `--browserUrl` is documented and stable; everything else we pass is checked against `--help` in CI.
