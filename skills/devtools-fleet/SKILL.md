---
name: devtools-fleet
description: Open, test, debug or profile a web page in this session's own isolated Chrome (devtools-fleet, which runs Google's chrome-devtools-mcp tools), optionally already logged in from a saved state. Use for any browser task when the devtools-fleet MCP server is connected, especially when the page needs a login or other agents are using browsers at the same time.
---

# devtools-fleet

You have your own Chrome. Other agents have theirs; nothing you do in yours affects them. All of chrome-devtools-mcp's tools (`new_page`, `navigate_page`, `take_snapshot`, `click`, `fill`, `evaluate_script`, `list_console_messages`, `list_network_requests`, `performance_start_trace`, `lighthouse_audit`, ...) work as usual.

## Starting

- Any browser tool starts the browser on first use. You only need `browser_start` to choose options.
- **Needs a login?** Call `state_list` first. If a matching state exists, call `browser_start({ state: "<name>", url: "<page>" })`. You start logged in.
- **No matching state?** Don't try to log in with credentials you were not given. Ask the person to run `devtools-fleet login <name> <url>` in a terminal, then use the state they create.
- A browser can't switch to a different state while running. `browser_stop`, then `browser_start` with the new one.

## The allowlist

A browser started from a state only reaches that state's origins. When something is blocked, the tool result says so (`is blocked` / `devtools-fleet blocked N request(s)`).

- This is deliberate. Don't look for another way to reach the blocked origin.
- If the task genuinely needs that origin, tell the person which one, so they can re-save the state with `--allow <origin>`.
- A blocked link click leaves the tab on an error page. Navigate it back with `navigate_page`.

## When things go wrong

- A tool result starting with `devtools-fleet:` means the browser or the tooling was recovered. Read it: after a browser restart, tabs are gone and page ids are new, so call `list_pages` again.
- `devtools-fleet is at its limit of N browsers`: tell the person. Don't stop other sessions' browsers; you can't see or reach them anyway.

## Showing the person something

- `browser_restart({ headless: false })` relaunches with a visible window (same cookies and tabs, pages reload). Use it when the person needs to watch, solve a captcha or pass 2FA. `browser_restart({ headless: true })` hides it again.
- The person can also watch without interrupting you: `devtools-fleet ls`, then `devtools-fleet show <id>`. `browser_status` tells you your id.

## Saving a login

After the person has logged in inside your visible browser, `state_save({ name })` stores it for other sessions. It keeps only cookies for the open allowed origins, can't widen your allowlist, and can't overwrite states a person created.

## Cleaning up

Call `browser_stop` when the task is done and the browser isn't needed any more. If you forget, the reaper closes it after your session ends.
