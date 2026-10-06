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

### `GET /view`

Opens a live interactive viewer in your browser. You can see the page, click on elements, type text, scroll, and press keys — all forwarded to the browser inside the container. Use this for login flows, CAPTCHAs, and debugging.

### `POST /interact`

Programmatic mouse/keyboard input (used by `/view` internally, also callable directly):

```json
{ "action": "click", "x": 640, "y": 400 }
{ "action": "type", "text": "hello" }
{ "action": "press", "key": "Enter" }
{ "action": "scroll", "dy": 300 }
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

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9222` | HTTP server port |
| `API_KEY` | _(none)_ | Set to require `Authorization: Bearer <key>` |
| `PROFILE_DIR` | `/data/profile` | Browser profile directory |
| `PROFILE_SEED` | _(none)_ | Path to a tar.gz profile snapshot — extracted on first startup if profile dir is empty |
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
└─────────────┘                  │  Profile dir: /data/profile   │
                                 └──────────────┬───────────────┘
┌─────────────┐  GET /view                      │
│  Human      │ ←───────────────────────────────┘
│  (browser)  │  Live viewer: see, click, type
└─────────────┘
```

## License

MIT
