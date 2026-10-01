# Changelog

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
