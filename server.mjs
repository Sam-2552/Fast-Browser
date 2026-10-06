// server.mjs — fast-browser: lean browser automation for any agent
// One endpoint, persistent browser, compact helpers, minimal output.
// Docker: docker run -d -p 9100:9222 fast-browser
// Then:   curl -X POST http://localhost:9100/run -H 'Content-Type: application/json' \
//           -d '{"code":"await goto(\"https://example.com\"); return await text()"}'

import http from 'node:http';
import vm from 'node:vm';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

// ── Config ──────────────────────────────────────────────────────────
const PORT    = +(process.env.PORT || 9222);
const API_KEY = process.env.API_KEY || '';
const HEADED  = process.env.HEADED === '1';
const PROFILE = process.env.PROFILE_DIR || '/data/profile';
const CHROME  = process.env.CHROME_BIN || detect();
const ACT_MS  = 5000;   // element-action timeout
const NAV_MS  = 20000;  // navigation timeout
const RING    = 200;     // console/network ring buffer size
const T0      = Date.now();

function detect() {
  for (const p of ['/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'])
    if (existsSync(p)) return p;
  // Windows / macOS fallbacks for local dev
  for (const p of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'])
    if (existsSync(p)) return p;
  return 'chromium-browser';
}

// ── State ───────────────────────────────────────────────────────────
let ctx     = null;   // BrowserContext (persistent)
let pages   = [];
let pi      = 0;      // current page index
let store   = {};     // persists across calls within container lifetime
let outBuf  = [];     // output buffer for current execution
let netRing = [];
let conRing = [];
let blocked = new Set();

const P = () => pages[pi]; // current page shorthand

// ── Browser lifecycle ───────────────────────────────────────────────
let launching = null;

async function ensure() {
  if (ctx) {
    try { ctx.pages(); return; } catch { ctx = null; }
  }
  if (launching) return launching;
  launching = (async () => {
    try {
      if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true });
      ctx = await chromium.launchPersistentContext(PROFILE, {
        executablePath: CHROME,
        headless: !HEADED,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-gpu', '--disable-extensions', '--disable-background-networking',
          '--disable-default-apps', '--disable-sync', '--no-first-run',
          '--disable-translate', '--mute-audio', '--hide-scrollbars',
        ],
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
        bypassCSP: true,
      });
      pages = ctx.pages();
      if (!pages.length) pages.push(await ctx.newPage());
      pi = 0;
      pages.forEach(wire);
      ctx.on('page', p => { pages.push(p); wire(p); });
    } finally {
      launching = null;
    }
  })();
  return launching;
}

function wire(p) {
  p.on('console', m => {
    conRing.push(`[${m.type()}] ${m.text()}`);
    if (conRing.length > RING) conRing.shift();
  });
  p.on('response', resp => {
    const req = resp.request();
    netRing.push({ m: req.method(), u: req.url(), t: req.resourceType(), s: resp.status() });
    if (netRing.length > RING) netRing.shift();
  });
  p.on('requestfailed', r => {
    netRing.push({ m: r.method(), u: r.url(), t: r.resourceType(), s: 'FAIL' });
    if (netRing.length > RING) netRing.shift();
  });
  p.on('close', () => {
    const i = pages.indexOf(p);
    if (i >= 0) pages.splice(i, 1);
    if (pi >= pages.length) pi = Math.max(0, pages.length - 1);
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

// Navigation
async function goto(url) {
  const r = await P().goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS });
  return { status: r?.status() ?? 0, title: await P().title(), url: P().url() };
}
function url() { return P().url(); }
async function title() { return P().title(); }

// Snapshot — compact interactive-element listing
async function snap(opts = {}) {
  const lim = opts.limit ?? 150;
  const items = await P().evaluate(lim => {
    const S = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],' +
      '[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],' +
      '[role="textbox"],[contenteditable="true"],summary';
    const all = [...document.querySelectorAll(S)];
    // Walk open shadow roots
    const walk = r => {
      for (const el of r.querySelectorAll('*'))
        if (el.shadowRoot) { all.push(...el.shadowRoot.querySelectorAll(S)); walk(el.shadowRoot); }
    };
    walk(document);
    let n = 0;
    return all.reduce((acc, el) => {
      if (n >= lim) return acc;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return acc;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return acc;
      n++;
      el.setAttribute('data-fb', String(n));
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const type = el.getAttribute('type') || '';
      const txt = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const ph = el.placeholder || '';
      const aria = el.getAttribute('aria-label') || '';
      const val = 'value' in el ? String(el.value || '').slice(0, 30) : '';
      const href = tag === 'a' ? (el.href || '').slice(0, 120) : '';
      const chk = (type === 'checkbox' || type === 'radio') ? el.checked : null;
      const desc = tag === 'a' ? 'link'
        : (tag === 'button' || role === 'button') ? 'button'
        : (tag === 'input' || tag === 'textarea') ? `${tag}${type ? '[' + type + ']' : ''}`
        : tag === 'select' ? 'select' : (role || tag);
      const label = txt || aria || ph || el.name || '';
      acc.push({ n, desc, label, val, href, chk });
      return acc;
    }, []);
  }, lim);
  return items.map(e => {
    let s = `[${e.n}] ${e.desc}`;
    if (e.label) s += ` "${e.label}"`;
    if (e.val)   s += ` val="${e.val}"`;
    if (e.chk === true)  s += ' ✓';
    if (e.chk === false) s += ' ○';
    if (e.href) s += ` → ${e.href}`;
    return s;
  }).join('\n');
}

// Element interaction — ref can be a snap number or a CSS/text selector
const loc = r => (typeof r === 'number' || (typeof r === 'string' && /^\d+$/.test(r)))
  ? P().locator(`[data-fb="${r}"]`) : P().locator(String(r));

async function click(r, o)    { await loc(r).click({ timeout: ACT_MS, ...o }); }
async function dblclick(r, o) { await loc(r).dblclick({ timeout: ACT_MS, ...o }); }
async function fill(r, v)     { await loc(r).fill(String(v), { timeout: ACT_MS }); }
async function selectOpt(r, v){ await loc(r).selectOption(v, { timeout: ACT_MS }); }
async function type(r, v, o)  { await loc(r).pressSequentially(String(v), { timeout: ACT_MS, delay: 50, ...o }); }
async function check(r)       { await loc(r).check({ timeout: ACT_MS }); }
async function uncheck(r)     { await loc(r).uncheck({ timeout: ACT_MS }); }
async function hover(r)       { await loc(r).hover({ timeout: ACT_MS }); }
async function focus(r)       { await loc(r).focus({ timeout: ACT_MS }); }

// Content extraction
async function text(sel, max = 4000) {
  const raw = await P().innerText(sel || 'body', { timeout: ACT_MS });
  const c = raw.replace(/\s+/g, ' ').trim();
  return c.length > max ? c.slice(0, max) + `\n…(truncated at ${max})` : c;
}
async function html(sel) {
  return sel ? await P().innerHTML(sel, { timeout: ACT_MS }) : await P().content();
}
async function getAttr(sel, name) {
  return P().getAttribute(sel, name, { timeout: ACT_MS });
}

// Waiting & keyboard
async function waitFor(sel, o = {}) { await P().locator(sel).waitFor({ timeout: ACT_MS, ...o }); }
async function press(key)          { await P().keyboard.press(key); }
async function scroll(dir = 'down', px = 500) {
  const m = { down: [0, px], up: [0, -px], right: [px, 0], left: [-px, 0] };
  await P().mouse.wheel(...(m[dir] || [0, px]));
}

// Tabs
function tabsList() { return pages.map((p, i) => `[${i}]${i === pi ? '*' : ''} ${p.url()}`).join('\n'); }
function switchTab(i) { pi = Math.max(0, Math.min(i, pages.length - 1)); return pages[pi]; }
async function newTab(u) {
  const p = await ctx.newPage();
  pi = pages.indexOf(p);
  if (u) await p.goto(u, { waitUntil: 'domcontentloaded', timeout: NAV_MS });
  return p;
}
async function closeTab() { if (pages.length > 1) await P().close(); }

// Screenshot & PDF
async function shot(o = {}) {
  const opts = { type: 'jpeg', quality: 75 };
  if (o.full) opts.fullPage = true;
  const buf = o.selector
    ? await P().locator(o.selector).screenshot(opts)
    : await P().screenshot(opts);
  return buf.toString('base64');
}
async function pdf() { return (await P().pdf()).toString('base64'); }

// Resource blocking — skip images/fonts/media for speed
async function blockRes(types) {
  blocked = new Set(types);
  for (const p of pages) {
    try { await p.unroute('**/*'); } catch {}
    if (blocked.size)
      await p.route('**/*', r => blocked.has(r.request().resourceType()) ? r.abort() : r.continue());
  }
}
async function unblockRes() { return blockRes([]); }

// Cookies
async function getCookies(urls) { return ctx.cookies(urls); }
async function addCookies(...c) { await ctx.addCookies(c.flat()); }

// Logs
function net(n = 20, f) {
  let e = netRing.slice(-n);
  if (f) e = e.filter(x => x.u.includes(f) || x.t === f);
  return e.map(x => `${x.m} ${x.s ?? '…'} ${x.t} ${x.u.slice(0, 120)}`).join('\n');
}
function consoleLogs(n = 20) { return conRing.slice(-n).join('\n'); }
function log(...a) {
  outBuf.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
}

// ── VM sandbox ──────────────────────────────────────────────────────
const sandbox = {};

// Copy standard JS globals so code works naturally
const GLOBALS = [
  'Array','ArrayBuffer','BigInt','Boolean','DataView','Date','Error','Float32Array',
  'Float64Array','Int8Array','Int16Array','Int32Array','Infinity','JSON','Map','Math',
  'NaN','Number','Object','Promise','Proxy','Reflect','RegExp','Set','String','Symbol',
  'TypeError','RangeError','SyntaxError','ReferenceError','URIError',
  'Uint8Array','Uint8ClampedArray','Uint16Array','Uint32Array','WeakMap','WeakSet',
  'parseInt','parseFloat','isNaN','isFinite','undefined',
  'encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
  'atob','btoa','URL','URLSearchParams','Buffer','TextEncoder','TextDecoder',
  'setTimeout','clearTimeout','setInterval','clearInterval',
  'structuredClone','queueMicrotask','AbortController','AbortSignal',
];
for (const k of GLOBALS) if (globalThis[k] !== undefined) sandbox[k] = globalThis[k];
sandbox.fetch = globalThis.fetch;

vm.createContext(sandbox);

// Live getters — always return the current page/context
Object.defineProperty(sandbox, 'page',    { get: () => pages[pi], configurable: true });
Object.defineProperty(sandbox, 'context', { get: () => ctx,       configurable: true });

// Persistent store
sandbox.store = store;

// All helpers
sandbox.goto       = goto;
sandbox.url        = url;
sandbox.title      = title;
sandbox.snap       = snap;
sandbox.click      = click;
sandbox.dblclick   = dblclick;
sandbox.fill       = fill;
sandbox.select     = selectOpt;
sandbox.type       = type;
sandbox.check      = check;
sandbox.uncheck    = uncheck;
sandbox.hover      = hover;
sandbox.focus      = focus;
sandbox.text       = text;
sandbox.html       = html;
sandbox.attr       = getAttr;
sandbox.wait       = waitFor;
sandbox.press      = press;
sandbox.scroll     = scroll;
sandbox.tabs       = tabsList;
sandbox.tab        = switchTab;
sandbox.newTab     = newTab;
sandbox.close      = closeTab;
sandbox.shot       = shot;
sandbox.pdf        = pdf;
sandbox.block      = blockRes;
sandbox.unblock    = unblockRes;
sandbox.cookies    = getCookies;
sandbox.setCookie  = addCookies;
sandbox.consoleLogs = consoleLogs;
sandbox.net        = net;
sandbox.log        = log;

// Override console to capture output instead of printing to stdout (stdout = MCP channel)
sandbox.console = { log, warn: log, error: log, info: log, dir: log, table: log };

// ── Code execution ──────────────────────────────────────────────────
async function exec(code, tmo = 30000, maxOut = 8000) {
  await ensure();
  outBuf = [];
  const t0 = Date.now();

  // Try as auto-return expression; fall back to statements
  let script;
  try {
    script = new vm.Script(`(async()=>{return(${code})})()`, { filename: 'run.js' });
  } catch (e) {
    if (e instanceof SyntaxError)
      script = new vm.Script(`(async()=>{${code}})()`, { filename: 'run.js' });
    else throw e;
  }

  // Race: vm execution vs hard timeout
  const result = await Promise.race([
    script.runInContext(sandbox, { timeout: tmo, breakOnSigint: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout (${tmo}ms)`)), tmo)),
  ]);

  const elapsed = Date.now() - t0;

  // Assemble output
  let out = '';
  if (outBuf.length) out = outBuf.join('\n');
  if (result !== undefined && result !== null) {
    const val = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (out) out += '\n';
    out += val;
  }
  if (out.length > maxOut)
    out = out.slice(0, maxOut) + `\n…(truncated at ${maxOut})`;

  // Footer: current tab info + timing
  const p = P();
  const footer = p
    ? `[tab ${pi + 1}/${pages.length}] ${await p.title().catch(() => '')} | ${p.url()}  (${elapsed}ms)`
    : `(${elapsed}ms)`;
  out += (out ? '\n' : '') + footer;

  return { ok: true, output: out, elapsed_ms: elapsed };
}

// ── HTTP server ─────────────────────────────────────────────────────
function trimErr(e) {
  let m = e.message || String(e);
  const i = m.indexOf('Call log:');
  if (i > 0) m = m.slice(0, i).trim();
  const lines = m.split('\n');
  return lines.length > 6 ? lines.slice(0, 6).join('\n') + '\n…' : m;
}

function readBody(req) {
  return new Promise((ok, no) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) { req.destroy(); no(new Error('Body too large')); } });
    req.on('end', () => ok(d));
    req.on('error', no);
  });
}

function jsonRes(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

// Serialize requests so parallel calls don't race on the page
let lock = Promise.resolve();
function serial(fn) {
  const p = lock.catch(() => {}).then(fn);
  lock = p.catch(() => {});
  return p;
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Auth
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`)
    return jsonRes(res, 401, { ok: false, error: 'Unauthorized' });

  const path = new URL(req.url, 'http://x').pathname;

  // ── GET /health ─────────────────────────────────────────────────
  if (path === '/health') {
    return jsonRes(res, 200, {
      ok: true,
      browser: ctx ? 'open' : 'closed',
      pages: pages.length,
      uptime_s: Math.round((Date.now() - T0) / 1000),
    });
  }

  // ── POST /run ───────────────────────────────────────────────────
  if (path === '/run' && req.method === 'POST') {
    return serial(async () => {
      const t0 = Date.now();
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw);
        if (!body.code) return jsonRes(res, 400, { ok: false, error: 'Missing "code" field' });
        const r = await exec(body.code, body.timeout_ms, body.max_output);
        jsonRes(res, 200, r);
      } catch (e) {
        jsonRes(res, 200, { ok: false, error: trimErr(e), elapsed_ms: Date.now() - t0 });
      }
    });
  }

  // ── POST /shot ──────────────────────────────────────────────────
  if (path === '/shot' && (req.method === 'POST' || req.method === 'GET')) {
    return serial(async () => {
      try {
        await ensure();
        let body = {};
        if (req.method === 'POST' && req.headers['content-length'] > '0') {
          try { body = JSON.parse(await readBody(req)); } catch {}
        }
        const opts = { type: 'jpeg', quality: 75 };
        if (body.full) opts.fullPage = true;
        const buf = body.selector
          ? await P().locator(body.selector).screenshot(opts)
          : await P().screenshot(opts);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
        res.end(buf);
      } catch (e) {
        jsonRes(res, 500, { ok: false, error: trimErr(e) });
      }
    });
  }

  // ── 404 ─────────────────────────────────────────────────────────
  jsonRes(res, 404, {
    ok: false,
    error: 'Not found. Endpoints: POST /run, POST|GET /shot, GET /health',
  });
});

// ── Start ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
  process.stderr.write(`fast-browser :${PORT}  chrome=${CHROME}  profile=${PROFILE}\n`);
  // Eager browser launch — ready for the first request
  ensure().catch(e => process.stderr.write(`browser deferred: ${e.message}\n`));
});

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    process.stderr.write(`${sig} received, shutting down…\n`);
    if (ctx) await ctx.close().catch(() => {});
    server.close();
    process.exit(0);
  });
}
