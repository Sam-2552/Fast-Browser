// Offline test runner for fast-browser + decider. Zero dependencies; runs in the `tests` container.
//   node /test/run.mjs [name-substring ...]
import http from 'node:http';

const B = process.env.BROWSER_URL || 'http://browser:9222';
const D = process.env.DECIDER_URL || 'http://decider:9300';
const M = process.env.MOCK_URL || 'http://mock:8000';
const FX = process.env.FIXTURE_BASE || 'http://mock:8000/fixtures';
const CASE_MS = +(process.env.CASE_MS || 90000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(method, url, body, headers = {}, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = {};
    if (data !== null) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: h, timeout }, res => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', c => { s += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(s); } catch {}
        resolve({ status: res.statusCode, json, text: s });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${url}`)));
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

// ── assertions ───────────────────────────────────────────────────────
class Fail extends Error {}
const show = v => { try { return JSON.stringify(v)?.slice(0, 400); } catch { return String(v); } };
function ok(cond, msg) { if (!cond) throw new Fail(msg); }
function eq(a, b, msg) { if (show(a) !== show(b)) throw new Fail(`${msg}: expected ${show(b)}, got ${show(a)}`); }

// ── fast-browser helpers ─────────────────────────────────────────────
async function fb(path, body) {
  const r = await request('POST', B + path, body ?? {});
  if (!r.json) throw new Error(`${path} HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  return r;
}
async function run(code, timeout_ms = 30000) { return (await fb('/run', { code, timeout_ms })).json; }
async function runOk(code) {
  const r = await run(code);
  if (!r.ok) throw new Error(`/run failed: ${r.error}`);
  return r.output;
}
// Runs `body` as /run statements; the body returns a JSON-able value through `out(...)`.
async function runVal(body) {
  const out = await runOk(`const out = v => '<<' + JSON.stringify(v ?? null) + '>>';\n${body}`);
  const m = out.match(/<<([\s\S]*)>>/);
  if (!m) throw new Error(`no value in /run output: ${out.slice(0, 300)}`);
  return JSON.parse(m[1]);
}
// Evaluates a JS expression in the page and returns its JSON value.
async function ev(expr) {
  const inner = `JSON.stringify((${expr}) ?? null)`;
  return runVal(`return out(JSON.parse(await page.evaluate(${JSON.stringify(inner)})));`);
}
const js = body => ev(`(() => { ${body} })()`);

async function load(name) {
  await runOk(`await goto('about:blank'); return await goto(${JSON.stringify(`${FX}/${name}`)})`);
}
async function observe() {
  const r = await fb('/observe', {});
  ok(r.status === 200 && r.json.ok, `/observe failed: ${show(r.json)}`);
  return r.json;
}
async function act(obs, action, text) {
  const body = { obs: obs.obs ?? obs, action: action.id ?? action };
  if (text !== undefined) body.text = text;
  return (await fb('/act', body)).json;
}
function pick(o, pred, desc) {
  const a = o.actions.find(pred);
  if (!a) throw new Fail(`no action ${desc}; have: ${o.actions.map(x => `${x.kind}:${x.label}`).join(' | ').slice(0, 800)}`);
  return a;
}
const clickOf = (o, label) => pick(o, a => a.kind === 'click' && a.label === label, `click "${label}"`);
const fillOf = (o, label) => pick(o, a => a.kind === 'fill' && a.label === label, `fill "${label}"`);
const selectOf = (o, value) => pick(o, a => a.kind === 'select' && a.value === value, `select value "${value}"`);
const control = (o, id) => pick(o, a => a.id === id, `control ${id}`);
const clicks = () => ev('window.clicks || 0');
function expectStale(r, what) {
  ok(r && r.ok === false && r.stale === true, `${what}: expected {ok:false, stale:true}, got ${show(r)}`);
}

// ── decider + mock helpers ───────────────────────────────────────────
const DH = { host: 'decider:9300' };
async function dec(method, path, body, headers = {}) { return request(method, D + path, body, { ...DH, ...headers }); }
let lastTask = 0;
async function task(body) {
  const r = await dec('POST', '/task', body);
  ok(r.status === 200 && r.json, `/task HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  lastTask = Math.max(lastTask, +String(r.json.task).slice(1) || 0);
  return r.json;
}
// The id of the task whose call is in flight (ids are sequential; this runner is the only client)
async function runningTask() {
  for (let n = lastTask + 1; n <= lastTask + 20; n++) {
    const r = await dec('GET', `/task?id=t${n}`);
    if (r.status === 200 && r.json.status === 'running') return `t${n}`;
  }
  throw new Fail('no running task found');
}
async function cont(body) {
  const r = await dec('POST', '/task/continue', body);
  ok(r.status === 200 && r.json, `/task/continue HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  return r.json;
}
async function scriptSet(entries) {
  const r = await request('POST', `${M}/script`, { entries });
  ok(r.status === 200, `mock /script HTTP ${r.status}`);
}
async function reqs() { return (await request('GET', `${M}/requests`)).json || []; }
async function notes() { return (await request('GET', `${M}/notes`)).json; }
const mainReqs = rs => rs.filter(r => r.questions?.operation);
const asks = (rs, name) => rs.filter(r => r.questions?.[name]);
async function until(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const url = name => `${FX}/${name}`;
const status = (r, s, msg) => ok(r.status === s, `${msg}: expected status ${s}, got ${r.status} (reason ${show(r.reason)}, pending ${show(r.pending)})`);

// ── cases ────────────────────────────────────────────────────────────
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// fast-browser: /observe and /act
test('fb: observe shape, controls and ids', async () => {
  await load('guards.html');
  const o = await observe();
  ok(/^o\d+$/.test(o.obs), `obs id ${o.obs}`);
  ok(/^[0-9a-f]{64}$/.test(o.fingerprint) && /^[0-9a-f]{64}$/.test(o.marker), 'fingerprint/marker are sha256 hex');
  ok(o.title === 'Guard checks' && o.url.includes('guards.html'), 'url/title');
  ok(typeof o.text === 'string' && o.text.includes('Cart total: $10') && o.text.length <= 6000, 'visible text');
  ok(!o.text.includes('Unrelated offscreen text'), 'offscreen text not in viewport text');
  ok(o.scroll && typeof o.scroll.y === 'number' && o.scroll.height > 3000, 'scroll info');
  ok(Number.isInteger(o.omitted), 'omitted is int');
  eq(control(o, 'scroll_down').delta, 560, 'scroll_down delta');
  eq(control(o, 'wait').kind, 'wait', 'wait control');
  ok(!o.actions.some(a => a.id === 'scroll_up'), 'scroll_up only offered when scrolled');
  const sr = await act(o, 'scroll_down');
  ok(sr?.ok, `scroll_down act: ${show(sr)}`);
  const o2 = await observe();
  ok(o2.scroll.y > 0, `scrolled y ${o2.scroll.y}`);
  eq(control(o2, 'scroll_up').delta, -560, 'scroll_up delta');
  const city = fillOf(o, 'City');
  eq(clickOf(o, 'Open City').node, city.node, '"Open City" click shares the fill node');
  eq(city.value, 'Zurich', 'field value');
  const firstSelect = o.actions.findIndex(a => a.kind === 'select');
  ok(firstSelect > 0 && o.actions.slice(firstSelect).every(a => a.kind === 'select' || ['scroll', 'wait'].includes(a.kind)), 'select options listed after other element actions');
  const sel = selectOf(o, 'Design');
  ok(sel.label === 'Category → Design' && sel.current_value === 'All', `select label/current_value ${show(sel)}`);
  ok(!o.actions.some(a => a.kind === 'select' && a.value === 'All'), 'selected option not offered');
  ok(o.actions.every(a => (a.label || '').length <= 100), 'labels capped at 100');
});

test('fb: password values never exposed', async () => {
  await load('guards.html');
  const o = await observe();
  ok(!o.actions.some(a => /password/i.test(a.label || '')), 'no password action');
  ok(!JSON.stringify(o).includes('hunter2'), 'password value never read');
});

test('fb: shadow-root button observed and clicked', async () => {
  await load('guards.html');
  const o = await observe();
  const r = await act(o, clickOf(o, 'Shadow action'));
  ok(r.ok, `act ${show(r)}`);
  eq(await ev('window.shadowClicks || 0'), 1, 'shadow clicks');
});

test('fb: moved target is clicked at its current location', async () => {
  await load('guards.html');
  const o = await observe();
  await js(`document.querySelector('#target').style.transform = 'translateX(200px)'`);
  const r = await act(o, clickOf(o, 'Continue'));
  ok(r.ok && r.executed, `act ${show(r)}`);
  eq(await clicks(), 1, 'clicks');
});

test('fb: offscreen text change does not invalidate', async () => {
  await load('guards.html');
  const o = await observe();
  await js(`document.querySelector('#outside').textContent = 'Updated outside the viewport'`);
  const r = await act(o, clickOf(o, 'Continue'));
  ok(r.ok, `click after offscreen change: ${show(r)}`);
  eq(await clicks(), 1, 'clicks');
  const o2 = await observe();
  await js(`document.querySelector('#outside').textContent = 'Changed again'`);
  const w = await act(o2, control(o2, 'wait'));
  ok(w.ok, `wait after offscreen change: ${show(w)}`);
});

const MUTATIONS = [
  ['visible context (wait/marker)', `document.querySelector('#context').textContent = 'Cart total: $100'`, o => control(o, 'wait')],
  ['accessible label', `document.querySelector('#target').setAttribute('aria-label', 'Delete account')`, o => clickOf(o, 'Continue')],
  ['field value', `document.querySelector('#field').value = 'London'`, o => fillOf(o, 'City'), 'Bern'],
  ['checkbox state', `document.querySelector('#toggle').checked = true`, o => clickOf(o, 'Refundable')],
  ['disabled target', `document.querySelector('#target').disabled = true`, o => clickOf(o, 'Continue')],
  ['read-only field', `document.querySelector('#field').readOnly = true`, o => fillOf(o, 'City'), 'Bern'],
  ['hidden target', `document.querySelector('#target').style.display = 'none'`, o => clickOf(o, 'Continue')],
  ['replaced node', `const t = document.querySelector('#target'); t.outerHTML = t.outerHTML`, o => clickOf(o, 'Continue')],
  ['option text', `document.querySelector('#category').options[1].text = 'Coastal'`, o => selectOf(o, 'Design')],
];
for (const [what, mutation, target, text] of MUTATIONS) {
  test(`fb: ${what} makes the action stale`, async () => {
    await load('guards.html');
    const o = await observe();
    const a = target(o);
    await js(mutation);
    expectStale(await act(o, a, text), what);
    eq(await clicks(), 0, 'no click happened');
    const state = await ev(`({ city: document.querySelector('#field').value, cat: document.querySelector('#category').value })`);
    ok(state.city !== 'Bern' && state.cat !== 'Design', `no mutation executed: ${show(state)}`);
  });
}

test('fb: overlay blocks the click', async () => {
  await load('guards.html');
  const o = await observe();
  await js(`const c = document.createElement('div'); c.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white'; document.body.append(c)`);
  const r = await act(o, clickOf(o, 'Continue'));
  ok(r.ok === false, `covered click must fail: ${show(r)}`);
  eq(await clicks(), 0, 'no click');
});

test('fb: navigation and unknown obs are stale; malformed body is 400', async () => {
  await load('guards.html');
  const o = await observe();
  const a = clickOf(o, 'Continue');
  await load('combobox.html');
  expectStale(await act(o, a), 'old document');
  expectStale(await act('o999999', 'e1'), 'unknown obs');
  const bad = await fb('/act', { obs: o.obs });
  eq(bad.status, 400, 'missing action');
  const o2 = await observe();
  const fill = pick(o2, x => x.kind === 'fill', 'fill');
  const noText = await fb('/act', { obs: o2.obs, action: fill.id });
  eq(noText.status, 400, 'fill without text');
});

test('fb: select executes', async () => {
  await load('guards.html');
  const o = await observe();
  const r = await act(o, selectOf(o, 'Design'));
  ok(r.ok, `act ${show(r)}`);
  eq(await ev(`document.querySelector('#category').value`), 'Design', 'select value');
});

test('fb: fill replaces existing content', async () => {
  await load('guards.html');
  const o = await observe();
  const r = await act(o, fillOf(o, 'City'), 'Bern');
  ok(r.ok, `act ${show(r)}`);
  eq(await ev(`document.querySelector('#field').value`), 'Bern', 'field value');
  const o2 = await observe();
  eq(fillOf(o2, 'City').value, 'Bern', 'observed value');
});

test('fb: combobox wait sees late suggestions', async () => {
  await load('combobox.html');
  const o = await observe();
  const field = pick(o, a => a.kind === 'fill' && a.role === 'combobox', 'combobox fill');
  const r = await act(o, field, 'Lis');
  ok(r.ok, `fill ${show(r)}`);
  const o2 = await observe();
  const opt = pick(o2, a => a.kind === 'click' && a.role === 'option' && a.label.includes('Lisbon'), 'Lisbon option');
  const r2 = await act(o2, opt);
  ok(r2.ok, `click option ${show(r2)}`);
  eq(await ev('window.picked || null'), 'Lisbon, Portugal', 'picked');
});

// fast-browser: form-scoped guards and native controls (jev check_guards.py, second fixture)
const buys = () => ev('window.buys || 0');
test('fb: unrelated change keeps the form action fresh but makes wait stale', async () => {
  await load('guards-form.html');
  const o = await observe();
  await js(`document.querySelector('#aside').textContent = 'Different unrelated news'`);
  const r = await act(o, clickOf(o, 'Buy'));
  ok(r.ok, `Buy after unrelated change: ${show(r)}`);
  eq(await buys(), 1, 'bought');
  const o2 = await observe();
  await js(`document.querySelector('#aside').textContent = 'Changed again'`);
  expectStale(await act(o2, control(o2, 'wait')), 'wait after visible change');
});

const FORM_MUTATIONS = [
  ['nearby price', `document.querySelector('#price').textContent = 'Total $99'`],
  ['form value', `document.querySelector('#query').value = 'changed'`],
  ['form toggle', `document.querySelector('#check').checked = true`],
  ['target replacement', `const b = document.querySelector('#buy'); b.outerHTML = b.outerHTML`],
];
for (const [what, mutation] of FORM_MUTATIONS) {
  test(`fb: ${what} makes the form action stale`, async () => {
    await load('guards-form.html');
    const o = await observe();
    const buy = clickOf(o, 'Buy');
    await js(mutation);
    expectStale(await act(o, buy), what);
    eq(await buys(), 0, 'not bought');
  });
}

test('fb: native controls are exposed with the right operations', async () => {
  await load('guards-form.html');
  const o = await observe();
  for (const l of ['Gift wrap', 'Express', 'Order id']) {
    const kinds = o.actions.filter(a => a.label === l).map(a => a.kind);
    eq(kinds, ['click'], `${l} is click-only`);
  }
  ok(!o.actions.some(a => a.label === 'Unavailable'), 'disabled button absent');
  ok(!JSON.stringify(o).includes('never expose this') && !o.actions.some(a => /Password/.test(a.label)), 'password never exposed');
  eq(o.actions.filter(a => a.kind === 'select').map(a => a.value), ['Design'], 'only the enabled, unselected option');
  ok((await act(o, selectOf(o, 'Design'))).ok, 'select ok');
  eq(await ev(`document.querySelector('#cat').value`), 'Design', 'select value');
});

// fast-browser: web components and editors
test('fb: slotted shadow button is named and clickable', async () => {
  await load('components.html');
  const o = await observe();
  const a = clickOf(o, 'Sign in'), b = clickOf(o, 'Create account');
  eq(a.role, 'button', 'role');
  ok((await act(o, a)).ok, 'bare-text slot click');
  const o2 = await observe();
  const r = await act(o2, clickOf(o2, 'Create account'));
  ok(r.ok, `element slot click: ${show(r)} (node ${b.node})`);
  eq(await ev('window.slotClicks || []'), ['b1', 'b2'], 'both clicked');
  const s = await runVal('return out(await snap());');
  ok(/\[\d+\] button "Sign in"/.test(s), `snap names slotted text: ${s}`);
});

test('fb: snap() ref on a contenteditable survives its own text changing', async () => {
  await load('components.html');
  const v = await runVal(`
    const s = await snap();
    const n = +s.match(/\\[(\\d+)\\] div/)[1];
    await fill(n, 'abc');
    await fill(n, 'def');
    return out(await page.evaluate(() => document.querySelector('#ce').textContent));
  `);
  eq(v, 'def', 'editor text');
});

test('fb: select option labels are capped at 100 chars', async () => {
  await load('components.html');
  const o = await observe();
  const sel = pick(o, a => a.kind === 'select', 'select');
  ok(sel.label.length === 100 && sel.label.startsWith('A very long dropdown'), `label ${sel.label.length}: ${sel.label}`);
});

test('fb: foreign Host or Origin rejected; same-origin and service names allowed', async () => {
  const get = headers => request('GET', `${B}/health`, undefined, headers);
  eq((await get({ host: 'evil.example:9222' })).status, 403, 'Host evil.example');
  eq((await get({ origin: 'http://evil.example' })).status, 403, 'Origin evil.example');
  eq((await get({ origin: 'http://1.2.3.4' })).status, 403, 'Origin foreign IP');
  eq((await request('POST', `${B}/run`, '{"code":"return 1"}', { 'content-type': 'text/plain', origin: 'https://evil.example' })).status, 403, 'simple POST from a page');
  eq((await get({})).status, 200, 'Host browser (service name)');
  eq((await get({ host: 'localhost:9222', origin: 'http://localhost:9222' })).status, 200, 'same origin');
  eq((await get({ host: '127.0.0.1:19222', origin: 'http://localhost:19222' })).status, 200, 'loopback origin');
  const pre = await request('OPTIONS', `${B}/run`, undefined, { origin: 'http://evil.example' });
  ok(pre.status === 403, `preflight from a foreign origin refused (${pre.status})`);
});

// Freezes the renderer for ~9 s; STEP_TIMEOUT_MS is 4 s in the test stack
test('fb: a hung page times out /observe and releases the lock', async () => {
  await load('components.html');
  const o = await observe();
  ok((await act(o, clickOf(o, 'Freeze'))).ok, 'click');
  const t0 = Date.now();
  const r = (await fb('/observe', {})).json;
  const ms = Date.now() - t0;
  ok(r.ok === false && /timed out/.test(r.error || ''), `observe on a hung page: ${show(r)}`);
  ok(ms < 8000, `observe returned in ${ms}ms`);
  const run1 = await run('return 1', 30000);
  ok(run1.ok, `run after the timeout: ${show(run1)}`);
  await until(async () => (await fb('/observe', {})).json.ok, 20000, 'page responsive again');
});

// fast-browser: snap() refs
test('fb: snap() keeps its format', async () => {
  await load('guards.html');
  const s = await runVal('return out(await snap());');
  const lines = s.split('\n').filter(Boolean);
  lines.forEach((l, i) => ok(l.startsWith(`[${i + 1}] `), `positional numbering at line ${i + 1}: ${l}`));
  ok(lines.some(l => /^\[\d+\] button "Continue"$/.test(l)), 'button line');
  ok(lines.some(l => /^\[\d+\] input.*"City".* val="Zurich"/.test(l)), 'input line with val');
  ok(lines.some(l => /^\[\d+\] input\[checkbox\].*"Refundable".* ○/.test(l)), 'checkbox line with ○');
  ok(lines.some(l => /^\[\d+\] select/.test(l)), 'select line');
  ok(lines.some(l => /^\[\d+\] input\[password\]/.test(l) && !/val=/.test(l)), 'password listed without val');
  ok(!s.includes('hunter2'), 'password value absent');
  ok(lines.some(l => l.includes('Shadow action')), 'shadow root included');
  eq(await ev(`document.querySelectorAll('[data-fb]').length`), 0, 'no data-fb attributes');
});

test('fb: snap() refs are not ambiguous after elements hide', async () => {
  await load('guards.html');
  const r = await runVal(`
    const s1 = await snap();
    const n = +s1.match(/\\[(\\d+)\\] button "Continue"/)[1];
    await page.evaluate(() => { document.querySelector('#target').style.display = 'none'; });
    const s2 = await snap();
    const line = s2.split('\\n').find(l => l.startsWith('[' + n + '] ')) || null;
    await click(n);
    return out({ line, active: await page.evaluate(() => document.activeElement && document.activeElement.id), clicks: await page.evaluate(() => window.clicks || 0) });
  `);
  ok(r.line && !r.line.includes('Continue'), `ref now names another element: ${show(r)}`);
  eq(r.clicks, 0, 'hidden Continue not clicked');
  if (r.line.includes('City')) eq(r.active, 'field', 'the re-numbered element was clicked');
});

test('fb: relabelled snap() ref is refused', async () => {
  await load('guards.html');
  const r = await run(`
    const s = await snap();
    const n = +s.match(/\\[(\\d+)\\] button "Continue"/)[1];
    await page.evaluate(() => document.querySelector('#target').setAttribute('aria-label', 'Delete account'));
    await click(n);
  `);
  ok(r.ok === false && /changed since snap\(\)/.test(r.error || ''), `expected ref refusal, got ${show(r)}`);
  eq(await clicks(), 0, 'no click');
});

test('fb: snap() ref survives a value change', async () => {
  await load('guards.html');
  const v = await runVal(`
    const s = await snap();
    const n = +s.match(/\\[(\\d+)\\] input[^\\n]*"City"/)[1];
    await fill(n, 'Bern');
    await click(n);
    return out(await page.evaluate(() => document.querySelector('#field').value));
  `);
  eq(v, 'Bern', 'field value');
});

// decider
test('decider: health', async () => {
  const r = await dec('GET', '/health');
  ok(r.status === 200 && r.json.ok, `health ${r.status} ${r.text.slice(0, 200)}`);
  eq(r.json.model, 'mock-1', 'model');
  ok(r.json.key_set === true && r.json.systemone_url.includes('mock'), 'key/url');
});

test('decider: foreign Host or Origin rejected', async () => {
  eq((await dec('GET', '/health', undefined, { host: 'evil.example' })).status, 403, 'Host evil.example');
  eq((await dec('GET', '/health', undefined, { host: 'evil.example:9300' })).status, 403, 'Host evil.example:9300');
  await scriptSet([]);
  const r = await dec('POST', '/task', { goal: 'x', url: url('guards.html') }, { origin: 'http://evil.example' });
  eq(r.status, 403, 'Origin evil.example');
  eq((await reqs()).length, 0, 'no model call for rejected request');
  eq((await dec('GET', '/health', undefined, { host: 'localhost:9300' })).status, 200, 'Host localhost');
  eq((await dec('GET', '/health', undefined, { host: '127.0.0.1' })).status, 200, 'Host 127.0.0.1');
  eq((await dec('GET', '/health', undefined, { origin: 'http://decider:19300' })).status, 200, 'Origin decider');
  eq((await dec('GET', '/health', undefined, { origin: 'http://localhost:9300' })).status, 200, 'Origin localhost');
});

test('decider: request errors (415, 400, 404)', async () => {
  eq((await dec('POST', '/task', '{"goal":"x"}', { 'content-type': 'text/plain' })).status, 415, 'non-JSON');
  eq((await dec('POST', '/task', {})).status, 400, 'missing goal');
  eq((await dec('GET', '/task?id=nope')).status, 404, 'unknown trace');
  eq((await dec('POST', '/task/continue', { task: 'nope' })).status, 404, 'unknown continue');
});

test('decider: one request carries operation and all heads; only chosen head executes', async () => {
  await scriptSet([{ operation: 'CLICK', target: 'Continue' }, { operation: 'DONE' }]);
  const r = await task({ goal: 'Press Continue', url: url('guards.html'), confirm: false });
  status(r, 'done', 'task');
  const rs = await reqs();
  const m = mainReqs(rs);
  eq(m.length, 2, 'main requests');
  const q = m[0].questions;
  for (const h of ['operation', 'click_target', 'type_text_target', 'select_target']) ok(q[h]?.type === 'choice', `head ${h} present`);
  for (const op of ['CLICK', 'TYPE_TEXT', 'SELECT', 'WAIT', 'DONE', 'BLOCKED']) ok(op in q.operation.criteria, `operation ${op} offered`);
  for (const h of ['click_target', 'type_text_target', 'select_target'])
    ok(Object.values(q[h].criteria).every(v => typeof v === 'string' && /^\[\d+(:\d+)?\] /.test(v)), `${h} criteria are "[i] ..." strings`);
  ok(Object.keys(q.select_target.criteria).every(k => /^\d+:\d+$/.test(k)), 'select keys i:k');
  const st = m[0].state;
  ok(st.page.url.includes('guards.html') && Array.isArray(st.elements) && Array.isArray(st.recent_actions), 'state shape');
  eq(mainReqs(rs)[1].state.recent_actions.length, 1, 'recent_actions after one step');
  eq(await clicks(), 1, 'clicked once');
  eq(await ev(`document.querySelector('#field').value`), 'Zurich', 'type_text head not executed');
  eq(await ev(`document.querySelector('#category').value`), 'All', 'select head not executed');
  eq(r.steps.length, 1, 'one step');
  ok(r.final && r.final.title === 'Guard checks', 'final page');
  ok(r.stats && r.stats.decisions >= 2 && r.stats.input_tokens > 0, `stats ${show(r.stats)}`);
  const body = JSON.stringify(rs);
  ok(!body.includes('hunter2') && !body.includes('4242424242424242'), 'secrets never sent');
  const tr = await dec('GET', `/task?id=${encodeURIComponent(r.task)}`);
  ok(tr.status === 200 && Array.isArray(tr.json.decisions) && tr.json.decisions.length >= 2, `trace ${tr.text.slice(0, 200)}`);
  const d0 = tr.json.decisions[0];
  ok(d0.operation === 'CLICK' && Array.isArray(d0.top) && typeof d0.latency_ms === 'number', `trace decision ${show(d0)}`);
});

test('decider: invalid answer means no action', async () => {
  await scriptSet([{ invalid: true }]);
  const r = await task({ goal: 'Press Continue', url: url('guards.html'), confirm: false });
  status(r, 'error', 'task');
  eq(r.steps.length, 0, 'no steps');
  eq(await clicks(), 0, 'no click');
});

test('decider: 429 is retried', async () => {
  await scriptSet([{ status: 429 }, { operation: 'CLICK', target: 'Continue' }, { operation: 'DONE' }]);
  const r = await task({ goal: 'Press Continue', url: url('guards.html'), confirm: false });
  status(r, 'done', 'task');
  eq(mainReqs(await reqs()).length, 3, 'requests incl. the 429');
  eq(await clicks(), 1, 'clicked once');
});

test('decider: stale decision is re-decided without acting', async () => {
  await scriptSet([{ operation: 'CLICK', target: 'Continue', delay_ms: 1000 }, { operation: 'DONE' }]);
  const p = task({ goal: 'Press Continue', url: url('guards.html'), confirm: false });
  await until(async () => (await reqs()).length >= 1, 15000, 'first model request');
  await js(`document.querySelector('#target').setAttribute('aria-label', 'Delete account')`);
  const r = await p;
  status(r, 'done', 'task');
  eq(await clicks(), 0, 'stale click not executed');
  const m = mainReqs(await reqs());
  eq(m.length, 2, 're-decided once');
  ok(JSON.stringify(m[1].state.elements).includes('Delete account'), 'second decision saw the new label');
});

test('decider: matching value fills without pausing', async () => {
  await scriptSet([{ operation: 'TYPE_TEXT', target: 'City' }, { value: 'city' }, { operation: 'DONE' }]);
  const r = await task({ goal: 'Set the city to Bern', url: url('guards.html'), values: { city: 'Bern', country: 'CH' }, confirm: false });
  status(r, 'done', 'task');
  eq(await ev(`document.querySelector('#field').value`), 'Bern', 'field value');
  const v = asks(await reqs(), 'value');
  eq(v.length, 1, 'one value question');
  eq(Object.keys(v[0].questions.value.criteria).sort(), ['ask_agent', 'city', 'country'], 'value criteria');
});

test('decider: no matching value pauses needs_text; continue types it', async () => {
  await scriptSet([{ operation: 'TYPE_TEXT', target: 'City' }, { value: 'ask_agent' }]);
  const r = await task({ goal: 'Set the city to Geneva', url: url('guards.html'), values: { country: 'CH' }, confirm: false });
  status(r, 'needs_text', 'task');
  ok(r.pending?.kind === 'text' && /City/.test(r.pending.field?.label || ''), `pending ${show(r.pending)}`);
  ok(r.pending.context?.goal === 'Set the city to Geneva' && typeof r.pending.instructions === 'string', 'pending context');
  eq(await ev(`document.querySelector('#field').value`), 'Zurich', 'nothing typed yet');
  await scriptSet([{ operation: 'DONE' }]);
  const c = await cont({ task: r.task, text: 'Geneva' });
  status(c, 'done', 'continue');
  eq(await ev(`document.querySelector('#field').value`), 'Geneva', 'field value');
  ok(c.steps.some(s => s.text === 'Geneva'), `step records text ${show(c.steps)}`);
});

test('decider: text null blocks', async () => {
  await scriptSet([{ operation: 'TYPE_TEXT', target: 'City' }]);
  const r = await task({ goal: 'Set the city', url: url('guards.html'), confirm: false });
  status(r, 'needs_text', 'task');
  eq(asks(await reqs(), 'value').length, 0, 'no value question without values');
  const c = await cont({ task: r.task, text: null });
  status(c, 'blocked', 'continue');
  eq(await ev(`document.querySelector('#field').value`), 'Zurich', 'nothing typed');
});

test('decider: text is reused for the same field after a stale retry', async () => {
  await scriptSet([{ operation: 'TYPE_TEXT', target: 'City' }]);
  const r = await task({ goal: 'Set the city to Geneva', url: url('guards.html'), confirm: false });
  status(r, 'needs_text', 'task');
  await js(`document.querySelector('#field').value = 'London'`);
  await scriptSet([{ operation: 'TYPE_TEXT', target: 'City' }, { operation: 'DONE' }]);
  const c = await cont({ task: r.task, text: 'Geneva' });
  status(c, 'done', 'continue');
  eq(await ev(`document.querySelector('#field').value`), 'Geneva', 'field value');
  const rs = await reqs();
  eq(mainReqs(rs).length, 2, 're-decided then DONE');
  eq(asks(rs, 'value').length, 0, 'cached text used, no value question');
});

test('decider: risky click pauses; confirm executes', async () => {
  await scriptSet([{ operation: 'CLICK', target: 'Continue' }, { noul: 0.9 }]);
  const r = await task({ goal: 'Press Continue', url: url('guards.html') });
  status(r, 'needs_confirmation', 'task');
  ok(r.pending?.kind === 'confirm' && /Continue/.test(r.pending.element || ''), `pending ${show(r.pending)}`);
  ok(Math.abs((r.pending.p_irreversible ?? 0) - 0.9) < 1e-9, 'p_irreversible');
  eq(await clicks(), 0, 'not clicked yet');
  await scriptSet([{ operation: 'DONE' }]);
  const c = await cont({ task: r.task, confirm: true });
  status(c, 'done', 'continue');
  eq(await clicks(), 1, 'clicked after confirm');
  eq(asks(await reqs(), 'irreversible').length, 0, 'confirmation not asked again');
});

test('decider: declined confirmation blocks', async () => {
  await scriptSet([{ operation: 'CLICK', target: 'Continue' }, { noul: 0.9 }]);
  const r = await task({ goal: 'Press Continue', url: url('guards.html') });
  status(r, 'needs_confirmation', 'task');
  const c = await cont({ task: r.task, confirm: false });
  status(c, 'blocked', 'continue');
  eq(await clicks(), 0, 'not clicked');
});

test('decider: low irreversible probability clicks without pausing', async () => {
  await scriptSet([{ operation: 'CLICK', target: 'Continue' }, { noul: 0.1 }, { operation: 'DONE' }]);
  const r = await task({ goal: 'Press Continue', url: url('guards.html') });
  status(r, 'done', 'task');
  eq(asks(await reqs(), 'irreversible').length, 1, 'one irreversible check');
  eq(await clicks(), 1, 'clicked');
});

test('decider: confirm:false and checkbox clicks skip the irreversible check', async () => {
  await scriptSet([{ operation: 'CLICK', target: 'Continue' }, { operation: 'DONE' }]);
  const r = await task({ goal: 'Press Continue', url: url('guards.html'), confirm: false });
  status(r, 'done', 'task');
  eq(asks(await reqs(), 'irreversible').length, 0, 'confirm:false asks nothing');
  eq(await clicks(), 1, 'clicked');
  await scriptSet([{ operation: 'CLICK', target: 'Refundable' }, { operation: 'DONE' }]);
  const r2 = await task({ goal: 'Tick Refundable', url: url('guards.html') });
  status(r2, 'done', 'checkbox task');
  eq(asks(await reqs(), 'irreversible').length, 0, 'checkbox asks nothing');
  eq(await ev(`document.querySelector('#toggle').checked`), true, 'checked');
});

test('decider: DONE is re-checked against a changed page', async () => {
  await scriptSet([{ operation: 'DONE', delay_ms: 1000 }, { operation: 'DONE' }]);
  const p = task({ goal: 'Read the cart', url: url('guards.html'), confirm: false });
  await until(async () => (await reqs()).length >= 1, 15000, 'first model request');
  await js(`document.querySelector('#context').textContent = 'Cart total: $100'`);
  const r = await p;
  status(r, 'done', 'task');
  const m = mainReqs(await reqs());
  eq(m.length, 2, 'DONE decided again after the change');
  ok(m[1].state.page.text.includes('$100'), 'second decision saw the new text');
  ok(r.final?.text?.includes('$100'), 'final reflects the page');
});

test('decider: max_actions budget', async () => {
  await scriptSet([{ operation: 'CLICK', target: 'Continue' }, { operation: 'CLICK', target: 'Continue' }, { operation: 'CLICK', target: 'Continue' }]);
  const r = await task({ goal: 'Press Continue', url: url('guards.html'), confirm: false, max_actions: 1 });
  ok(r.status !== 'done' && r.status !== 'error', `status ${r.status}`);
  eq(r.steps.length, 1, 'one step');
  eq(await clicks(), 1, 'one click');
  // Budgets are per call: continue takes exactly one more step
  await scriptSet([{ operation: 'CLICK', target: 'Continue' }, { operation: 'CLICK', target: 'Continue' }]);
  const c = await cont({ task: r.task });
  status(c, 'blocked', 'continue');
  eq(c.steps.length, 1, 'one more step');
  eq(await clicks(), 2, 'second click');
});

test('decider: max_decisions budget', async () => {
  await scriptSet(Array.from({ length: 6 }, () => ({ operation: 'WAIT' })));
  const r = await task({ goal: 'Wait', url: url('guards.html'), confirm: false, max_decisions: 2 });
  ok(r.status !== 'done' && r.status !== 'error', `status ${r.status}`);
  ok(mainReqs(await reqs()).length <= 2, 'at most two decisions');
});

test('decider: max_ms returns running and can continue', async () => {
  await scriptSet(Array.from({ length: 5 }, () => ({ operation: 'WAIT', delay_ms: 50 })));
  const r = await task({ goal: 'Wait', url: url('guards.html'), confirm: false, max_ms: 1 });
  status(r, 'running', 'task');
  await scriptSet([{ operation: 'DONE' }]);
  const c = await cont({ task: r.task });
  status(c, 'done', 'continue');
});

test('decider: no-progress stop after 3 unchanged actions', async () => {
  await scriptSet(Array.from({ length: 5 }, () => ({ operation: 'CLICK', target: 'Continue' })));
  const r = await task({ goal: 'Press Continue', url: url('guards.html'), confirm: false });
  status(r, 'blocked', 'task');
  eq(await clicks(), 3, 'three clicks');
  eq(r.steps.length, 3, 'three steps');
  ok(r.steps.every(s => s.changed === false), 'no step changed the page');
});

test('decider: call in flight returns 409', async () => {
  await scriptSet([{ operation: 'WAIT', delay_ms: 1500 }, { operation: 'DONE' }]);
  const p = task({ goal: 'Wait', url: url('guards.html'), confirm: false });
  await until(async () => (await reqs()).length >= 1, 15000, 'first model request');
  const r = await dec('POST', '/task', { goal: 'Another', confirm: false });
  eq(r.status, 409, 'second task while in flight');
  status(await p, 'done', 'first task');
});

test('decider: a replaced task cannot run alongside or after the current one', async () => {
  await scriptSet([{ operation: 'TYPE_TEXT', target: 'City' }]);
  const t1 = await task({ goal: 'Set the city', url: url('guards.html'), confirm: false });
  status(t1, 'needs_text', 't1');
  await scriptSet([{ operation: 'WAIT', delay_ms: 1500 }, { operation: 'DONE' }]);
  const p = task({ goal: 'Wait', confirm: false });
  await until(async () => (await reqs()).length >= 1, 15000, 't2 model request');
  eq((await dec('POST', '/task/continue', { task: t1.task, text: 'Geneva' })).status, 409, 'continue t1 while t2 in flight');
  status(await p, 'done', 't2');
  eq((await dec('POST', '/task/continue', { task: t1.task, text: 'Geneva' })).status, 409, 'continue replaced t1 while t2 idle');
  eq(await ev(`document.querySelector('#field').value`), 'Zurich', 't1 never typed');
});

test('decider: a stop that lands during a pause does not swallow the next continue', async () => {
  await scriptSet([{ operation: 'TYPE_TEXT', target: 'City' }, { value: 'ask_agent', delay_ms: 1500 }]);
  const p = task({ goal: 'Set the city to Geneva', url: url('guards.html'), values: { country: 'CH' }, confirm: false });
  await until(async () => asks(await reqs(), 'value').length >= 1, 15000, 'value request');
  const id = await runningTask();
  const s = await dec('POST', '/task/stop', { task: id });
  ok(s.status === 200 && s.json.stopping === true, `stop while in flight: ${s.text.slice(0, 200)}`);
  const r0 = await p;
  status(r0, 'needs_text', 'task');
  await scriptSet([{ operation: 'DONE' }]);
  const c = await cont({ task: r0.task, text: 'Geneva' });
  status(c, 'done', 'continue');
  eq(await ev(`document.querySelector('#field').value`), 'Geneva', 'typed');
});

test('decider: confirmation is not reused after the model moves on', async () => {
  await scriptSet([{ operation: 'CLICK', target: 'Continue' }, { noul: 0.9 }]);
  const r = await task({ goal: 'Press Continue', url: url('guards.html') });
  status(r, 'needs_confirmation', 'task');
  await js(`document.querySelector('#context').textContent = 'Cart total: $20'`);
  await scriptSet([{ operation: 'CLICK', target: 'Refundable' }, { operation: 'CLICK', target: 'Continue' }, { noul: 0.9 }]);
  const c = await cont({ task: r.task, confirm: true });
  status(c, 'needs_confirmation', 'continue');
  eq(await clicks(), 0, 'Continue not clicked on the stale confirmation');
  eq(await ev(`document.querySelector('#toggle').checked`), true, 'Refundable ticked');
  eq(asks(await reqs(), 'irreversible').length, 1, 'asked again');
});

test('decider: a value with a secret name stays masked after it is typed', async () => {
  await scriptSet([{ operation: 'TYPE_TEXT', target: 'City' }, { value: 'access_token' }, { operation: 'DONE' }]);
  const r = await task({ goal: 'Paste the token', url: url('guards.html'), values: { access_token: 'sk-live-abcdef' }, confirm: false });
  status(r, 'done', 'task');
  eq(await ev(`document.querySelector('#field').value`), 'sk-live-abcdef', 'typed');
  ok(!JSON.stringify(await reqs()).includes('sk-live-abcdef'), 'never sent to the model');
  eq(r.steps[0].text, '***', 'step text masked');
  const tr = await dec('GET', `/task?id=${r.task}`);
  ok(!tr.text.includes('sk-live-abcdef'), 'trace masked');
});

test('decider: supplied values are not auto-filled on another site', async () => {
  await scriptSet([{ operation: 'WAIT', delay_ms: 1500 }, { operation: 'TYPE_TEXT', target: 'City' }]);
  const p = task({ goal: 'Set the city to Bern', url: url('guards.html'), values: { city: 'Bern' }, confirm: false });
  await until(async () => (await reqs()).length >= 1, 15000, 'first model request');
  await runOk(`await goto('http://shop.other.test:8000/fixtures/guards.html')`);
  const r = await p;
  status(r, 'needs_text', 'task');
  ok(/not on mock/.test(r.pending?.note || ''), `pending note ${show(r.pending)}`);
  eq(asks(await reqs(), 'value').length, 0, 'no value question on the other site');
  eq(await ev(`document.querySelector('#field').value`), 'Zurich', 'nothing typed');
});

test('decider: hotel task end to end', async () => {
  await scriptSet([
    { operation: 'TYPE_TEXT', target: 'Destination' },
    { value: 'destination' },
    { operation: 'CLICK', target: 'Find stays' },
    { noul: 0.05 },
    { operation: 'SELECT', target: 'Design' },
    { operation: 'CLICK', target: 'Free cancellation' },
    { operation: 'CLICK', target: 'Casa Flora' },
    { noul: 0.05 },
    { operation: 'DONE' },
  ]);
  const r = await task({
    goal: 'Find a Design stay in Lisbon with free cancellation and open Casa Flora',
    url: url('hotel.html'),
    values: { destination: 'Lisbon' },
  });
  status(r, 'done', 'task');
  eq(await ev('window.hotel'), { query: 'Lisbon', category: 'Design', free: true, searched: true, opened: 'Casa Flora' }, 'applied state');
  ok(/Casa Flora/.test(r.final?.title || ''), `final title ${show(r.final)}`);
  ok(/Free cancellation enabled/.test(r.final?.text || ''), 'final text shows filters');
  eq(r.steps.length, 5, 'five actions');
  ok(r.steps.every(s => s.changed), `every step changed the page: ${show(r.steps)}`);
  ok(r.stats.actions === 5 && r.stats.decisions >= 6, `stats ${show(r.stats)}`);
  const n = await notes();
  eq(n.notes, [], 'mock consumed the script as written');
});

// ── runner ───────────────────────────────────────────────────────────
async function waitHealthy(name, u, headers = {}, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await request('GET', `${u}/health`, undefined, headers, 3000);
      if (r.status === 200) return;
    } catch {}
    if (Date.now() > end) throw new Error(`${name} not healthy at ${u}`);
    await sleep(500);
  }
}

async function main() {
  const only = process.argv.slice(2);
  await Promise.all([waitHealthy('browser', B), waitHealthy('decider', D, DH), waitHealthy('mock', M)]);
  const chosen = only.length ? cases.filter(c => only.some(o => c.name.includes(o))) : cases;
  let pass = 0;
  const failed = [];
  for (const c of chosen) {
    const t0 = Date.now();
    try {
      await Promise.race([c.fn(), sleep(CASE_MS).then(() => { throw new Fail(`case timeout ${CASE_MS}ms`); })]);
      pass++;
      console.log(`PASS ${c.name} (${Date.now() - t0}ms)`);
    } catch (e) {
      failed.push(c.name);
      console.log(`FAIL ${c.name} (${Date.now() - t0}ms): ${e instanceof Fail ? e.message : e?.stack || e}`);
      if (c.name.startsWith('decider')) {
        const n = await notes().catch(() => null);
        if (n?.notes?.length) console.log(`     mock notes: ${show(n.notes)}`);
      }
    }
  }
  console.log(`\n${pass}/${chosen.length} passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.log(`FAIL setup: ${e?.stack || e}`); process.exit(1); });
