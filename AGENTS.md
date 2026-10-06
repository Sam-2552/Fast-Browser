# AGENTS.md — fast-browser for AI agents

You are an AI agent. This file tells you how to use `fast-browser`, a containerized browser you control over HTTP. Read this entire file before your first browser call.

## Connection

```
POST http://localhost:<port>/run
Content-Type: application/json

{"code": "<your JavaScript here>"}
```

The default port is `9222`. If multiple containers are running, each is on a different port. Check with `GET /health`.

## Core rule: batch your actions

Do NOT make one HTTP call per browser action. Bundle navigate + interact + extract into a single `code` string:

```json
{
  "code": "await goto('https://target.com/login'); await fill('#user', 'agent@test.com'); await fill('#pass', 'secret'); await click('#submit'); await wait('.dashboard'); return await text('.welcome-msg')"
}
```

This is what makes fast-browser fast. One round trip, not five.

## Response format

```json
{
  "ok": true,
  "output": "Welcome, Agent!\n[tab 1/1] Dashboard | https://target.com/dashboard  (890ms)",
  "elapsed_ms": 890
}
```

On error:
```json
{
  "ok": false,
  "error": "Timeout waiting for selector '#missing'",
  "elapsed_ms": 5012
}
```

Every response includes a footer line: `[tab N/M] Title | URL  (time)`.

## Workflow

### 1. Navigate to the page

```javascript
await goto("https://example.com")
```

Returns `{status, title, url}`. Waits for DOMContentLoaded (fast), not full load.

### 2. Understand the page

```javascript
return await snap()
```

Returns a numbered list of interactive elements:

```
[1] link "Home" → https://example.com/
[2] input[search] "Search" val=""
[3] button "Sign in"
[4] link "Products" → /products
```

Use these ref numbers in the next step.

### 3. Interact

```javascript
await fill(2, "search query")    // fill the search box (ref 2)
await click(3)                    // click "Sign in" (ref 3)
await press("Enter")              // keyboard
```

Ref numbers come from `snap()`. You can also use CSS selectors: `click("#submit")`.

### 4. Extract

```javascript
return await text()                           // all visible text
return await text(".results", 2000)           // specific element, max 2000 chars
return await page.$$eval("a", els =>          // structured extraction
  els.map(e => ({text: e.textContent, href: e.href}))
)
```

### 5. Repeat or close

Navigate to the next page with `goto()` or open a new tab with `newTab(url)`. The browser stays open between calls. State (`cookies`, `localStorage`, `store`) persists.

## Helper reference

### Navigation
- `goto(url)` → `{status, title, url}`
- `url()` → current URL string
- `title()` → current title string

### Inspection
- `snap({limit?})` → numbered interactive elements
- `text(selector?, max?)` → visible text
- `html(selector?)` → raw HTML
- `attr(selector, name)` → attribute value
- `consoleLogs(n?)` → page console messages
- `net(n?, filter?)` → network requests log

### Interaction
- `click(ref)` — click by snap ref or selector
- `dblclick(ref)` — double-click
- `fill(ref, value)` — clear + set (instant)
- `type(ref, value)` — character by character (triggers autocomplete)
- `select(ref, value)` — dropdown
- `check(ref)` / `uncheck(ref)` — checkboxes
- `hover(ref)` — tooltips, menus
- `focus(ref)` — focus element
- `press(key)` — keyboard: `"Enter"`, `"Tab"`, `"Escape"`, `"Control+a"`
- `scroll(dir, px?)` — `"down"` / `"up"` / `"left"` / `"right"`
- `wait(selector, opts?)` — wait for element (default 5s)

### Tabs
- `tabs()` → list of open tabs
- `tab(i)` → switch to tab i
- `newTab(url?)` → open new tab
- `close()` → close current tab

### Media
- `shot({full?, selector?})` → base64 JPEG
- `pdf()` → base64 PDF

### Speed
- `block(["image","font","media","stylesheet"])` — skip resources
- `unblock()` — remove blocks

### State
- `store.key = value` — persists across calls
- `cookies()` / `setCookie({...})` — browser cookies
- `log(...)` — append to output

### Raw Playwright
- `page` — live Playwright Page object
- `context` — BrowserContext
- `page.evaluate(fn)` — run JS in the page
- `page.$$eval(sel, fn)` — query + map
- `page.waitForResponse(pattern)` — wait for network
- `page.route(pattern, handler)` — intercept requests
- `fetch(url)` — server-side HTTP (not through browser)

## Error handling

Wrap risky actions:
```javascript
await goto("https://target.com");
try {
  await click("#optional-popup-close");
} catch {}
await fill("#search", "query");
return await text(".results");
```

Selector timeouts default to 5 seconds. Override per call:
```javascript
await click("#slow-element", { timeout: 15000 })
```

## Multiple containers

Each container is an isolated browser with its own cookies and profile. To work with multiple sessions:

```
Container browser-0 on :9100 → logged in as user A
Container browser-1 on :9101 → logged in as user B
Container browser-2 on :9102 → logged in as user C
```

Target the right port for each session.

## Anti-patterns

**❌ One action per call:**
```
POST /run  {"code": "await goto('https://example.com')"}
POST /run  {"code": "await fill('#q', 'test')"}
POST /run  {"code": "await click('#go')"}
POST /run  {"code": "return await text('.results')"}
```

**✅ All actions in one call:**
```
POST /run  {"code": "await goto('https://example.com'); await fill('#q', 'test'); await click('#go'); return await text('.results')"}
```

**❌ Requesting snap() before every action when you already know the selector:**
```
POST /run  {"code": "return await snap()"}            // unnecessary
POST /run  {"code": "await click('#known-button')"}
```

**✅ Use snap() only when you need to discover what's on the page:**
```
POST /run  {"code": "await goto('https://unknown-site.com'); return await snap()"}
// Now you know the refs — use them
POST /run  {"code": "await click(3); await fill(7, 'data'); return await text('.result')"}
```

## Timeouts

| Default | What |
|---|---|
| 5s | Element actions (click, fill, wait) |
| 20s | Navigation (goto) |
| 30s | Overall request (override with `timeout_ms`) |

## Output

- `return value` → added to output (strings as-is, objects as JSON)
- `log(...)` → appended to output
- `console.log(...)` → same as `log()`
- Footer line added automatically: `[tab N/M] Title | URL  (time)`
- Output capped at 8000 chars by default (override with `max_output`)
