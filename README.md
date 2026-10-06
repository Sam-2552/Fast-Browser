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
| `snap({limit?})` | Numbered list of interactive elements: `[3] button "Sign in"` |
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

Much of what an agent does in a browser is choosing: which element to click, which tool to call, whether a page is ready. An LLM makes each choice by generating text, which is slow and costs output tokens. A decision model scores a fixed set of options in one forward pass, generates nothing, and answers in about 100–500 ms.

`decider/` puts a decision model behind HTTP so any agent or LLM can use it. Jev, LiquidAI d1 and Strands Decider all speak the same SystemOne protocol, so switching between them is configuration only. The LLM keeps the work that needs text (form values, `/run` code, plans); the decider takes the picks.

```
agent ── POST /decide ──→ decider ── SystemOne ──→ Jev · LiquidAI d1 · Strands
agent ── POST /step ────→ decider ── POST /run ──→ fast-browser
agent ── POST /run ──────────────────────────────→ fast-browser   (direct, unchanged)
```

| Endpoint | Does |
|---|---|
| `POST /decide` | Any decision: `choice`, `noul` (yes/no), `score`. Several questions per call |
| `POST /step` | `snap()` → the model picks the element for your goal → performs the action → returns the new snapshot |
| `GET /health` | Model, provider URL, whether a key is set |

### Run it

```bash
echo SYSTEMONE_KEY=your-key > .env      # .env is gitignored
docker compose up -d --build
curl http://localhost:9300/health
```

Compose starts the browser on `localhost:9222` (this image, with profile and screenshot volumes) and the decider on `localhost:9300`. Both ports bind to localhost only.

### Providers

| Provider | `.env` |
|---|---|
| Jev (default) | `SYSTEMONE_KEY=...` |
| LiquidAI d1 | `SYSTEMONE_URL=https://api.liquid.ai/decisions/v1/systemone`<br>`SYSTEMONE_MODEL=d1:free`<br>`SYSTEMONE_KEY=...` |
| Strands Decider (self-hosted) | `COMPOSE_PROFILES=strands`<br>`SYSTEMONE_URL=http://strands:8000/v1/systemone`<br>`SYSTEMONE_MODEL=strands-decider` |

[Strands Decider](https://github.com/strands-labs/strands-decider) is an Apache 2.0 model that runs in its own container (`decider/strands.Dockerfile`, CPU). The first start downloads the 2B model (several GB) into the `strands-models` volume; watch it with `docker compose logs -f strands`. Decisions are slower on CPU than through the hosted APIs, so raise `TIMEOUT_MS` if you see 504s. Page content never leaves your machine.

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
 "usage": {"input_tokens": 61, "output_tokens": 0}, "elapsed_ms": 190}
```

`score` questions take `criteria` as an ordered list of 2–10 levels and return a fractional `score`. The body is passed through to the provider, so a per-request `model` or provider-specific fields work.

### `POST /step`

```bash
curl -X POST http://localhost:9300/step -H 'Content-Type: application/json' \
  -d '{"goal": "Search for wireless keyboards", "action": "fill", "value": "wireless keyboard"}'
```

| Field | Default | Description |
|---|---|---|
| `goal` | required | What to do, in plain words |
| `action` | `click` | `click` `dblclick` `hover` `focus` `check` `uncheck` `fill` `type` `select` |
| `value` | | For `fill` / `type` / `select`. Sent to the browser only, never to the provider |
| `min_confidence` | `0.5` | Below this, the action is skipped. Use `0.9` for actions you can't undo |
| `snap_opts` | `{}` | Passed to `snap()` |

On success the response has `ref`, `element`, `confidence`, and `snap_after` (the page after the action). `ok: false` always means nothing was performed:
- **Low confidence**: `candidates` lists the top three refs so the agent can choose.
- **No element fits**: the model chose the built-in "none of these" option.
- **Browser error**: the action failed in fast-browser.

### Safety

- Ports bind to `127.0.0.1`. The decider sends no CORS headers and only accepts `application/json` POSTs, so web pages open in your own browser can't call it.
- Before page state goes to the provider, values of password, PIN, OTP, card, CVV, SSN, secret and token fields are masked. `snap_after` is masked the same way.
- Snapshot lines are parsed strictly in order, so text hidden in a field value can't impersonate another element. A ref that such text collides with is dropped.
- Low-confidence picks are not executed, and the model can answer "none".

### Decider environment variables

| Variable | Default | Description |
|---|---|---|
| `SYSTEMONE_URL` | `https://api.typesafe.ai/v1/systemone` | Decision endpoint (full URL) |
| `SYSTEMONE_MODEL` | `jev-latest` | Model sent with each request |
| `SYSTEMONE_KEY` | _(none)_ | Provider API key, sent as a Bearer token |
| `CONFIDENCE_MIN` | `0.5` | Default `min_confidence` for `/step` |
| `TIMEOUT_MS` | `15000` | Timeout for each upstream call |
| `BROWSER_URL` | `http://browser:9222` | fast-browser that `/step` drives |
| `BROWSER_KEY` | _(none)_ | fast-browser's `API_KEY`, if it has one |
| `API_KEY` | _(none)_ | Require `Authorization: Bearer <key>` on `/decide` and `/step` |
| `PORT` | `9300` | HTTP port |

Compose reads the first five from `.env`, plus `BROWSER_PORT` (default 9222), `DECIDER_PORT` (default 9300) and `COMPOSE_PROFILES`. `BROWSER_KEY`, `API_KEY` and `PORT` apply when you run the decider image directly or add them to `docker-compose.yml`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9222` | HTTP server port |
| `API_KEY` | _(none)_ | Set to require `Authorization: Bearer <key>` |
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

MIT
