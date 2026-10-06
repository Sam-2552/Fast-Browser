// server.mjs — fast-browser: lean browser automation for any agent
// One endpoint, persistent browser, compact helpers, minimal output.
// Docker: docker run -d -p 9100:9222 fast-browser
// Then:   curl -X POST http://localhost:9100/run -H 'Content-Type: application/json' \
//           -d '{"code":"await goto(\"https://example.com\"); return await text()"}'

import http from 'node:http';
import vm from 'node:vm';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
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
let lastAction = null;  // last /interact action (for viewer cursor)
let busy = false;       // true while /run is executing

const P = () => pages[pi]; // current page shorthand

function clearDir(dir) {
  try {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
  } catch {}
}

function tar(mode, archive, dir) {
  const a = archive.replace(/\\/g, '/');
  const d = dir.replace(/\\/g, '/');
  const flag = mode === 'c' ? '-czf' : '-xzf';
  const dot = mode === 'c' ? ' .' : '';
  try {
    execSync(`tar ${flag} "${a}" -C "${d}"${dot}`, { timeout: 30000 });
  } catch (e) {
    if (/remote shell/i.test(String(e.stderr || e.message))) {
      execSync(`tar --force-local ${flag} "${a}" -C "${d}"${dot}`, { timeout: 30000 });
    } else throw e;
  }
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (ent.isFile()) {
        try { total += statSync(join(ent.parentPath ?? ent.path ?? dir, ent.name)).size; } catch {}
      }
    }
  } catch {}
  return total;
}

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

async function restartBrowser() {
  if (ctx) { try { await ctx.close(); } catch {} }
  ctx = null;
  pages = [];
  pi = 0;
  netRing = [];
  conRing = [];
  blocked = new Set();
  launching = null;
  await ensure();
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

function readBodyBin(req, max = 200e6) {
  return new Promise((ok, no) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > max) { req.destroy(); return no(new Error(`Body too large (>${Math.round(max / 1e6)}MB)`)); }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
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

  // ── GET /state ───────────────────────────────────────────────────
  if (path === '/state' && req.method === 'GET') {
    const p = P();
    const tabList = pages.map((pg, i) => {
      try { return { i, active: i === pi, url: pg.url(), title: pg.url() }; } catch { return { i, active: i === pi, url: '', title: '' }; }
    });
    return jsonRes(res, 200, {
      ok: true,
      url: p ? p.url() : '',
      tabs: tabList,
      busy,
      lastAction,
    });
  }

  // ── POST /run ───────────────────────────────────────────────────
  if (path === '/run' && req.method === 'POST') {
    return serial(async () => {
      busy = true;
      const t0 = Date.now();
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw);
        if (!body.code) return jsonRes(res, 400, { ok: false, error: 'Missing "code" field' });
        const r = await exec(body.code, body.timeout_ms, body.max_output);
        jsonRes(res, 200, r);
      } catch (e) {
        jsonRes(res, 200, { ok: false, error: trimErr(e), elapsed_ms: Date.now() - t0 });
      } finally {
        busy = false;
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

  // ── GET /view ────────────────────────────────────────────────────
  if (path === '/view' && req.method === 'GET') {
    const viewHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>fast-browser</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a2e;color:#eee;font:13px/1.3 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#chrome{flex-shrink:0;background:#16213e}
#tabs{display:flex;gap:1px;padding:4px 8px 0;background:#0f1629;overflow-x:auto;scrollbar-width:thin}
.tab{display:flex;align-items:center;gap:6px;padding:6px 12px;background:#1a1a2e;border-radius:8px 8px 0 0;cursor:pointer;max-width:200px;min-width:60px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#8899aa;transition:background .15s}
.tab:hover{background:#243456}.tab.active{background:#16213e;color:#fff}
.tab-title{overflow:hidden;text-overflow:ellipsis}
.tab-close{opacity:.4;font-size:14px;line-height:1;padding:0 2px;border-radius:3px}
.tab-close:hover{opacity:1;background:rgba(255,255,255,.15)}
#nav{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#16213e;border-bottom:1px solid #0d1117}
#nav button{width:28px;height:28px;background:none;border:1px solid transparent;border-radius:6px;color:#8899aa;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center}
#nav button:hover{background:#243456;border-color:#334466;color:#fff}
#urlbar{flex:1;padding:5px 10px;background:#0f1629;color:#cdd;border:1px solid #2a3a5c;border-radius:6px;font:12px/1.4 monospace;outline:none}
#urlbar:focus{border-color:#4488cc}
#busy-dot{width:8px;height:8px;border-radius:50%;background:#555;margin-left:4px;transition:background .3s}
#busy-dot.active{background:#f44;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
#busy-label{font-size:11px;color:#888;margin-left:2px}
#viewport{flex:1;position:relative;overflow:hidden;display:flex;justify-content:center;align-items:center;background:#111}
#viewport canvas{cursor:crosshair;max-width:100%;max-height:100%;object-fit:contain}
#toolbar{display:flex;gap:5px;padding:6px 10px;background:#16213e;border-top:1px solid #0d1117;flex-shrink:0;flex-wrap:wrap;align-items:center}
#toolbar input[type=text]{padding:4px 8px;background:#0f1629;color:#eee;border:1px solid #2a3a5c;border-radius:5px;font:12px system-ui;width:220px}
#toolbar input[type=text]:focus{border-color:#4488cc;outline:none}
#toolbar button{padding:4px 10px;background:#243456;color:#aabbcc;border:1px solid #2a3a5c;border-radius:5px;cursor:pointer;font:12px system-ui;transition:all .15s}
#toolbar button:hover{background:#2a5a8a;color:#fff;border-color:#4488cc}
#toolbar button.accent{background:#1a6;color:#fff;border-color:#1a6}
#toolbar button.accent:hover{background:#2b8}
#toolbar button.warn{background:#a33;color:#fff;border-color:#a33}
#toolbar button.warn:hover{background:#c44}
.sep{width:1px;height:22px;background:#2a3a5c;flex-shrink:0}
#snap-count{font-size:11px;color:#8899aa;margin-left:auto}
#gallery{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:100;overflow-y:auto;padding:20px}
#gallery.open{display:block}
#gallery-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
#gallery-header h2{font-size:16px;color:#eee;font-weight:500}
#gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.snap-card{background:#1a1a2e;border:1px solid #2a3a5c;border-radius:8px;overflow:hidden;cursor:pointer;transition:border-color .15s}
.snap-card:hover{border-color:#4488cc}
.snap-card img{width:100%;display:block}
.snap-card .meta{padding:8px;font-size:11px;color:#8899aa;display:flex;justify-content:space-between}
</style></head><body>
<div id="chrome">
<div id="tabs"></div>
<div id="nav">
<button onclick="navBack()" title="Back">&#9664;</button>
<button onclick="navFwd()" title="Forward">&#9654;</button>
<button onclick="navReload()" title="Reload">&#8635;</button>
<input id="urlbar" type="text" value="" spellcheck="false" placeholder="URL">
<div id="busy-dot"></div><span id="busy-label"></span>
<button onclick="takeSnap()" title="Screenshot" style="margin-left:6px;font-size:16px">&#128247;</button>
<button onclick="openGallery()" title="Screenshots" style="font-size:14px">&#128193;</button>
</div>
</div>
<div id="viewport">
<canvas id="c" width="1280" height="800"></canvas>
</div>
<div id="toolbar">
<input id="inp" type="text" placeholder="Type text, press Enter to send" autocomplete="off">
<button class="accent" onclick="sendType()">Type</button>
<div class="sep"></div>
<button onclick="sk('Enter')">Enter</button>
<button onclick="sk('Tab')">Tab</button>
<button onclick="sk('Escape')">Esc</button>
<button onclick="sk('Backspace')">Bksp</button>
<div class="sep"></div>
<button onclick="post('/interact',{action:'scroll',dy:-400})">&#9650; Scroll</button>
<button onclick="post('/interact',{action:'scroll',dy:400})">&#9660; Scroll</button>
<span id="snap-count"></span>
</div>
<div id="gallery">
<div id="gallery-header"><h2>Screenshots</h2><button onclick="closeGallery()" style="background:#a33;color:#fff;border:none;padding:6px 14px;border-radius:5px;cursor:pointer">Close</button></div>
<div id="gallery-grid"></div>
</div>
<script>
const c=document.getElementById('c'),cx=c.getContext('2d');
const urlbar=document.getElementById('urlbar'),inp=document.getElementById('inp');
const busyDot=document.getElementById('busy-dot'),busyLabel=document.getElementById('busy-label');
const tabsEl=document.getElementById('tabs'),snapCount=document.getElementById('snap-count');
let vw=1280,vh=800,clickRings=[],cursorTs=null,cursorX=0,cursorY=0,lastImg=null;

async function post(u,d){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})}

async function pollState(){
  try{const r=await fetch('/state');if(!r.ok)return;const s=await r.json();
    urlbar.value=s.url||'';
    if(s.busy){busyDot.classList.add('active');busyLabel.textContent='Agent working...';}
    else{busyDot.classList.remove('active');busyLabel.textContent='';}
    if(s.lastAction&&s.lastAction.ts&&(s.lastAction.action==='click'||s.lastAction.action==='dblclick')){
      cursorX=s.lastAction.x;cursorY=s.lastAction.y;cursorTs=s.lastAction.ts;
    }
    let tabHtml='';
    (s.tabs||[]).forEach(t=>{
      const u=t.url||'about:blank';const short=u.replace(/^https?:\\/\\//,'').slice(0,30);
      tabHtml+='<div class="tab'+(t.active?' active':'')+'" onclick="switchTab('+t.i+')" title="'+u.replace(/"/g,'&quot;')+'"><span class="tab-title">'+short+'</span></div>';
    });
    tabsEl.innerHTML=tabHtml;
  }catch{}
}

async function pollShot(){
  try{const r=await fetch('/shot');if(!r.ok)throw 0;const b=await r.blob();
    lastImg=await createImageBitmap(b);
    if(lastImg.width!==vw||lastImg.height!==vh){vw=lastImg.width;vh=lastImg.height;c.width=vw;c.height=vh;}
  }catch{}}

function render(){
  if(lastImg){cx.drawImage(lastImg,0,0);}
  const now=Date.now();
  clickRings=clickRings.filter(r=>{
    const age=now-r.t;if(age>1500)return false;
    const a=1-age/1500;const sz=10+age/40;
    cx.beginPath();cx.arc(r.x,r.y,sz,0,Math.PI*2);
    cx.strokeStyle='rgba(255,60,60,'+a+')';cx.lineWidth=2.5;cx.stroke();
    cx.beginPath();cx.arc(r.x,r.y,4,0,Math.PI*2);
    cx.fillStyle='rgba(255,60,60,'+a*0.6+')';cx.fill();
    return true;
  });
  if(cursorTs){
    const age=now-cursorTs;
    if(age<4000){
      const a=Math.max(0,1-age/4000);
      cx.save();cx.globalAlpha=a;
      cx.translate(cursorX,cursorY);
      cx.fillStyle='#44aaff';cx.strokeStyle='#fff';cx.lineWidth=1.5;
      cx.beginPath();
      cx.moveTo(0,0);cx.lineTo(0,24);cx.lineTo(7,18);cx.lineTo(12,28);cx.lineTo(16,26);cx.lineTo(11,16);cx.lineTo(18,14);cx.closePath();
      cx.fill();cx.stroke();
      cx.font='bold 11px system-ui';cx.fillStyle='rgba(68,170,255,'+a+')';
      cx.fillText('Agent',20,10);
      cx.restore();
    }else{cursorTs=null;}
  }
  requestAnimationFrame(render);
}

async function loop(){await Promise.all([pollState(),pollShot()]);setTimeout(loop,400);}
loop();render();

function canvasCoords(e){const r=c.getBoundingClientRect();
  return{x:Math.round((e.clientX-r.left)/r.width*vw),y:Math.round((e.clientY-r.top)/r.height*vh)};}

c.addEventListener('click',async e=>{const{x,y}=canvasCoords(e);
  clickRings.push({x,y,t:Date.now()});await post('/interact',{action:'click',x,y});});
c.addEventListener('dblclick',async e=>{const{x,y}=canvasCoords(e);
  clickRings.push({x,y,t:Date.now()});await post('/interact',{action:'dblclick',x,y});});
c.addEventListener('wheel',async e=>{e.preventDefault();
  await post('/interact',{action:'scroll',dy:e.deltaY>0?300:-300});},{passive:false});

async function sendType(){const t=inp.value;if(!t)return;await post('/interact',{action:'type',text:t});inp.value='';}
async function sk(k){await post('/interact',{action:'press',key:k});}
inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();sendType();}});
urlbar.addEventListener('keydown',async e=>{if(e.key==='Enter'){e.preventDefault();
  await post('/run',{code:'await goto("'+urlbar.value.replace(/"/g,'\\\\"')+'")'});}});

async function switchTab(i){await post('/run',{code:'tab('+i+')'});}
async function navBack(){await post('/run',{code:'await page.goBack({timeout:10000}).catch(()=>null)'});}
async function navFwd(){await post('/run',{code:'await page.goForward({timeout:10000}).catch(()=>null)'});}
async function navReload(){await post('/run',{code:'await page.reload({timeout:15000}).catch(()=>null)'});}

async function takeSnap(){
  try{
    const TAB_H=30,NAV_H=40,TB_H=34,pad=10;
    const W=vw,H=TAB_H+NAV_H+vh+TB_H;
    const comp=document.createElement('canvas');comp.width=W;comp.height=H;
    const g=comp.getContext('2d');
    g.fillStyle='#0f1629';g.fillRect(0,0,W,TAB_H);
    g.font='12px system-ui,sans-serif';
    let tx=10;
    document.querySelectorAll('.tab').forEach(t=>{
      const active=t.classList.contains('active');
      g.fillStyle=active?'#16213e':'#1a1a2e';
      const tw=Math.min(180,g.measureText(t.textContent).width+24);
      g.beginPath();g.roundRect(tx,4,tw,TAB_H-4,4);g.fill();
      g.fillStyle=active?'#fff':'#8899aa';
      g.fillText(t.textContent,tx+12,20);tx+=tw+2;});
    g.fillStyle='#16213e';g.fillRect(0,TAB_H,W,NAV_H);
    g.strokeStyle='#0d1117';g.lineWidth=1;g.beginPath();g.moveTo(0,TAB_H+NAV_H);g.lineTo(W,TAB_H+NAV_H);g.stroke();
    g.fillStyle='#8899aa';g.font='15px system-ui';
    g.fillText('\\u25C0',12,TAB_H+25);g.fillText('\\u25B6',38,TAB_H+25);g.fillText('\\u21BB',64,TAB_H+25);
    g.fillStyle='#0f1629';const ubx=90,uby=TAB_H+6,ubw=W-180,ubh=28;
    g.beginPath();g.roundRect(ubx,uby,ubw,ubh,6);g.fill();
    g.strokeStyle='#2a3a5c';g.lineWidth=1;g.beginPath();g.roundRect(ubx,uby,ubw,ubh,6);g.stroke();
    g.fillStyle='#cdd';g.font='12px monospace';
    const urlText=(urlbar.value||'').slice(0,120);
    g.fillText(urlText,ubx+pad,TAB_H+24);
    if(busyDot.classList.contains('active')){
      g.fillStyle='#f44';g.beginPath();g.arc(W-70,TAB_H+20,5,0,Math.PI*2);g.fill();
      g.fillStyle='#888';g.font='11px system-ui';g.fillText('Agent working...',W-170,TAB_H+24);}
    g.drawImage(c,0,TAB_H+NAV_H,vw,vh);
    g.fillStyle='#16213e';g.fillRect(0,TAB_H+NAV_H+vh,W,TB_H);
    g.strokeStyle='#0d1117';g.lineWidth=1;g.beginPath();g.moveTo(0,TAB_H+NAV_H+vh);g.lineTo(W,TAB_H+NAV_H+vh);g.stroke();
    g.fillStyle='#8899aa';g.font='11px system-ui';
    g.fillText('fast-browser viewer',pad,TAB_H+NAV_H+vh+22);
    const ts=new Date().toLocaleString();g.fillText(ts,W-g.measureText(ts).width-pad,TAB_H+NAV_H+vh+22);
    comp.toBlob(async blob=>{
      const r=await fetch('/screenshots/save',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:blob});
      const j=await r.json();
      if(j.ok)snapCount.textContent='Saved: '+j.name;else snapCount.textContent='Error saving';
      setTimeout(()=>{snapCount.textContent='';},2000);
    },'image/jpeg',0.92);
  }catch(e){snapCount.textContent='Snap error';setTimeout(()=>{snapCount.textContent='';},2000);}
}
async function openGallery(){
  document.getElementById('gallery').classList.add('open');
  try{const r=await fetch('/screenshots/list');const j=await r.json();
    const grid=document.getElementById('gallery-grid');grid.innerHTML='';
    if(!j.ok||!j.screenshots||!j.screenshots.length){grid.innerHTML='<p style="color:#888">No screenshots yet</p>';return;}
    j.screenshots.forEach(s=>{
      const card=document.createElement('div');card.className='snap-card';
      card.innerHTML='<img src="/screenshots/get?name='+encodeURIComponent(s.name)+'" loading="lazy"><div class="meta"><span>'+s.name+'</span><span>'+Math.round(s.size/1024)+'KB</span></div>';
      card.onclick=()=>window.open('/screenshots/get?name='+encodeURIComponent(s.name));
      grid.appendChild(card);});
  }catch{document.getElementById('gallery-grid').innerHTML='<p style="color:#f66">Failed to load</p>';}}
function closeGallery(){document.getElementById('gallery').classList.remove('open');}
</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(viewHtml) });
    return res.end(viewHtml);
  }

  // ── POST /interact ──────────────────────────────────────────────
  if (path === '/interact' && req.method === 'POST') {
    return serial(async () => {
      try {
        await ensure();
        const body = JSON.parse(await readBody(req));
        const p = P();
        switch (body.action) {
          case 'click':    await p.mouse.click(body.x, body.y); break;
          case 'dblclick': await p.mouse.dblclick(body.x, body.y); break;
          case 'type':     await p.keyboard.type(body.text, { delay: 30 }); break;
          case 'press':    await p.keyboard.press(body.key); break;
          case 'scroll':   await p.mouse.wheel(0, body.dy || 300); break;
          default: return jsonRes(res, 400, { ok: false, error: 'Unknown action: ' + body.action });
        }
        lastAction = { ...body, ts: Date.now() };
        jsonRes(res, 200, { ok: true });
      } catch (e) {
        jsonRes(res, 500, { ok: false, error: trimErr(e) });
      }
    });
  }

  // ── Screenshots ─────────────────────────────────────────────────
  const SHOTS_DIR = process.env.SCREENSHOTS_DIR || '/data/screenshots';

  if (path === '/screenshots/save' && req.method === 'POST') {
    return serial(async () => {
      try {
        await ensure();
        mkdirSync(SHOTS_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const name = `snap-${ts}.jpg`;
        const ct = (req.headers['content-type'] || '').toLowerCase();
        let buf;
        if (ct.startsWith('image/')) {
          buf = await readBodyBin(req, 20e6);
        } else {
          buf = await P().screenshot({ type: 'jpeg', quality: 85 });
        }
        writeFileSync(join(SHOTS_DIR, name), buf);
        jsonRes(res, 200, { ok: true, name, size: buf.length });
      } catch (e) { jsonRes(res, 500, { ok: false, error: trimErr(e) }); }
    });
  }

  if (path === '/screenshots/list' && req.method === 'GET') {
    try {
      mkdirSync(SHOTS_DIR, { recursive: true });
      const files = readdirSync(SHOTS_DIR)
        .filter(f => f.endsWith('.jpg'))
        .map(f => ({ name: f, size: statSync(join(SHOTS_DIR, f)).size }))
        .sort((a, b) => b.name.localeCompare(a.name));
      return jsonRes(res, 200, { ok: true, screenshots: files });
    } catch (e) { return jsonRes(res, 500, { ok: false, error: trimErr(e) }); }
  }

  if (path === '/screenshots/get' && req.method === 'GET') {
    try {
      const params = new URL(req.url, 'http://x').searchParams;
      const name = (params.get('name') || '').replace(/[^a-zA-Z0-9._-]/g, '');
      const fp = join(SHOTS_DIR, name);
      if (!name || !existsSync(fp)) return jsonRes(res, 404, { ok: false, error: 'Screenshot not found' });
      const buf = readFileSync(fp);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length,
        'Content-Disposition': `inline; filename="${name}"` });
      return res.end(buf);
    } catch (e) { return jsonRes(res, 500, { ok: false, error: trimErr(e) }); }
  }

  // ── GET /profile/info ───────────────────────────────────────────
  if (path === '/profile/info' && req.method === 'GET') {
    return serial(async () => {
      try {
        await ensure();
        const ck = await ctx.cookies();
        const domains = [...new Set(ck.map(c => c.domain.replace(/^\./, '')))];
        jsonRes(res, 200, {
          ok: true, cookies: ck.length, domains,
          profile_bytes: dirSize(PROFILE),
        });
      } catch (e) { jsonRes(res, 500, { ok: false, error: trimErr(e) }); }
    });
  }

  // ── GET /profile/snapshot ───────────────────────────────────────
  if (path === '/profile/snapshot' && req.method === 'GET') {
    return serial(async () => {
      try {
        await ensure();
        if (ctx) { try { await ctx.close(); } catch {} }
        ctx = null; pages = []; pi = 0; launching = null;

        const tmp = resolve(PROFILE, '..', 'profile-snapshot.tar.gz');
        tar('c', tmp, PROFILE);
        const buf = readFileSync(tmp);
        rmSync(tmp, { force: true });

        await ensure();

        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': 'attachment; filename="profile.tar.gz"',
          'Content-Length': buf.length,
        });
        res.end(buf);
      } catch (e) {
        try { await ensure(); } catch {}
        jsonRes(res, 500, { ok: false, error: trimErr(e) });
      }
    });
  }

  // ── POST /profile/load ─────────────────────────────────────────
  if (path === '/profile/load' && req.method === 'POST') {
    return serial(async () => {
      try {
        const buf = await readBodyBin(req);
        if (!buf.length) return jsonRes(res, 400, { ok: false, error: 'Empty body — send a tar.gz profile snapshot' });

        if (ctx) { try { await ctx.close(); } catch {} }
        ctx = null; pages = []; pi = 0; launching = null;
        await new Promise(r => setTimeout(r, 300));

        clearDir(PROFILE);

        const tmp = resolve(PROFILE, '..', 'profile-upload.tar.gz');
        writeFileSync(tmp, buf);
        tar('x', tmp, PROFILE);
        rmSync(tmp, { force: true });

        await ensure();
        const ck = await ctx.cookies();
        jsonRes(res, 200, { ok: true, message: 'Profile loaded', cookies: ck.length });
      } catch (e) {
        try { await ensure(); } catch {}
        jsonRes(res, 500, { ok: false, error: trimErr(e) });
      }
    });
  }

  // ── POST /profile/reset ────────────────────────────────────────
  if (path === '/profile/reset' && req.method === 'POST') {
    return serial(async () => {
      try {
        if (ctx) { try { await ctx.close(); } catch {} }
        ctx = null; pages = []; pi = 0; launching = null;
        await new Promise(r => setTimeout(r, 300));

        clearDir(PROFILE);
        store = {}; sandbox.store = store;

        await ensure();
        jsonRes(res, 200, { ok: true, message: 'Profile reset to clean state' });
      } catch (e) {
        try { await ensure(); } catch {}
        jsonRes(res, 500, { ok: false, error: trimErr(e) });
      }
    });
  }

  // ── 404 ─────────────────────────────────────────────────────────
  jsonRes(res, 404, {
    ok: false,
    error: 'Not found. Endpoints: POST /run, POST|GET /shot, GET /health, GET /state, GET /view, POST /interact, /screenshots/{save,list,get}, /profile/{info,snapshot,load,reset}',
  });
});

// ── Start ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
  process.stderr.write(`fast-browser :${PORT}  chrome=${CHROME}  profile=${PROFILE}\n`);

  // Seed profile from tar.gz on first startup
  const seed = process.env.PROFILE_SEED || '';
  if (seed) {
    try {
      mkdirSync(PROFILE, { recursive: true });
      if (readdirSync(PROFILE).length === 0 && existsSync(seed)) {
        tar('x', seed, PROFILE);
        process.stderr.write(`Seeded profile from ${seed}\n`);
      }
    } catch (e) {
      process.stderr.write(`Profile seed failed: ${e.message}\n`);
    }
  }

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
