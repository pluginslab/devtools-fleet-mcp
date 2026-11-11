---
name: devtools-fleet
description: Open, test, debug or profile a web page in this session's own isolated Chrome (devtools-fleet, which runs Google's chrome-devtools-mcp tools), optionally already logged in from a saved state. Also for getting the person logged in to a site (state_login opens the window, they type the password), saving or refreshing a login, and letting the person watch the browser live. Use for any browser task when the devtools-fleet MCP server is connected, and when the person says "log me in to", "save my login", "the login expired", "show me the browser", "let me watch", or "open it so I can see".
---

# devtools-fleet

You have your own Chrome. Other agents have theirs; nothing you do in yours affects them. All of chrome-devtools-mcp's tools (`new_page`, `navigate_page`, `take_snapshot`, `click`, `fill`, `evaluate_script`, `list_console_messages`, `list_network_requests`, `performance_start_trace`, `lighthouse_audit`, ...) work as usual.

**You drive all of it with tools.** Don't tell the person to run `devtools-fleet` commands in a terminal for anything below. The person's only job is what needs a human: typing a password, passing 2FA, solving a captcha, agreeing to which sites a login may be used on.

## Starting

- Any browser tool starts the browser on first use. You only need `browser_start` to choose options.
- **Needs a login?** Call `state_list` first. If a matching state exists, call `browser_start({ state: "<name>", url: "<page>" })`. You start logged in.
- A browser can't switch to a different state while running. `browser_stop`, then `browser_start` with the new one.

## Getting the person logged in

When no state fits, or a state's cookies have expired (`state_list` shows the count; a page that should be logged in shows a login form):

1. `browser_stop` if this session has a browser.
2. `state_login({ name: "staging-admin", url: "https://staging.example.com/wp-login.php" })`. A visible Chrome window opens at that URL. For an expired state, pass `overwrite: true`.
3. Tell the person: "Log in in the Chrome window that just opened, then tell me when you're done." **Wait for their answer.** Never type credentials, even ones you were given; a login a person made is trusted because a person made it.
4. `state_login_finish()` returns where the state will be usable. Show the person that list, and the origins left out (an SSO provider, for example).
5. When they agree, `state_login_finish({ confirm: true })`. Pass `allowedOrigins` if they want a different list. The window closes.
6. `browser_start({ state: "<name>", url: "<page>" })` and carry on with the task.

The saved state counts as the person's: no agent can overwrite or delete it, and logging in again keeps its allowed origins.

## The allowlist

A browser started from a state only reaches that state's origins. When something is blocked, the tool result says so (`is blocked` / `devtools-fleet blocked N request(s)`).

- This is deliberate. Don't look for another way to reach the blocked origin.
- If the task genuinely needs that origin, tell the person which one. With their OK, log in again under a new name with `state_login({ name, url, allow: ["<origin>"] })`.
- A blocked link click leaves the tab on an error page. Navigate it back with `navigate_page`.

## Letting the person see

- **Watch only:** `browser_show()` opens a live DevTools screencast of your current tab in the person's browser. Nothing reloads, and you keep working. Works headless. If the person is on another machine, `browser_show({ open: false })` returns the URL instead.
- **Type into the page** (captcha, 2FA mid-task): `browser_restart({ headless: false })` relaunches with a visible window, same cookies and tabs (pages reload). `browser_restart({ headless: true })` hides it again.

## Mobile layout

Pages render their desktop layout (1366 px wide). To see the phone version, call `emulate({ viewport: "390x844x3,mobile,touch" })`, and add `userAgent` with an iPhone Safari user agent if the site serves mobile by user agent (then reload). Call `emulate` again without `viewport` to go back to the desktop layout.

## Saving what you're logged in to

`state_save({ name })` stores the current browser's cookies for other sessions, e.g. after the person logged in inside your visible browser mid-task. It keeps only cookies for the open allowed origins, can't widen your allowlist, and can't overwrite a login a person made. `state_delete({ name })` removes a state an agent saved.

## When things go wrong

- A browser won't start, or Chrome can't be found: run `fleet_doctor` and read the FAIL lines before asking the person anything.
- A tool result starting with `devtools-fleet:` means the browser or the tooling was recovered. Read it: after a browser restart, tabs are gone and page ids are new, so call `list_pages` again.
- `devtools-fleet is at its limit of N browsers`: tell the person, and quote the list from the error. Closing other sessions' browsers is theirs to decide (`devtools-fleet gc` closes the ones whose session ended); you can't see or reach those browsers.

## Cleaning up

Call `browser_stop` when the task is done and the browser isn't needed any more. If you forget, the reaper closes it after your session ends.

## What stays with the person

Only things that reach beyond your own session, in a terminal: `devtools-fleet ls` / `kill` / `gc` (every session's browsers), `state rm` for their own logins, and `state import` of a Playwright file. Mention these only when the person asks how to do one of them.
