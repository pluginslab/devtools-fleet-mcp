# Roadmap

v1 is defined in [SCOPE.md](SCOPE.md). This file holds what comes after.

**Landscape context:** multi-agent browser tooling already exists on Playwright and browser extensions ([agent-browser](https://github.com/vercel-labs/agent-browser), [agent-browser-pool](https://github.com/dabstractor/agent-browser-pool), [Agent360 browser-mcp](https://github.com/agent360dk/browser-mcp), [tkwong/browser-pool](https://github.com/tkwong/browser-pool), [cloud-browser-mcp](https://github.com/BK927/cloud-browser-mcp)). None of them carries Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) toolset (Lighthouse, performance traces, network, heap). That is the lane.

## Next

- **Live dashboard.** Local page listing every fleet browser with a screencast thumbnail, owner session, state and a kill button. `devtools-fleet show` (Chrome's inspector, one browser at a time) covers the single-browser case today.
- **Windows re-adoption.** Process-tree lookup via PowerShell / `wmic`, plus CI on `windows-latest`.
- **wp-playground-mcp pairing.** Boot a Playground, get a fleet browser already logged into its wp-admin. Joins the WordPress trio loop: author, validate, test, *look*.
- **Shared daemon + queue.** When the cap is full, wait for a slot instead of failing. Only if the registry-file design proves too weak.
- **Encrypted states.** Key in the macOS Keychain / libsecret, like Chrome's own cookie store.
- **IndexedDB and sessionStorage** in saved states.

## Maybe

- Per-state proxy and network throttling presets.
- Upstream PR to chrome-devtools-mcp for per-instance isolation, if they want it.
