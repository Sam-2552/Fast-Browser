# fast-browser

Blazing-fast browser automation for any agent, any language, one HTTP call.

Built to replicate the speed pattern behind ChatGPT's built-in browser: **one code snippet per batch of actions**, a persistent browser that stays open between calls, and only the output you print comes back.

## Why

| Tool | Problem |
|---|---|
| Playwright MCP | One model round-trip per click. Returns full page snapshots. Bloats context. |
| Claude in Chrome | Extension relay adds latency. Screenshots on every action. Slow. |
| **fast-browser** | One call does navigate + fill + click + extract. Returns only what you ask for. |

## Quick start

```bash
docker build -t fast-browser .
docker run -d --name browser -p 9100:9222 fast-browser
```

Open **http://localhost:9100/view** in your browser to watch the page live, click, and type (useful for login).

### Call it

```bash
curl -X POST http://localhost:9100/run \
  -H 'Content-Type: application/json' \
  -d '{"code":"await goto(\"https://example.com\"); return await text()"}'
```

Response:

```json
{
  "ok": true,
  "output": "Example Domain This domain is for use in…\n[tab 1/1] Example Domain | https://example.com/  (54ms)",
  "elapsed_ms": 54
}
```

## API

### `POST /run`

Execute JavaScript with full browser control.

```json
{
  "code": "await goto('https://example.com'); return await snap()",
  "timeout_ms": 30000,
  "max_output": 8000
}
```

The code runs in a persistent runtime with `async/await` support. Single expressions auto-return. The full Playwright `page` and `context` objects are available for advanced use.

### `POST /shot` or `GET /shot`

Returns a JPEG screenshot of the current page.

```bash
curl http://localhost:9100/shot -o screenshot.jpg
```

With options:

```json
{ "full": true, "selector": "#main" }
```

### `GET /health`

```json
{ "ok": true, "browser": "open", "pages": 1, "uptime_s": 123 }
```

### `GET /state`

Lightweight status for the viewer (no serial lock):

```json
{
  "ok": true,
  "url": "https://example.com/",
  "tabs": [{ "i": 0, "active": true, "url": "https://example.com/", "title": "..." }],
  "busy": false,
  "lastAction": { "action": "click", "x": 640, "y": 400, "ts": 1700000000000 }
}
```

### `GET /view`

Full browser viewer with tab bar, address bar, agent cursor overlay, and screenshot capture. You can see the page, click on elements, type text, scroll, and press keys — all forwarded to the browser inside the container. When an agent is running code via `/run`, a pulsing indicator shows "Agent working...". Click locations appear as animated rings, and the agent's last click position shows a blue cursor arrow.

Use this for login flows, CAPTCHAs, and debugging.

### `POST /interact`

Programmatic mouse/keyboard input (used by `/view` internally, also callable directly):

```json
{ "action": "click", "x": 640, "y": 400 }
{ "action": "type", "text": "hello" }
{ "action": "press", "key": "Enter" }
{ "action": "scroll", "dy": 300 }
```

### `POST /observe` and `POST /act`

Low-level endpoints for decision loops (the decider uses them). Actions are referenced by id, never by code strings.

`POST /observe` (body `{}`) reads the visible viewport: text (up to 6,000 chars), scroll position, and every on-screen control as an action. Text fields get a `fill` action and an "Open ..." `click`; each select option is its own `select` action, listed last. `wait` is always offered; `scroll_down` and `scroll_up` appear when the page can scroll in that direction. At most 250 element actions are listed (`omitted` counts the rest). Password, file and hidden inputs never appear. Open shadow roots are included. The server keeps the last 8 observations.

```json
{"ok": true, "obs": "o12", "url": "...", "title": "...", "text": "...", "scroll": {"y": 0, "height": 2400}, "omitted": 0,
 "fingerprint": "<sha256>", "marker": "<sha256>",
 "actions": [{"id": "e1", "kind": "fill", "node": 4, "role": "textbox", "label": "Destination", "value": ""},
             {"id": "e3", "kind": "click", "node": 9, "role": "button", "label": "Search", "value": ""},
             {"id": "scroll_down", "kind": "scroll", "label": "Scroll down", "delta": 560},
             {"id": "wait", "kind": "wait", "label": "Wait for the page to update"}]}
```

`marker` changes only when the page changes semantically; `fingerprint` changes with any visible change.

`POST /act {"obs": "o12", "action": "e3", "text": "..."}` runs one action (`text` is required for `fill`). Before acting it checks that the target is unchanged since the observation (identity, role, label, value, states and surrounding form, dialog or row), connected, enabled, visible, inside the viewport and not covered by another element. Scroll and wait check that the whole page is unchanged instead.

```json
{ "ok": true, "executed": "e3" }
{ "ok": false, "stale": true, "error": "..." }
{ "ok": false, "unknown": true, "error": "..." }
```

`stale` means nothing happened; observe again. `unknown` means the action may have happened; observe before doing anything else. Actions are never retried. Clicks are real mouse clicks at the element's centre, so `/view` shows them with the agent cursor. Each `/observe` or `/act` has a hard deadline (`STEP_TIMEOUT_MS`, 15 s): on a hung page `/observe` returns `{ok: false, error}` and `/act` returns `unknown`, so later requests are not stuck behind it.

### Screenshots

Capture and retrieve screenshots from the viewer. Stored in `/data/screenshots` (mount a volume to persist).

| Endpoint | Method | Description |
|---|---|---|
| `/screenshots/save` | POST | Capture current page, save as JPEG |
| `/screenshots/list` | GET | List all saved screenshots |
| `/screenshots/get?name=snap-...jpg` | GET | Download a specific screenshot |

```bash
# Save a screenshot
curl -X POST http://localhost:9100/screenshots/save

# List all
curl http://localhost:9100/screenshots/list

# Mount a volume to persist screenshots across container restarts
docker run -d --name browser -p 9100:9222 \
  -v browser-screenshots:/data/screenshots fast-browser
```

## Helpers

These are available inside your `code` string:

### Navigation

| Helper | Description |
|---|---|
| `goto(url)` | Navigate, returns `{status, title, url}` |
| `url()` | Current page URL |
| `title()` | Current page title |

### Inspection

| Helper | Description |
|---|---|
| `snap({limit?})` | Numbered list of interactive elements on the whole page: `[3] button "Sign in"` (default limit 150) |
| `text(selector?, maxChars?)` | Visible text, whitespace-collapsed |
| `html(selector?)` | innerHTML or full page HTML |
| `attr(selector, name)` | Read an HTML attribute |

### Interaction

| Helper | Description |
|---|---|
| `click(ref)` | Click a snap ref `click(3)` or CSS selector `click("#btn")` |
| `dblclick(ref)` | Double-click |
| `fill(ref, text)` | Clear + set value (instant) |
| `type(ref, text)` | Type character by character (for autocomplete, live search) |
| `select(ref, value)` | Pick a dropdown option |
| `check(ref)` / `uncheck(ref)` | Toggle checkboxes |
| `hover(ref)` | Hover (tooltips, menus) |
| `focus(ref)` | Focus an element |
| `press(key)` | Keyboard: `"Enter"`, `"Tab"`, `"Escape"`, `"Control+a"` |
| `scroll(dir, px?)` | Scroll `"down"` / `"up"` / `"left"` / `"right"` |
| `wait(selector, opts?)` | Wait for element to appear (default 5s) |

A numeric ref from `snap()` stays valid until the next `snap()`. If its element is gone, or its role or name changed, the helper throws `ref N changed since snap() — run snap() again` instead of acting on a different element. A changed value is allowed.

### Tabs

| Helper | Description |
|---|---|
| `tabs()` | List all open tabs |
| `tab(i)` | Switch to tab by index |
| `newTab(url?)` | Open a new tab |
| `close()` | Close current tab |

### Media

| Helper | Description |
|---|---|
| `shot({full?, selector?})` | JPEG screenshot as base64 |
| `pdf()` | Full page PDF as base64 |

### Performance

| Helper | Description |
|---|---|
| `block(["image","font","media","stylesheet"])` | Block resource types for faster scraping |
| `unblock()` | Remove all blocks |

### Cookies & state

| Helper | Description |
|---|---|
| `cookies(urls?)` | Read cookies |
| `setCookie({name, value, domain, path})` | Set cookies |
| `store` | Object that persists across calls within the container's lifetime |
| `log(...)` | Append to output |

### Debugging

| Helper | Description |
|---|---|
| `consoleLogs(n?)` | Last n page console messages |
| `net(n?, filter?)` | Last n network requests |

### Raw Playwright

The full Playwright API is available via `page` and `context`:

```javascript
// Query multiple elements
await page.$$eval('.item', els => els.map(e => e.textContent))

// Wait for a specific network response
const resp = await page.waitForResponse('**/api/data')

// Intercept requests
await page.route('**/ads/**', route => route.abort())

// Run JS in the page
await page.evaluate(() => document.title)
```

## Profiles

Every container starts with a fresh, empty profile. Use the profile API to export, import, and share login sessions between containers.

### Profile endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/profile/info` | GET | Cookie count, logged-in domains, profile size |
| `/profile/snapshot` | GET | Export current profile as tar.gz binary |
| `/profile/load` | POST | Import a tar.gz profile, restart browser with it |
| `/profile/reset` | POST | Wipe profile, restart with clean slate |

### Login once, share everywhere

```bash
# 1. Start a container, open /view in your browser, log in
docker run -d --name login -p 9200:9222 fast-browser
# Open http://localhost:9200/view → log in visually

# 2. Export the authenticated profile
curl http://localhost:9200/profile/snapshot -o session.tar.gz

# 3. Load into worker containers
for port in 9100 9101 9102; do
  curl -X POST http://localhost:$port/profile/load \
    -H "Content-Type: application/gzip" --data-binary @session.tar.gz
done
```

### Auto-seed on startup

Boot containers with a pre-loaded profile:

```bash
docker run -d --name browser -p 9100:9222 \
  -v ./session.tar.gz:/seed/profile.tar.gz \
  -e PROFILE_SEED=/seed/profile.tar.gz \
  fast-browser
```

## Multiple sessions

One container = one browser profile. Spin up many for parallel work:

```bash
# 5 independent sessions with persistent profiles
for i in $(seq 0 4); do
  docker run -d --name browser-$i -p $((9100+i)):9222 \
    -v browser-profile-$i:/data/profile fast-browser
done
```

Log into the same site with different accounts in each container, then crawl in parallel.

## Decider: decision models (optional)

Much of what an agent does in a browser is choosing: which element to click, what to do next, whether the page is done. An LLM makes each choice by generating text in its own turn, which takes seconds per click. A decision model scores a fixed set of options in one forward pass and answers in about 100–500 ms.

`decider/` runs the whole browser loop on a decision model. The agent sends a goal; the decision model makes every per-step pick (operation, target, done) and the decider executes it through fast-browser. The agent is called back only for what needs an LLM or a human: text to type when none of the supplied values fits, confirmation before a click that looks irreversible, and checking the end state. Nothing is Claude-specific; any agent that can make HTTP calls can drive it.

The loop is a port of [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT), which ran a Google Flights search in 7.1 s with 17 Jev calls. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

```
agent ── POST /task {goal, values} ──→ decider loop ── one SystemOne request per step ──→ Jev · LiquidAI d1
  ↑                                       │  POST /observe · POST /act (no code strings)
  └── needs_text / needs_confirmation /   ▼
      done / blocked / running        fast-browser (observe.js runs in the page)

agent ── POST /decide ──→ decider ── SystemOne ──→ any decision, not tied to the browser
agent ── POST /run ─────────────────────────────→ fast-browser   (direct, unchanged)
```

| Endpoint | Does |
|---|---|
| `POST /task` | Run a goal on the browser until it is done, blocked, or needs the agent |
| `POST /task/continue` | Answer a pause (`text` or `confirm`) or resume a blocked or running task |
| `POST /task/stop` | End a task |
| `GET /task?id=` | Full trace: every decision with top probabilities, confidence, latency and tokens |
| `POST /decide` | Any decision: `choice`, `noul` (yes/no), `score`. Several questions per call |
| `GET /health` | Model, provider URL, whether a key is set, browser URL |

It speaks the SystemOne protocol, which Jev (from TypeSafe or through OpenRouter), LiquidAI d1 and self-hosted Strands Decider servers all share, so switching between them is configuration only.

### Run it

Put the provider settings in `.env` next to `docker-compose.yml` (it is gitignored). For Jev through OpenRouter:

```bash
SYSTEMONE_URL=https://openrouter.ai/api/v1/systemone
SYSTEMONE_KEY=sk-or-...
```

Then:

```bash
docker compose up -d --build
curl http://localhost:9300/health
```

Compose starts the browser on `localhost:9222` (this image, with profile and screenshot volumes) and the decider on `localhost:9300`. Both ports bind to localhost only.

### Providers

| Provider | `.env` |
|---|---|
| Jev through OpenRouter | `SYSTEMONE_URL=https://openrouter.ai/api/v1/systemone`<br>`SYSTEMONE_KEY=<OpenRouter key>` |
| Jev from TypeSafe (default URL) | `SYSTEMONE_KEY=<TypeSafe key>` |
| LiquidAI d1 | `SYSTEMONE_URL=https://api.liquid.ai/decisions/v1/systemone`<br>`SYSTEMONE_MODEL=d1:free`<br>`SYSTEMONE_KEY=<Liquid key>` |
| Self-hosted Strands Decider, or any SystemOne server | `SYSTEMONE_URL=http://<host>:8000/v1/systemone` |

`SYSTEMONE_MODEL` defaults to `jev-latest`, which OpenRouter maps to its current Jev model; set `typesafe/jev-1.13` to pin a version. OpenRouter adds `usage.cost` to every answer. Jev reports output tokens in `usage`, but they are billed at $0; only input tokens cost money.

### `POST /task`

```bash
curl -X POST http://localhost:9300/task -H 'Content-Type: application/json' -d '{
  "goal": "Search for hotels in Lisbon with free cancellation and open the first result",
  "url": "https://hotels.example.com",
  "values": {"destination": "Lisbon"}
}'
```

| Field | Default | Description |
|---|---|---|
| `goal` | required | What to do, in plain words |
| `url` | | Opened before the loop starts, outside the clock |
| `values` | `{}` | Text the agent already knows, as name → string. The model matches a value to each field it types into, only on the site the task started on. Never put secrets here: values are sent to the provider (a value whose name looks secret, like `api_token`, is hidden from it but still typed) |
| `confirm` | `true` | Pause before clicks that look irreversible (pay, book, delete, send, post, submit an application) |
| `max_actions` | `60` | Browser actions per call (`1` gives step-wise control: each `/task/continue` takes one more step) |
| `max_decisions` | `120` | Model decisions per call |
| `max_ms` | `60000` | Time for this call, checked between steps |

```json
{"ok": true, "task": "t1", "status": "done",
 "steps": [{"n": 1, "op": "TYPE_TEXT", "target": "[2] textbox \"Destination\"", "text": "Lisbon", "p": 0.96, "ms": 380, "changed": true},
           {"n": 2, "op": "CLICK", "target": "[5] button \"Search\"", "p": 0.94, "ms": 410, "changed": true}],
 "page": {"url": "https://hotels.example.com/hotel/casa-flora", "title": "Casa Flora"},
 "final": {"url": "https://hotels.example.com/hotel/casa-flora", "title": "Casa Flora", "text": "Casa Flora ..."},
 "stats": {"actions": 5, "decisions": 6, "model_calls": 7, "elapsed_ms": 3120, "model_ms": 2210, "input_tokens": 9480, "cost": 0.0017},
 "elapsed_ms": 3120}
```

| `status` | Meaning | Agent's next call |
|---|---|---|
| `needs_text` | The model wants to type into `pending.field` and no value fits | `/task/continue {task, text}` (exact string, or `null` if unknown) |
| `needs_confirmation` | `pending.element` looks irreversible | `/task/continue {task, confirm: true \| false}` |
| `done` | The model says the goal is met. Not proof: check `final` or inspect with `/run` | none |
| `blocked` | The model can't go on, the page stopped changing, an outcome is unknown, or the agent declined | Fix it via `/run` or `/view`, then `/task/continue {task}` |
| `running` | `max_ms` ran out between steps | `/task/continue {task}` |
| `error` | A model or browser call failed | `/task/continue {task}` if `resumable` |

One task is active at a time. A new `/task` replaces an idle one; a replaced task can still be read with `GET /task` but `/task/continue` on it returns `409`.

`pending` carries the goal, the page (URL, title, up to 2,000 chars of text), the recent actions and instructions for the agent. Page text is untrusted: the instructions tell the agent never to follow it and never to invent personal information. [AGENTS.md](AGENTS.md) has the full workflow for agents.

How the loop works, per step:

1. `POST /observe` reads the viewport: visible text and every on-screen control as an action id. Select options are separate actions; scroll and wait are actions too.
2. One SystemOne request asks for the operation (`CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_DOWN`, `SCROLL_UP`, `WAIT`, `DONE`, `BLOCKED`) and the target for each kind at once. Answers are validated strictly; an invalid answer means no action.
3. `TYPE_TEXT` takes its text from a matching value (a second small decision) or pauses with `needs_text`. A risky `CLICK` gets a yes/no irreversibility check and may pause with `needs_confirmation`.
4. `POST /act` checks that the target is unchanged, visible and not covered, then acts. A stale page means the decision is dropped and re-made on a fresh observation; actions are never retried.
5. `DONE` and `BLOCKED` are accepted only after a re-observation shows the page settled. Three actions in a row (not counting waits) that change nothing stop the task as `blocked`.

### `POST /decide`

```bash
curl -X POST http://localhost:9300/decide -H 'Content-Type: application/json' -d '{
  "state": "User asked: what does the Vercel Pro plan cost?",
  "questions": {
    "tool":  {"type": "choice", "instructions": "Which tool answers this best?",
              "criteria": {"search": "web search", "browse": "open a known URL", "files": "read local files"}},
    "clear": {"type": "noul", "instructions": "Is the request specific enough to act on?"}
  }
}'
```

```json
{"ok": true,
 "answers": {"tool":  {"type": "choice", "choice": "search", "confidence": 0.97, "probabilities": {...}},
             "clear": {"type": "noul", "noul": 0.93}},
 "usage": {"input_tokens": 61, "output_tokens": 2}, "elapsed_ms": 190}
```

`score` questions take `criteria` as an ordered list of 2–10 levels and return a fractional `score`. The body is passed through to the provider, so a per-request `model` or provider-specific fields work.

### Safety

- fast-browser rejects a `Host` that is a dotted name other than localhost or an `ALLOWED_HOSTS` entry (IP literals and single-label Docker service names pass), and any `Origin` that is neither same-origin nor loopback/`ALLOWED_HOSTS`. There is no wildcard CORS. Pages the browser opens, or a DNS-rebinding page in your own browser, can't call `/run`.
- Ports bind to `127.0.0.1`. The decider sends no CORS headers and only accepts `application/json` POSTs. Every request's `Host` must be localhost, `127.0.0.1`, `::1` or a name in `ALLOWED_HOSTS`, and a foreign `Origin` is rejected, so web pages open in your own browser can't call it, even through DNS rebinding.
- Before page state goes to the provider, values and typed text of secret-looking fields are masked: password, PIN, OTP, one-time, verification and security codes, 2FA/MFA, card, CVV/CVC/CSC, SSN, secret, token, API/access/private keys, recovery or seed phrases, IBAN, account and routing numbers. A string typed from a secret-named value stays masked wherever it shows up later. Password, file and hidden inputs are never read.
- Supplied `values` are matched only on the site (registrable domain) the task first observed. On another site the task pauses with `needs_text` and a `pending.note`, so a link to a look-alike page can't harvest them.
- The browser is driven by action ids from an observation, not by code strings. `/act` refuses a target whose identity, label, value or state changed since the observation, or that is hidden, disabled or covered.
- Clicks that look irreversible pause for the agent's confirmation unless the task sets `confirm: false`.

### Decider environment variables

| Variable | Default | Description |
|---|---|---|
| `SYSTEMONE_URL` | `https://api.typesafe.ai/v1/systemone` | Decision endpoint (full URL) |
| `SYSTEMONE_MODEL` | `jev-latest` | Model sent with each request |
| `SYSTEMONE_KEY` | _(none)_ | Provider API key, sent as a Bearer token |
| `CONFIDENCE_MIN` | `0.5` | Minimum confidence for matching a supplied value to a field |
| `TIMEOUT_MS` | `15000` | Timeout for each upstream call |
| `BROWSER_URL` | `http://browser:9222` | fast-browser that `/task` drives |
| `BROWSER_KEY` | _(none)_ | fast-browser's `API_KEY`, if it has one |
| `API_KEY` | _(none)_ | Require `Authorization: Bearer <key>` on the decider's endpoints |
| `ALLOWED_HOSTS` | _(none)_ | Extra hostnames accepted in `Host` and `Origin`, comma-separated (e.g. `decider` when another container calls it) |
| `PORT` | `9300` | HTTP port |

Compose reads the first five from `.env`, plus `BROWSER_PORT` (default 9222) and `DECIDER_PORT` (default 9300). `BROWSER_KEY`, `API_KEY`, `ALLOWED_HOSTS` and `PORT` apply when you run the decider image directly or add them to `docker-compose.yml`.

## Tests

The test suite runs offline in Docker: a mock SystemOne server answers from a per-test script and serves HTML fixtures, so no API key is needed.

```bash
docker compose -f docker-compose.yml -f test/compose.test.yml up -d --build browser decider mock
docker compose -f docker-compose.yml -f test/compose.test.yml run --rm tests
```

The runner prints a `PASS` or `FAIL` line per case and a summary, and exits non-zero on any failure. It covers `/observe` and `/act` freshness and hit-testing, `snap()` refs, and the `/task` loop: pauses, confirmations, budgets, retries and the Host checks.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9222` | HTTP server port |
| `API_KEY` | _(none)_ | Set to require `Authorization: Bearer <key>` |
| `ALLOWED_HOSTS` | _(none)_ | Extra dotted hostnames accepted in `Host` and `Origin`, comma-separated |
| `STEP_TIMEOUT_MS` | `15000` | Hard deadline for one `/observe` or `/act` |
| `PROFILE_DIR` | `/data/profile` | Browser profile directory |
| `PROFILE_SEED` | _(none)_ | Path to a tar.gz profile snapshot — extracted on first startup if profile dir is empty |
| `SCREENSHOTS_DIR` | `/data/screenshots` | Directory for saved screenshots |
| `CHROME_BIN` | auto-detected | Path to Chromium/Chrome binary |

## Examples

**Login + scrape in one call:**

```javascript
await goto("https://app.example.com/login");
await fill("#email", "user@example.com");
await fill("#password", "secret");
await click("button[type=submit]");
await wait(".dashboard");
return await text(".dashboard-summary");
```

**Extract structured data:**

```javascript
await goto("https://news.ycombinator.com");
return await page.$$eval("tr.athing", rows => rows.slice(0, 10).map(r => ({
  title: r.querySelector(".titleline a")?.textContent,
  url: r.querySelector(".titleline a")?.href,
  rank: r.querySelector(".rank")?.textContent
})));
```

**Fast scraping with resource blocking:**

```javascript
await block(["image", "font", "media", "stylesheet"]);
await goto("https://example.com/products");
const data = await text();
await unblock();
return data;
```

## Architecture

```
┌─────────────┐  HTTP POST /run   ┌──────────────────────────────┐
│  Any Agent   │ ───────────────→ │  fast-browser container       │
│  (Claude,    │ ←─────────────── │  Node 22 + Chromium (Alpine)  │
│   Codex,     │   JSON result    │                               │
│   Python,    │                  │  Persistent browser session   │
│   curl)      │                  │  vm-based code execution      │
└─────────────┘                  │  Profile: /data/profile       │
                                 │  Snaps:   /data/screenshots   │
                                 └──────────────┬───────────────┘
┌─────────────┐  GET /view                      │
│  Human      │ ←───────────────────────────────┘
│  (browser)  │  Full browser: tabs, URL bar,
│             │  agent cursor, screenshot gallery
└─────────────┘
```

## License

MIT. The decision loop and the in-page observer are adapted from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, (c) 2026 Browser Use); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
