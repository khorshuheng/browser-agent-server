# pi-browser

A Node.js server that lets a coding agent (like pi) **drive CloakBrowser over
CDP**.

It is built for one thing: a fast agent loop. Instead of one HTTP call per
action and full page dumps, it gives you:

- **Batched commands** — send N actions in one request, get N results back.
- **Deltas, not snapshots** — each result carries only what *changed* (console,
  network, errors, navigation), plus error highlights. A flood of 250 identical
  console lines collapses to a single coalesced event.
- **Stable element refs** — snapshots return compact, token-cheap trees with
  `ref` handles you act on, instead of raw HTML or brittle selectors.
- **A resumable event stream** — SSE with per-frame sequence numbers, so the
  agent can reconnect from a cursor and never miss or duplicate an event.
- **Stale-ref recovery** — if the page changed under a ref, the failed action
  returns a fresh snapshot *in the same round trip* so the agent can re-target.

Raw CDP is used directly (`ws` only — no Playwright/Puppeteer), so there is no
extra protocol layer between you and the browser.

## Requirements

macOS or Linux, and the CloakBrowser stealth Chromium binary:

```bash
npx cloakbrowser install     # or: make browser
```

The server is CloakBrowser-only. See [Why CloakBrowser-only](#why-cloakbrowser-only).

## Quick start

```bash
make install        # install dependencies
make browser        # download the CloakBrowser binary (once)

make start          # launch CloakBrowser + serve on http://127.0.0.1:8787
```

`make start` **launches CloakBrowser itself**, in headed mode, against a
dedicated profile at `~/.pi-browser/profile` (created if missing). Nothing else
is required.

Point an agent at `http://127.0.0.1:8787`. Or run the bundled example:

```bash
make demo
```

### Install the CLI globally (optional)

To get a `pi-browser` command on your PATH — so it can be started from any
directory, e.g. by a [skill](~/.agents/skills/pi-browser) — link the repo
locally. No npm publishing required:

```bash
npm link          # symlinks the `pi-browser` bin into your global bin dir
# or: npm install -g .

pi-browser --help
which pi-browser  # ~/.nvm/.../bin/pi-browser -> <repo>/src/cli.js
```

Node resolves `ws` from the repo's own `node_modules`, so the link works
outside the repo. Undo with `npm unlink -g browser-agent-server`.

### The profile

- Default: `~/.pi-browser/profile` — created on first run, overridable with
  `--profile <dir>` / `PROFILE=<dir>`.
- It is a real, persistent browser profile, isolated from your normal browser.
- A **fingerprint seed is generated once and stored in the profile**
  (`fingerprint.txt`) so the identity stays stable across restarts. Override
  with `--fingerprint <n>`.
- `make clean-profile` removes it.

### Safety: it will not hijack your browser

The server only ever attaches to a browser **it launched**, tracked with a pid
file inside the profile. If the configured port is already serving some other
browser, it refuses and tells you:

```
Port 9223 is in use by a browser this server did not start.
  * pass --attach-only to use it anyway, or
  * pass --port <n> to use a free port.
```

Use `--attach-only` to connect to a browser you started yourself (e.g. with
`scripts/launch-cloak.sh`). In that mode the server **never stops the browser**
on exit. The default port is `9223` rather than the conventional `9222`, to
avoid colliding with a user's own Chrome.

## Console and error capture (optional)

**CloakBrowser does not forward `Runtime.consoleAPICalled` or
`Runtime.exceptionThrown` over CDP** — those events are an automation tell, so
that build suppresses them. The result is that console output and uncaught page
errors are simply absent from the event stream. This is not headless-specific
and is not avoided by any tab-creation strategy.

Two consequences:

- **By default (no flag) you get everything except console/errors.** All of
  navigation, snapshots, actions, batching, network events, screenshots and
  artifacts work normally.
- **`--console-hook` restores full capture.** It injects a small script via
  `Page.addScriptToEvaluateOnNewDocument` that wraps `console.*` and listens for
  `error` / `unhandledrejection`, buffering into `window.__pi_events`. The server
  drains that over `Runtime.evaluate` (which always works) into the same event
  bus, and disables the CDP console handlers to avoid double-counting.

The trade-off: wrapping `console` leaves a faint fingerprint
(`console.log.toString()` no longer reads `[native code]`). Enable it when you
need the agent to see JS errors; leave it off when maximum stealth matters.

```bash
make start-console          # headless/headed + --console-hook
```

## The agent loop

Snapshot → act on refs → read deltas → repeat.

```bash
# Observe: compact tree of interactive elements with stable refs
curl -s localhost:8787/tabs/default/snapshot
# { "url": "...", "title": "...",
#   "nodes": [ { "ref": "e1", "role": "link", "name": "Docs", "href": "/docs" } ] }

# Act in bulk, one round trip, with per-step deltas
curl -s -X POST localhost:8787/tabs/default/batch \
  -H 'content-type: application/json' -d '{
    "commands": [
      { "action": "navigate", "url": "https://example.com" },
      { "action": "fill", "ref": "e3", "value": "agent@example.com" },
      { "action": "click", "ref": "e6", "waitForNav": true }
    ],
    "observe": "auto"
  }'
```

Each result looks like:

```json
{
  "i": 2, "action": "click", "ok": true, "ms": 87,
  "result": { "clicked": true, "at": { "x": 506, "y": 92 } },
  "events": {
    "count": 3,
    "byType": { "response": 1, "pageerror": 1, "navigation": 1 },
    "highlights": ["[pageerror] Error: intentional explosion"]
  }
}
```

`observe: "auto"` attaches a fresh snapshot after any page-changing step;
`"never"` skips it; `"always"` always includes one; `"full"` also includes every
raw event.

## Streaming changes

Open the SSE stream once and consume deltas as they happen:

```bash
curl -N 'localhost:8787/tabs/default/events?cursor=0'
```

Frames are `event: <type>` with `id: <seq>`, so a client can reconnect with
`?cursor=<lastSeq>` and pick up exactly where it left off. If the cursor predates
the retained buffer, the stream emits an `event: dropped` frame rather than
silently skipping. Filter per tab (`/tabs/:id/events`) or all tabs (`/events`),
and by type (`?types=navigation,pageerror,response`).

Prefer polling? `GET /tabs/:id/events.json?cursor=…&limit=…` returns a page of
that tab's events plus the next cursor and a `more` flag.

Event types: `console`, `pageerror`, `request`, `response`, `requestfailed`,
`navigation`, `load`, `domcontentloaded`, `dialog`, `download`, `filechooser`,
`websocket`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness + browser version + tab list |
| `GET` | `/actions` | Action vocabulary and usage examples |
| `GET` | `/tabs` | List tabs |
| `POST` | `/tabs` | Open a tab `{ "url": "…" }` |
| `DELETE` | `/tabs/:id` | Close a tab |
| `GET` | `/tabs/:id/snapshot` | Compact snapshot (`?maxNodes=&scope=&includeText=`) |
| `POST` | `/tabs/:id/act` | Run one action |
| `POST` | `/tabs/:id/batch` | **Run N actions → N deltas** (hot path) |
| `GET` | `/tabs/:id/events` | SSE stream since `?cursor=` |
| `GET` | `/tabs/:id/events.json` | Poll this tab's events since `?cursor=` |
| `GET` | `/events` | SSE stream across all tabs |
| `GET` | `/artifacts/:id` | Fetch a stowed artifact (e.g. screenshot bytes) |

`/tabs/default/…` targets the most recently **used** tab (creating one if none
is open), so simple clients don't need to manage target ids.

## Actions

`navigate`, `click`, `fill`, `type`, `press`, `select`, `check`, `hover`,
`scroll`, `setFiles`, `dropFiles`, `screenshot`, `wait`, `evaluate`,
`history`, `acceptDialog`.

Actions accept either a `ref` (from a snapshot) or a `selector` (CSS). Input is
dispatched as **real CDP input events** (`Input.dispatchMouseEvent`,
`Input.insertText`, `Input.dispatchKeyEvent`), so sites that inspect native
events behave as they would for a human. `navigate` honours
`waitUntil: load|domcontentloaded|none`; `check` verifies the resulting state.

For uploads, `setFiles` targets an `<input type="file">`; `dropFiles` targets a
**dropzone** by dispatching a real drag sequence (`dragEnter` → `dragOver` →
`drop`) with the files, which is the reliable path for apps that expose no
usable file input. Both fail with a structured `code` and a hint when the
target is the wrong kind of element.

Screenshots are stored out-of-band — the JSON response contains a small
`artifact` handle (`/artifacts/<id>`) instead of hundreds of KB of base64.

## Options

```
pi-browser [options]
  -p, --port <n>         Remote-debugging port (default 9223)
      --http-port <n>    HTTP server port (default 8787)
      --host <addr>      Bind address (default 127.0.0.1)
      --headless         Run without a window (default: headed)
      --headed           Run with a visible window (default)
      --attach-only      Do not launch; attach to a browser already on --port
      --profile <dir>    Profile dir (default ~/.pi-browser/profile)
      --binary <path>    CloakBrowser binary (default: newest in ~/.cloakbrowser)
      --fingerprint <n>  Fingerprint seed (default: generated once per profile)
      --console-hook     Capture console output and uncaught errors in-page
      --settle-ms <n>    Default settle delay after each action (default 250)
      --debug            Include stack traces in error responses
```

## Make targets

`make` (or `make help`) lists everything:

| Target | Purpose |
| --- | --- |
| `install` / `deps` | Install dependencies |
| `browser` | Download the CloakBrowser binary |
| `doctor` | Verify node / npm / CloakBrowser are present |
| `lint` / `lint-fix` | ESLint (with optional `--fix`) |
| `format` / `format-check` | Prettier write / verify |
| `syntax` | `node --check` every entry point |
| `typecheck` | Type-check `src/` with `tsc` (JSDoc-annotated) |
| `shellcheck` | Lint shell scripts (skipped if absent) |
| `check` | All static checks |
| `test` | Smoke test with console capture on (39 assertions) |
| `test-stealth` | Smoke test with console capture off (default runtime) |
| `test-headless` | Smoke test headless |
| `ci` | `install` + `check` + `test` |
| `start` / `start-headless` / `start-console` | Run the server |
| `launch` / `launch-headless` | Launch the browser only (for `--attach-only`) |
| `demo` / `health` | Example loop / pretty-print health |
| `clean` / `distclean` / `clean-profile` / `reset` | Housekeeping |
| `kill` | Stop the server (never touches a browser) |

Override variables, e.g. `make start PROFILE=/tmp/x PORT=9300`.

## Testing

`make test` launches a throwaway CloakBrowser with a temp profile, starts the
server in-process, and drives it against local `file://` fixtures — no network
required. It covers snapshot refs, batched fill/select/check/click, console
coalescing, error surfacing, stale-ref recovery, screenshots, event paging,
per-tab SSE isolation, the read-only fast path, and file attachment via both
`setFiles` (file input, including apps that clear `input.files`) and `dropFiles`
(dropzone). It cleans up its browser and profile even on failure.

`make test` = 51/51 (console hook on). `make test-stealth` = 49/49 (hook off),
asserting the absence of console events. Also verified headed and headless.

## Why CloakBrowser-only

Supporting one known binary removes a lot of guesswork: no binary discovery
across Chrome/Chromium/Canary, no per-platform paths, no ambiguity about which
browser the server is driving. It also lets the server own the safe defaults —
a dedicated profile, a stable fingerprint, and a refusal to attach to a browser
it did not start. Because CloakBrowser filters `Target.createTarget` traffic and
suppresses some CDP surfaces, targeting it explicitly is also the only honest
way to document the console/error caveat above.

## Why it's fast

- **One socket per tab, raw CDP.** No library protocol layer; domains are
  enabled once at attach, not per command.
- **Read-only fast path.** `evaluate`, `snapshot`, `screenshot` and `wait` skip
  the settle delay entirely — a batch of read-only commands returns in
  milliseconds rather than paying a fixed delay each.
- **Coalescing event bus.** High-frequency signals merge within a configurable
  window; the buffer is bounded and sequence-numbered.
- **Delta summaries.** Every result carries counts plus a few error highlights,
  not raw event payloads.
- **Bounded settling.** After a mutating action the executor waits for network
  to drain (using the live request table), capped by `settleMs`, so it never
  stalls. Pages with a permanently pending request spend the full budget; lower
  `--settle-ms` for those.
- **`Input.insertText` for bulk typing**, per-keystroke only when a `delay` is
  requested.

## Layout

```
src/cdp.js        raw CDP WebSocket client (request/response + events)
src/chrome.js     CloakBrowser resolution, launch, profile + ownership tracking
src/manager.js    owns the browser connection and all tabs
src/session.js    one page target: domains, events, evaluate, console hook
src/observe.js    in-page snapshot, DOM digest, console hook (injected)
src/actions.js    the action vocabulary
src/executor.js   batch runner: per-command deltas + settling
src/events.js     bounded coalescing event bus + summarizer
src/server.js     HTTP + SSE routes
src/cli.js        command-line entry
scripts/launch-cloak.sh    standalone CloakBrowser launcher
test/smoke.mjs    hermetic end-to-end smoke test
test/fixtures/    local HTML fixtures (no network)
Makefile          developer workflow (make help)
eslint.config.js  ESLint flat config
examples/agent-loop.js     example agent loop over the HTTP + SSE API
```

## Security

CDP exposes **full control of the browser**. The server binds to `127.0.0.1` by
default and ships no auth. Do not expose it to a network. `setFiles` and
`dropFiles` accept arbitrary host paths (inherent to driving a real browser), so
keep the port local.

## Known limitations

- **No auth/origin checks.** Any local process that can reach the port can drive
  the browser.
- **Action timeouts do not cancel the underlying CDP call.** The caller gets a
  rejection; the command may still complete server-side.
- **Coalescing is lossy at cursor boundaries.** If you resume exactly at a
  coalesced event you may miss the final merged payload.
- **`console`/`pageerror` need `--console-hook`** (see above).
- **CloakBrowser only** (macOS and Linux), and no other browser.
