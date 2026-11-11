# Changelog

## [0.5.0] - 2026-11-11

The agent now does the browser work it used to hand to you as terminal commands. Your part is only what needs a person: typing a password, passing 2FA, agreeing to where a login may be used.

### Added

- **`state_login` and `state_login_finish`: the agent gets you logged in.** It opens a visible Chrome window at the login page, you log in by hand, and it saves the result with the same allowlist rules as `devtools-fleet login` (where you started and ended up; SSO providers you only passed through are left out). It shows you the allowlist before saving. The state counts as yours (`createdBy: "person"`): agents can't overwrite or delete it, and logging in again over an expired state keeps its allowed origins.
- **`browser_show`** opens a live DevTools screencast of the agent's tab in your browser, like `devtools-fleet show`, without you looking up the id. `open: false` only returns the URL.
- **`state_delete`** for states an agent saved. Logins a person made are refused.
- **`fleet_doctor`**: the `devtools-fleet doctor` checks as a tool, so the agent diagnoses a browser that won't start before asking you.

### Changed

- **The plugin pins the npm version** (`devtools-fleet-mcp@0.5.0`). The plugin runs the server from npm, so before this it ran whatever `latest` was, whatever version the plugin said. A unit test keeps the pin and `package.json` in step.
- The server instructions, the skill and the tool descriptions tell the agent to do this work itself and not to hand out `devtools-fleet` commands. `state_list` with nothing saved points at `state_login`. The skill triggers on "log me in to", "save my login", "show me the browser", "let me watch".
- `state_save` refuses to overwrite any login a person made, from the CLI or through `state_login`.
- The CLI's `doctor` and `show` share their code with the new tools; `show` says so when there's no browser to open the URL in.

## [0.4.0] - 2026-11-11

### Removed

- **Smart Terminal panes.** devtools-fleet always launches its own Chrome again, as before 0.2.0, also inside a Smart Terminal tab: Smart Terminal 0.16.0 removed its browser pane and the DevTools gate behind it. `SMART_TERMINAL_GATE` and `SMART_TERMINAL_TAB` are no longer read, and fleet no longer asks tmux for the tab.
- The `chrome` option of `browser_start` and `browser_restart`, which only switched between the pane and Chrome. Pass `headless: false` for a window.
- Config key `smartTerminal` and `DEVTOOLS_FLEET_SMART_TERMINAL`. A config file that still sets `smartTerminal` is ignored for that key.
- The integration suite's Smart Terminal mode.

Registry entries left by a pane (no Chrome pid) are cleaned up as dead browsers; nothing is signalled.

## [0.3.1] - 2026-11-09

### Fixed

- **An agent in tmux got the pane of whichever Smart Terminal tab you were looking at.** Inside tmux, `SMART_TERMINAL_TAB` is the tab that started the tmux server, so fleet asked for the tab in front. It now asks tmux for the session's own `SMART_TERMINAL_TAB` (set by `cc-tmux` and by Smart Terminal's tmux restore) and sends the session's name too, so Smart Terminal 0.15.1 can find the tab showing it.

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
