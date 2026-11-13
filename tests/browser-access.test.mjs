import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createBrowserAccess, readBrowserAccessConfig } from '../dist/browser-access.js';
import { createHandlers } from '../dist/server.js';
import { loadSyntheticProvider } from '../dist/providers/synthetic.js';

const origin = 'https://mobile-test.example.invalid';
const host = new URL(origin).host;
const passcode = randomBytes(32).toString('base64url');
const config = { origin, passcode };
const localHosts = new Set(['localhost:3000', '127.0.0.1:3000']);
const remote = { host, origin, 'sec-fetch-site': 'same-origin' };

async function request(handler, path, { method = 'GET', headers = {}, body = '' } = {}) {
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    method, url: path, headers: { host: 'localhost:3000', ...headers },
  });
  const res = Object.assign(new EventEmitter(), {
    status: 0, headers: {}, destroyed: false, writableEnded: false, writableFinished: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    writeHead(status, values = {}) { this.status = status; for (const [key, value] of Object.entries(values)) this.setHeader(key, value); },
    end(value = '') { this.body = String(value); this.writableEnded = this.writableFinished = true; this.emit('finish'); },
  });
  const finished = once(res, 'finish');
  await handler(req, res);
  await finished;
  return res;
}
function gateHandler(gate) {
  return async (req, res) => {
    const access = await gate(req, res, localHosts);
    if (!access.handled) { res.writeHead(200); res.end('allowed'); }
  };
}
const login = (handler, value = passcode, headers = {}) => request(handler, '/mobile/login', {
  method: 'POST', headers: { ...remote, 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ passcode: value }).toString(),
});
const cookieOf = response => response.headers['set-cookie'].split(';')[0];

test('mobile mode is opt-in and strictly validates an exact canonical HTTPS origin and strong passcode', () => {
  assert.equal(readBrowserAccessConfig({}), undefined);
  assert.equal(readBrowserAccessConfig({ MOBILE_BROWSER_ORIGIN: '', MOBILE_BROWSER_PASSCODE: '' }), undefined);
  assert.deepEqual(readBrowserAccessConfig({ MOBILE_BROWSER_ORIGIN: origin, MOBILE_BROWSER_PASSCODE: passcode }), config);
  for (const invalid of [undefined, 'http://mobile-test.example.invalid', origin + '/', origin + '/path', origin + '?x=1', origin + '#x', 'https://*.example.invalid', 'https://user:password@mobile-test.example.invalid', 'https://mobile-test.example.invalid:443', 'https://MOBILE-test.example.invalid', origin + '\n', 'https://mobile-test.example.invalid\\evil']) {
    assert.throws(() => readBrowserAccessConfig({ MOBILE_BROWSER_ORIGIN: invalid, MOBILE_BROWSER_PASSCODE: passcode }), /exact HTTPS origin/);
  }
  for (const invalid of [undefined, '', 'short', 'x'.repeat(129), ' '.repeat(43)]) {
    assert.throws(() => readBrowserAccessConfig({ MOBILE_BROWSER_ORIGIN: origin, MOBILE_BROWSER_PASSCODE: invalid }), /generated passcode/);
  }
});

test('default mode allows localhost only and retains proxy rejection', async () => {
  const handler = gateHandler(createBrowserAccess());
  for (const host of localHosts) assert.equal((await request(handler, '/', { headers: { host } })).status, 200);
  for (const headers of [remote, { host: 'evil.invalid' }, { host: undefined }, { 'x-forwarded-host': host }, { forwarded: `host=${host};proto=https` }]) {
    const res = await request(handler, '/', { headers });
    assert.equal(res.status, 403);
    assert.match(res.body, /Open the app on localhost/);
  }
});

test('remote HTML, bundle, setup and controls require authentication; secrets never appear in login HTML', async () => {
  const handler = gateHandler(createBrowserAccess(config));
  for (const path of ['/', '/browser.js', '/api/info', '/api/start', '/api/stop']) {
    const res = await request(handler, path, { headers: remote, method: path.includes('start') || path.includes('stop') ? 'POST' : 'GET' });
    assert.equal(res.status, 401);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(!res.body.includes(passcode));
    if (path === '/') {
      assert.match(res.body, /type="password"/);
      assert.match(res.headers['content-security-policy'], /form-action 'self'/);
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.equal(res.headers['referrer-policy'], 'same-origin');
    }
  }
});

test('login sets an opaque Secure HttpOnly SameSite cookie, supports remote access and logout', async () => {
  const handler = gateHandler(createBrowserAccess(config));
  const response = await login(handler);
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/');
  const setCookie = response.headers['set-cookie'];
  assert.match(setCookie, /^__Host-health-mobile=/);
  for (const attr of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=3600']) assert.ok(setCookie.includes(attr));
  assert.ok(!setCookie.includes(passcode));
  const cookie = cookieOf(response);
  for (const path of ['/', '/browser.js', '/api/info']) assert.equal((await request(handler, path, { headers: { ...remote, cookie } })).status, 200);
  for (const supplied of ['__Host-health-mobile=forged', cookie + '; ' + cookie]) {
    assert.equal((await request(handler, '/api/info', { headers: { ...remote, cookie: supplied } })).status, 401);
  }
  const logout = await request(handler, '/mobile/logout', { method: 'POST', headers: { ...remote, cookie } });
  assert.equal(logout.status, 303);
  assert.match(logout.headers['set-cookie'], /Max-Age=0/);
  assert.equal((await request(handler, '/api/info', { headers: { ...remote, cookie } })).status, 401);
});

test('authentication expires server-side after one hour and restart invalidates cookies', async () => {
  let time = 1000;
  const handler = gateHandler(createBrowserAccess(config, () => time));
  const cookie = cookieOf(await login(handler));
  time += 3600000;
  assert.equal((await request(handler, '/api/info', { headers: { ...remote, cookie } })).status, 401);
  const freshCookie = cookieOf(await login(handler));
  const restarted = gateHandler(createBrowserAccess(config));
  assert.equal((await request(restarted, '/api/info', { headers: { ...remote, cookie: freshCookie } })).status, 401);
});

test('failed login is bounded, does not echo secrets, and rate limits repeated guesses', async () => {
  let time = 1000;
  const handler = gateHandler(createBrowserAccess(config, () => time));
  for (let i = 0; i < 5; i++) {
    const res = await login(handler, 'wrong');
    assert.equal(res.status, 401);
    assert.ok(!res.body.includes('wrong'));
    assert.equal(res.headers['set-cookie'], undefined);
  }
  assert.equal((await login(handler)).status, 429);
  time += 60000;
  assert.equal((await login(handler)).status, 303);
  assert.equal((await login(handler, passcode, { 'content-type': 'application/json' })).status, 415);
  assert.equal((await login(handler, 'x'.repeat(1100))).status, 413);
  const duplicate = await request(handler, '/mobile/login', { method: 'POST', headers: { ...remote, 'content-type': 'application/x-www-form-urlencoded' }, body: `passcode=${passcode}&passcode=${passcode}` });
  assert.equal(duplicate.status, 401);
});

test('approved proxy host/protocol are allowed; conflicting, multi-valued and unapproved headers are rejected', async () => {
  const handler = gateHandler(createBrowserAccess(config));
  const cookie = cookieOf(await login(handler));
  assert.equal((await request(handler, '/', { headers: { ...remote, cookie, 'x-forwarded-host': host, 'x-forwarded-proto': 'https' } })).status, 200);
  for (const headers of [
    { host: 'other.example.invalid' }, { host: host + ':443' },
    { 'x-forwarded-host': 'evil.invalid' }, { 'x-forwarded-host': host + ', evil.invalid' },
    { 'x-forwarded-host': [host] }, { forwarded: `host=${host};proto=https` },
    { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'https,http' },
    { host: 'localhost:3000', 'x-forwarded-host': host },
    { host: 'localhost:3000', 'x-forwarded-proto': 'https' },
  ]) assert.equal((await request(handler, '/', { headers: { ...remote, cookie, ...headers } })).status, 403);
});

test('login and authenticated mutations reject missing, null, conflicting and cross-site origins', async () => {
  const handler = gateHandler(createBrowserAccess(config));
  const cookie = cookieOf(await login(handler));
  for (const headers of [{ origin: undefined }, { origin: 'null' }, { origin: 'http://' + host }, { origin: 'https://evil.invalid' }, { origin: origin + '/' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await login(handler, passcode, headers)).status, 403);
    if (headers.origin !== undefined && headers.origin !== origin) assert.equal((await request(handler, '/api/info', { headers: { ...remote, cookie, ...headers } })).status, 403);
    for (const path of ['/api/start', '/api/stop', '/mobile/logout']) {
      assert.equal((await request(handler, path, { method: 'POST', headers: { ...remote, cookie, ...headers } })).status, 403);
    }
  }
});

test('full server preserves local controls, authenticated remote Start/Stop, callback authentication and isolation', async () => {
  const source = await loadSyntheticProvider();
  let bearer;
  let stops = 0;
  const app = createHandlers({ ...source, browserAccess: config, timeZone: 'UTC', localPort: 3000, html: Buffer.from('demo html'), script: Buffer.from('demo script'), gateway: {
    async start(session) { bearer = session.callbackBearer; return { agentId: 'agent', rtc: { uid: 1, agentUid: 2, appId: 'mock', token: 'mock', channel: 'mock' } }; },
    async stop() { stops++; }, async find() {},
  } });
  try {
    const cookie = cookieOf(await login(app.local));
    const setup = await request(app.local, '/api/info', { headers: { ...remote, cookie } });
    assert.equal(setup.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(setup.body)).sort(), ['demoDate', 'synthetic', 'voiceConfigured', 'voiceMode']);
    assert.equal((await request(app.local, '/', { headers: { ...remote, cookie } })).body, 'demo html');
    for (const headers of [remote, { host: 'localhost:3000', origin: 'http://localhost:3000' }]) {
      const id = randomUUID();
      const options = { method: 'POST', body: JSON.stringify({ id }), headers: { ...headers, cookie, 'content-type': 'application/json' } };
      assert.equal((await request(app.local, '/api/start', options)).status, 200);
      assert.equal((await request(app.callbacks, '/', { headers })).status, 404);
      assert.equal((await request(app.callbacks, '/mobile/login', { ...options, body: '' })).status, 404);
      assert.equal((await request(app.callbacks, '/api/start', options)).status, 404);
      const tool = { method: 'POST', body: JSON.stringify({ date: 'yesterday' }), headers: { ...headers, cookie, 'content-type': 'application/json' } };
      assert.equal((await request(app.local, '/tools/movement', tool)).status, 404);
      assert.equal((await request(app.callbacks, '/tools/movement', tool)).status, 401);
      tool.headers.authorization = `Bearer ${bearer}`;
      assert.equal((await request(app.callbacks, '/tools/movement', tool)).status, 200);
      assert.equal((await request(app.local, '/api/stop', options)).status, 200);
      assert.equal((await request(app.callbacks, '/tools/movement', tool)).status, 401);
    }
    assert.equal(stops, 2);
    const info = await request(app.local, '/api/info', { headers: remote });
    assert.equal(info.status, 401);
  } finally { await app.shutdown(); }
});
