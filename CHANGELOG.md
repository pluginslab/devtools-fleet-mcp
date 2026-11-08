# Changelog

## [0.3.0] - 2026-11-08

### Added

- **A real Chrome from inside Smart Terminal.** `browser_start({ chrome: true })` launches Chrome instead of using the tab's pane, with a window unless `headless: true`. `browser_restart({ chrome: true })` moves a running browser from the pane into Chrome, with its cookies, storage and tabs; `{ chrome: false }` moves it back. Since 0.2.0 the only way out of the pane was `DEVTOOLS_FLEET_SMART_TERMINAL=0` before the server started, so agents sent people to `devtools-fleet login` instead. For sites that refuse embedded browsers (Google sign-in) or when the person just wants Chrome.
- Config key `smartTerminal` (default `true`); `false` makes Chrome the default in Smart Terminal tabs. `DEVTOOLS_FLEET_SMART_TERMINAL` sets it too.
- `browser_status` says whether the browser is the pane or Chrome and how to switch. Asking `browser_start` for `chrome` while a browser runs points to `browser_restart`.

### Fixed

- Restarting a browser that had moved between the pane and Chrome (or restarting a pane twice) failed with "No page to read cookies through" with Smart Terminal before 0.15.0.

## [0.2.1] - 2026-11-06

### Changed

- The skill and the README explain the mobile layout: `emulate` with a phone viewport, and back. In a Smart Terminal pane (0.13.0+) the pane follows.

## [0.2.0] - 2026-11-04

### Added

- **Smart Terminal panes.** Run in a [Smart Terminal](https://github.com/pluginslab/smart-terminal) tab (0.11.0+), a session uses the tab's browser pane instead of launching Chrome: Smart Terminal's own Chromium, with chrome-devtools-mcp connected over `--wsEndpoint` to a DevTools gate that shows that browser's pages only. Registry, re-adoption, the reaper, saved logins and allowlists work as for Chrome; closing is a request to the app, never a signal. Strict states still launch Chrome. `DEVTOOLS_FLEET_SMART_TERMINAL=0` turns it off. See "In a Smart Terminal tab" in the README.
- The integration suite runs against Smart Terminal when `SMART_TERMINAL_GATE` is set, and fails if a browser falls back to Chrome. Both modes pass.

### Fixed

- A failed navigation while restoring a saved login's localStorage left a rejected promise unhandled, which ended the whole server.

## [0.1.1] - 2026-10-16

### Changed

- **Browsers now default to a 1366x900 window** (a 1366x813 page). Without one, headless Chrome gave pages 756x469, below most responsive breakpoints (wp-admin switches at 782), so agents saw mobile layouts: wp-admin's snapshot had no admin menu at all, and screenshots and Lighthouse runs came from a phone-sized page. Set `"viewport": null` in `~/.devtools-fleet/config.json` (or `DEVTOOLS_FLEET_VIEWPORT=none`) to keep Chrome's default. `browser_start({ viewport })` still overrides per browser. Login windows are unchanged.

## [0.1.0] - 2026-10-01

First version, built against `SCOPE.md`.

- One isolated Chrome per agent session, running chrome-devtools-mcp's tools unchanged (`--browserUrl` passthrough).
- Browsers outlive the MCP connection and are re-adopted by the same client session; a background reaper closes the rest.
- Saved login states (cookies + localStorage, Playwright storageState format) via `devtools-fleet login`; restore never contacts the site.
- Per-state origin allowlists, enforced before the call and inside the browser. Strict mode locks the whole network in Chrome itself (dead proxy + bypass list): fetch, WebSockets, WebRTC, workers, also while no agent is connected.
- No `file:` URLs or file arguments into `~/.devtools-fleet`; no extra browser contexts under an allowlist; client MCP roots passed through to chrome-devtools-mcp.
- Recovery from Chrome or chrome-devtools-mcp crashes.
- CLI: `ls`, `show` (live DevTools inspector), `kill`, `gc`, `login`, `states`, `state show|rm|import`, `doctor`, `config`.
- Claude Code plugin manifest and skill.
