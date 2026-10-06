// decider — decision-model service for fast-browser.
// Any agent POSTs a decision (choice / yes-no / score) and gets an answer from a
// SystemOne-protocol model (Jev, LiquidAI d1, Strands Decider): one forward pass, no generated tokens.
// /step wires it to fast-browser: snap() → pick the element → act on it.

import http from 'node:http';

// ── Config ──────────────────────────────────────────────────────────
const num = (v, d) => (v == null || v === '' || !Number.isFinite(+v)) ? d : +v;

const PORT        = num(process.env.PORT, 9300);
const API_KEY     = process.env.API_KEY || '';
const BROWSER_URL = (process.env.BROWSER_URL || 'http://browser:9222').replace(/\/+$/, '');
const BROWSER_KEY = process.env.BROWSER_KEY || '';
const S1_URL      = process.env.SYSTEMONE_URL || 'https://api.typesafe.ai/v1/systemone';
const S1_MODEL    = process.env.SYSTEMONE_MODEL || 'jev-latest';
const S1_KEY      = process.env.SYSTEMONE_KEY || '';
const MIN_CONF    = num(process.env.CONFIDENCE_MIN, 0.5);
const TIMEOUT_MS  = num(process.env.TIMEOUT_MS, 15000);
const T0          = Date.now();

// fast-browser helpers /step can drive, with the phrasing used in the decision question
const ACTIONS = {
  click: 'click', dblclick: 'double-click', hover: 'hover over', focus: 'focus',
  check: 'check', uncheck: 'uncheck', fill: 'fill in', type: 'type into', select: 'choose an option in',
};
const TAKES_VALUE = new Set(['fill', 'type', 'select']);

// snap() prints field values; values of fields labelled like these never leave the box
const SECRET = /pass|\bpin\b|otp|cvv|cvc|card|ssn|secret|token/i;

class HttpError extends Error {
  constructor(status, message, upstream) { super(message); this.status = status; this.upstream = upstream; }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── Upstream calls ──────────────────────────────────────────────────
async function post(url, body, key, who, ms) {
  let r, text;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    text = await r.text();
  } catch (e) {
    if (e.name === 'TimeoutError') throw new HttpError(504, `${who} timed out after ${ms}ms`);
    throw new HttpError(502, `${who} unreachable: ${e.cause?.code || e.cause?.message || e.message}`);
  }
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) {
    const d = data?.error?.message ?? data?.detail?.message ?? data?.message ?? data?.error ?? data?.detail ?? text;
    throw new HttpError(502, `${who} returned ${r.status}: ${(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300)}`, r.status);
  }
  if (!isObj(data)) throw new HttpError(502, `${who} returned a non-JSON body: ${text.slice(0, 200)}`);
  return data;
}

const decide = body =>
  post(S1_URL, { ...body, model: body.model || S1_MODEL }, S1_KEY, 'Decision model', TIMEOUT_MS);

const browser = code =>
  post(`${BROWSER_URL}/run`, { code, timeout_ms: TIMEOUT_MS, max_output: 100000 }, BROWSER_KEY, 'Browser', TIMEOUT_MS + 5000);

// ── snap() parsing ──────────────────────────────────────────────────
const redact = d => {
  const i = d.indexOf(' val="');
  return i >= 0 && SECRET.test(d.slice(0, i)) ? `${d.slice(0, i)} val="***"` : d;
};

// snap() numbers elements 1..N in order, but field values can contain newlines, so a page can
// plant fake "[n] ..." lines. Accept only the next expected ref and drop any ref that repeats.
function parseSnap(out) {
  const els = {}, dup = new Set();
  let next = 1;
  for (const line of out.split('\n')) {
    const m = /^\[(\d+)\] (.+)$/.exec(line);
    if (!m) continue;
    if (+m[1] === next) els[next++] = redact(m[2]);
    else if (+m[1] === next - 1) dup.add(next - 1);
  }
  for (const n of dup) delete els[n];
  return els;
}

// /run output ends with "[tab 1/2] Title | URL  (12ms)"
const pageOf = out => out.slice(out.lastIndexOf('\n') + 1).replace(/\s+\(\d+ms\)$/, '');

function listing(out) {
  const els = parseSnap(out);
  return { els, page: pageOf(out), lines: Object.entries(els).map(([n, e]) => `[${n}] ${e}`).join('\n') };
}

// ── /step: snap → decide → act ──────────────────────────────────────
async function step(body) {
  const { goal, action = 'click', value } = body;
  if (typeof goal !== 'string' || !goal.trim()) throw new HttpError(400, 'Missing required field: goal');
  if (!Object.hasOwn(ACTIONS, action)) throw new HttpError(400, `Unknown action "${action}". Valid: ${Object.keys(ACTIONS).join(', ')}`);
  if (TAKES_VALUE.has(action) && value == null) throw new HttpError(400, `Action "${action}" needs a "value"`);
  const minConf = num(body.min_confidence, MIN_CONF);
  const sn = `snap(${JSON.stringify(isObj(body.snap_opts) ? body.snap_opts : {})})`;

  const before = await browser(`return await ${sn}`);
  if (!before.ok) throw new HttpError(502, `Browser: ${before.error}`);
  const { els, page, lines } = listing(before.output);
  if (!lines) return { ok: false, executed: false, error: 'No interactive elements on the page', page };

  // "none" lets the model decline instead of forcing a pick, and keeps choice at >= 2 options
  const d = await decide({
    state: `Page: ${page}\n${lines}`,
    questions: {
      target: {
        type: 'choice',
        instructions: `Which element should the agent ${ACTIONS[action]} to achieve this goal: ${goal}`,
        criteria: { ...els, none: 'None of these elements fits the goal' },
      },
    },
  });
  const ans = d.answers?.target;
  const choice = String(ans?.choice ?? '');
  const confidence = ans?.confidence ?? null;
  const candidates = Object.entries(ans?.probabilities ?? {})
    .filter(([k]) => Object.hasOwn(els, k))
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, p]) => ({ ref: +k, element: els[k], p }));
  const base = { action, confidence, decision_usage: d.usage };

  if (choice === 'none') return { ok: false, executed: false, error: 'No element on the page fits the goal', ...base, candidates };
  if (!Object.hasOwn(els, choice)) throw new HttpError(502, `Decision model returned an unknown choice: ${JSON.stringify(ans ?? null).slice(0, 200)}`);
  const hit = { ref: +choice, element: els[choice], ...base };
  if (confidence !== null && confidence < minConf)
    return { ok: false, executed: false, error: `Low confidence (${confidence} < ${minConf}), not executed`, ...hit, candidates };

  const arg = TAKES_VALUE.has(action) ? `, ${JSON.stringify(value)}` : '';
  const after = await browser(
    `await ${action}(${+choice}${arg});\n` +
    `await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});\n` +
    `try { return await ${sn}; } catch (e) { return '(snap after ${action} failed: ' + e.message + ')'; }`);
  if (!after.ok) return { ok: false, executed: false, error: `Browser: ${after.error}`, ...hit };
  const now = listing(after.output);
  const snapAfter = after.output.startsWith('(snap after') ? after.output : [now.lines, now.page].filter(Boolean).join('\n');
  return { ok: true, executed: true, ...hit, snap_after: snapAfter };
}

// ── HTTP server ─────────────────────────────────────────────────────
function readBody(req, max = 10e6) {
  return new Promise((ok, no) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => { n += c.length; if (n <= max) chunks.push(c); });
    req.on('end', () => n > max ? no(new HttpError(413, 'Body too large')) : ok(Buffer.concat(chunks).toString()));
    req.on('error', no);
  });
}

function jsonRes(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const path = (req.url || '').split('?')[0];
  let status = 200, out;
  try {
    if (path === '/health' && req.method === 'GET') {
      out = {
        ok: true, model: S1_MODEL, systemone_url: S1_URL, key_set: !!S1_KEY, browser_url: BROWSER_URL,
        confidence_min: MIN_CONF, uptime_s: Math.round((Date.now() - T0) / 1000),
      };
    } else if (req.method === 'POST' && (path === '/decide' || path === '/step')) {
      if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) throw new HttpError(401, 'Unauthorized');
      // JSON-only forces a CORS preflight, which is never granted, so web pages can't drive this server
      if (!/^application\/json\b/i.test(req.headers['content-type'] || ''))
        throw new HttpError(415, 'Content-Type must be application/json');
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'Invalid JSON body'); }
      if (!isObj(body)) throw new HttpError(400, 'Body must be a JSON object');
      if (path === '/step') out = await step(body);
      else if (!isObj(body.questions) || !Object.keys(body.questions).length) throw new HttpError(400, 'Missing required field: questions');
      else out = { ok: true, ...(await decide(body)) };
    } else {
      throw new HttpError(404, 'Not found. Endpoints: GET /health, POST /decide, POST /step');
    }
  } catch (e) {
    status = e instanceof HttpError ? e.status : 500;
    out = { ok: false, error: e.message, ...(e.upstream ? { upstream_status: e.upstream } : {}) };
  }
  out.elapsed_ms = Date.now() - t0;
  jsonRes(res, status, out);
  process.stderr.write(`${req.method} ${path} ${status} ${out.elapsed_ms}ms` +
    (out.ref ? ` ref=${out.ref} conf=${out.confidence} executed=${out.executed}` : '') + '\n');
});

server.listen(PORT, () => {
  process.stderr.write(`decider :${PORT}  model=${S1_MODEL}  systemone=${S1_URL}  browser=${BROWSER_URL}\n`);
  if (!S1_KEY && S1_URL.startsWith('https:'))
    process.stderr.write('warning: SYSTEMONE_KEY is not set; hosted decision APIs will reject requests\n');
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); process.exit(0); });
