# AGENTS.md — fast-browser for AI agents

You are an AI agent. This file tells you how to use `fast-browser`, a browser you control over HTTP. Read this entire file before your first browser call.

## Important rules

1. **Do not read or modify `server.mjs`.** It is a black box. Everything you need is in this file.
2. **Do not run `npm install` or `node server.mjs` locally.** Everything runs in Docker containers.
3. **Never ask the user for passwords.** Direct them to the live viewer URL and let them type credentials there. See "Login and authentication" below.
4. **Repo location:** `D:\github\fast-browser`. Use this path when you need to build the Docker image.

## Starting the server

**Default: use Docker.** The Docker image has Chromium built in — no local dependencies needed.

### Check if the image exists

```bash
docker images fast-browser --format "{{.Repository}}:{{.Tag}}"
```

If it prints `fast-browser:latest`, skip to "Run a container". Otherwise build it first:

```bash
docker build -t fast-browser .
```

### Run a container

```bash
docker run -d --name browser -p 9222:9222 fast-browser
```

For persistent logins (cookies survive container restarts):

```bash
docker run -d --name browser -p 9222:9222 -v browser-profile:/data/profile fast-browser
```

### Multiple containers (parallel sessions / different logins)

```bash
docker run -d --name browser-0 -p 9100:9222 -v profile-0:/data/profile fast-browser
docker run -d --name browser-1 -p 9101:9222 -v profile-1:/data/profile fast-browser
docker run -d --name browser-2 -p 9102:9222 -v profile-2:/data/profile fast-browser
```

Each container is an isolated browser with its own cookies, localStorage, and login state.

### Verify it's running

```bash
curl http://localhost:9222/health
# {"ok":true,"browser":"open","pages":1,"uptime_s":3}
```

If the container already exists but is stopped: `docker start browser`

## Login and authentication

**Never ask the user for passwords.** Instead:

1. Navigate to the login page: `POST /run {"code": "await goto('https://target.com/login')"}`
2. Tell the user: **"Open http://localhost:<port>/view in your browser to log in, then let me know when you're done."**
3. The user opens the live viewer, sees the login page, clicks and types their credentials directly.
4. Wait for the user to confirm.
5. The session (cookies, localStorage) is now saved in the container's profile.

To share the login across multiple containers, use profile snapshot/load (see "Profiles" below):
```bash
curl http://localhost:9222/profile/snapshot -o session.tar.gz
curl -X POST http://localhost:9100/profile/load -H "Content-Type: application/gzip" --data-binary @session.tar.gz
```

**If you encounter a login page**, do not attempt to fill credentials programmatically. Direct the user to the `/view` URL.

## Profiles

Every container starts with a **fresh, empty profile** by default — no cookies, no localStorage, nothing.

### Check profile status

```bash
curl http://localhost:9222/profile/info
# {"ok":true,"cookies":0,"domains":[],"profile_bytes":0}
```

### Export a profile (snapshot)

After logging in or building up session state, export it:

```bash
curl http://localhost:9222/profile/snapshot -o session.tar.gz
```

The browser pauses briefly while the snapshot is taken, then resumes automatically.

### Import a profile (load)

Load a previously exported snapshot into any container:

```bash
curl -X POST http://localhost:9100/profile/load \
  -H "Content-Type: application/gzip" --data-binary @session.tar.gz
# {"ok":true,"message":"Profile loaded","cookies":42}
```

The browser restarts with the imported profile. All cookies and localStorage from the snapshot are now active.

### Share one login across many containers

```bash
# 1. Snapshot the authenticated container
curl http://localhost:9222/profile/snapshot -o session.tar.gz

# 2. Load into every worker
curl -X POST http://localhost:9100/profile/load -H "Content-Type: application/gzip" --data-binary @session.tar.gz
curl -X POST http://localhost:9101/profile/load -H "Content-Type: application/gzip" --data-binary @session.tar.gz
curl -X POST http://localhost:9102/profile/load -H "Content-Type: application/gzip" --data-binary @session.tar.gz
```

**Note:** Session cookies (no expiry date) are lost during snapshot because the browser must close to flush state. Persistent cookies, localStorage, and IndexedDB all survive. Profile snapshots are cross-platform — a profile created on macOS works in a Linux Docker container and vice versa.

### Wipe profile and start over

```bash
curl -X POST http://localhost:9222/profile/reset
# {"ok":true,"message":"Profile reset to clean state"}
```

### Auto-seed on startup (Docker Compose / orchestration)

Boot a container with a pre-loaded profile — no API calls needed:

```bash
docker run -d --name browser -p 9100:9222 \
  -v ./session.tar.gz:/seed/profile.tar.gz \
  -e PROFILE_SEED=/seed/profile.tar.gz \
  fast-browser
```

## Connection

```
POST http://localhost:<port>/run
Content-Type: application/json

{"code": "<your JavaScript here>"}
```

The default port is `9222`. If multiple instances are running, each is on a different port. Check with `GET /health`.

## Seeing the browser

- **Live viewer**: Tell the user to open `http://localhost:<port>/view` in their browser. They can see the page, click, type, and scroll — useful for login and debugging.
- **Screenshot**: Call `GET /shot` to get a JPEG screenshot, or use `return await shot()` in your code. Save it to disk to inspect.

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

### Profile endpoints (HTTP, not code helpers)
- `GET /profile/info` → `{cookies, domains, profile_bytes}`
- `GET /profile/snapshot` → binary tar.gz of the profile directory
- `POST /profile/load` (body: tar.gz binary) → replaces profile, restarts browser
- `POST /profile/reset` → wipes profile, restarts with clean state

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
