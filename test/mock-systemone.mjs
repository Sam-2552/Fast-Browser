// Scripted SystemOne stand-in for the offline tests. Zero dependencies.
// POST /script {entries} sets the answers; POST /v1/systemone pops them in order.
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = +(process.env.PORT || 8000);
const KEY = process.env.MOCK_KEY || 'test-key';
const MODEL = process.env.MOCK_MODEL || 'mock-1';
const FIXTURES = new URL('./fixtures/', import.meta.url);

let script = [];
let requests = [];
let notes = [];
let last = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function send(res, code, obj, type = 'application/json') {
  const b = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store' });
  res.end(b);
}

function readBody(req) {
  return new Promise((ok, no) => {
    let d = '';
    req.setEncoding('utf8');
    req.on('data', c => { d += c; if (d.length > 5e6) { req.destroy(); no(new Error('Body too large')); } });
    req.on('end', () => ok(d));
    req.on('error', no);
  });
}

function requestKind(q) {
  if (q?.operation) return 'main';
  if (Object.keys(q || {}).some(k => k.startsWith('value_'))) return 'value';
  if (q?.irreversible) return 'noul';
  return 'other';
}

function entryKind(e) {
  if ('status' in e || e.invalid) return 'any';
  if ('operation' in e) return 'main';
  if ('value' in e) return 'value';
  if ('noul' in e) return 'noul';
  return 'any';
}

// Follow-up entries (value/noul) the decider did not ask for are dropped when the next main
// request arrives; a follow-up request never consumes a main entry (it gets the default).
function nextEntry(kind) {
  while (script.length) {
    const k = entryKind(script[0]);
    if (k === 'any' || k === kind) return script.shift();
    if (kind === 'main') { notes.push(`skipped unused ${k} entry ${JSON.stringify(script[0])}`); script.shift(); continue; }
    notes.push(`${kind} request got the default; next entry is ${k}`);
    return null;
  }
  return null;
}

function choice(keys, chosen) {
  const n = keys.length;
  const probabilities = {};
  for (const k of keys) probabilities[k] = n === 1 ? 1 : k === chosen ? 0.9 : 0.1 / (n - 1);
  const confidence = n === 1 ? 1 : (n * probabilities[chosen] - 1) / (n - 1);
  return { choice: chosen, probabilities, confidence };
}

const invalidChoice = keys => ({ choice: keys[0], probabilities: { [keys[0]]: 0.5 }, confidence: 2 });

function findTarget(criteria, target) {
  const keys = Object.keys(criteria);
  if (target == null) return keys[0];
  const t = String(target);
  if (keys.includes(t)) return t;
  const hit = keys.find(k => {
    const v = criteria[k];
    return (typeof v === 'string' ? v : JSON.stringify(v)).includes(t);
  });
  if (!hit) notes.push(`no criteria value contains ${JSON.stringify(t)}; answered ${keys[0]}`);
  return hit ?? keys[0];
}

function answer(questions, kind, e) {
  const answers = {};
  if (kind === 'main') {
    const ops = Object.keys(questions.operation.criteria || {});
    let op = e?.operation ?? 'BLOCKED';
    if (!ops.includes(op)) {
      notes.push(`operation ${op} not offered (${ops.join(',')}); answered BLOCKED`);
      op = ops.includes('BLOCKED') ? 'BLOCKED' : ops[0];
    }
    answers.operation = e?.invalid ? invalidChoice(ops) : choice(ops, op);
    for (const [name, q] of Object.entries(questions)) {
      if (name === 'operation') continue;
      const keys = Object.keys(q.criteria || {});
      if (!keys.length) continue;
      const chosen = name === `${op.toLowerCase()}_target` ? findTarget(q.criteria, e?.target) : keys[0];
      answers[name] = choice(keys, chosen);
    }
  } else if (kind === 'value') {
    const v = e?.value ?? 'ask_agent';
    const names = [];
    for (const [qn, q] of Object.entries(questions)) {
      const name = /supplied as "([^"]+)"/.exec(q.instructions || '')?.[1];
      names.push(name);
      answers[qn] = e?.invalid ? { noul: 'yes' } : { type: 'noul', noul: name === v ? 0.9 : 0.05 };
    }
    if (v !== 'ask_agent' && !names.includes(v)) notes.push(`value ${v} not offered (${names.join(',')})`);
  } else if (kind === 'noul') {
    answers.irreversible = e?.invalid ? { noul: 'yes' } : { noul: e?.noul ?? 0.05 };
  } else {
    for (const [name, q] of Object.entries(questions || {})) {
      const keys = Object.keys(q?.criteria || {});
      answers[name] = q?.type === 'choice' && keys.length ? choice(keys, keys[0]) : { noul: 0.5 };
    }
  }
  return answers;
}

async function systemone(req, res) {
  if (req.headers.authorization !== `Bearer ${KEY}`)
    return send(res, 403, { detail: { message: 'Invalid API key' } });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { detail: { message: 'Invalid JSON' } }); }
  requests.push(body);
  const kind = requestKind(body.questions);
  const e = nextEntry(kind);
  if (e?.delay_ms) await sleep(e.delay_ms);
  if (e && 'status' in e) {
    const out = { detail: { message: `scripted HTTP ${e.status}` } };
    last = { request: body, status: e.status, response: out };
    return send(res, e.status, out);
  }
  const out = {
    model: body.model || MODEL,
    answers: answer(body.questions, kind, e),
    usage: { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 0 },
  };
  last = { request: body, status: 200, response: out };
  send(res, 200, out);
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/health') return send(res, 200, { ok: true, queued: script.length, requests: requests.length });
    if (path === '/v1/systemone' && req.method === 'POST') return await systemone(req, res);
    if (path === '/script' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(b.entries)) return send(res, 400, { ok: false, error: 'entries must be an array' });
      script = b.entries.map(x => ({ ...x }));
      requests = []; notes = []; last = null;
      return send(res, 200, { ok: true, queued: script.length });
    }
    if (path === '/requests' && req.method === 'GET') return send(res, 200, requests);
    if (path === '/notes' && req.method === 'GET') return send(res, 200, { notes, queued: script });
    if (path === '/last' && req.method === 'GET') return send(res, 200, last);
    const m = path.match(/^\/fixtures\/([\w.-]+\.html)$/);
    if (m && req.method === 'GET') {
      try { return send(res, 200, await readFile(new URL(m[1], FIXTURES), 'utf8'), 'text/html; charset=utf-8'); }
      catch { return send(res, 404, 'not found', 'text/plain'); }
    }
    send(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    send(res, 500, { ok: false, error: String(err?.message || err) });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`mock-systemone on :${PORT}`));
